/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QueryCache, queryCacheKey } from './queryCache';
import { chunkWorkspaceFile, rankWorkspaceIndexChunks, WorkspaceIndexChunk } from './workspaceIndexRanking';

export interface WorkspaceIndexResult {
	readonly version: number;
	readonly chunks: readonly WorkspaceIndexChunk[];
}

interface IndexedFile {
	readonly uri: vscode.Uri;
	readonly path: string;
	readonly chunks: readonly WorkspaceIndexChunk[];
}

const SOURCE_FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,py,go,java,rs,rb,php,cs,swift,kt,sql,html,css,scss,less,vue,svelte}';
const EXCLUDED_FILE_GLOB = '**/{.git,node_modules,out,dist,build,.build,.vscode-test,coverage}/**';
const INDEXED_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'py', 'go', 'java', 'rs', 'rb', 'php', 'cs', 'swift', 'kt', 'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte']);
const MAXIMUM_INDEXED_FILES = 4_000;
const MAXIMUM_FILE_BYTES = 256 * 1024;
const INDEX_READ_CONCURRENCY = 16;
const INDEX_QUERY_CACHE_ENTRIES = 96;
const INDEX_QUERY_CACHE_TTL_MS = 10 * 60_000;

/**
 * Maintains a local, source-range index for the open workspace. It deliberately keeps raw code
 * only in the extension host and updates its generation whenever an indexed file changes.
 */
export class WorkspaceCodeIndex implements vscode.Disposable {
	private readonly files = new Map<string, IndexedFile>();
	private readonly queryCache = new QueryCache<WorkspaceIndexResult>(INDEX_QUERY_CACHE_ENTRIES, INDEX_QUERY_CACHE_TTL_MS);
	private readonly disposables: vscode.Disposable[] = [];
	private buildPromise: Promise<void> | undefined;
	private initialized = false;
	private indexVersion = 0;

	constructor(private readonly trace: (message: string) => void) {
		const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_FILE_GLOB, false, false, false);
		this.disposables.push(
			watcher,
			watcher.onDidCreate(uri => void this.refreshUri(uri)),
			watcher.onDidChange(uri => void this.refreshUri(uri)),
			watcher.onDidDelete(uri => this.removeUri(uri)),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (isIndexableUri(event.document.uri)) {
					this.updateDocument(event.document);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (isIndexableUri(document.uri)) {
					void this.refreshUri(document.uri);
				}
			}),
		);
	}

	async query(request: string, relatedFiles: readonly string[] = []): Promise<WorkspaceIndexResult> {
		await this.ensureIndexed();
		const key = queryCacheKey('workspace-index', {
			version: this.indexVersion,
			request: normalizeRequest(request),
			relatedFiles: [...relatedFiles].map(file => file.replace(/\\/g, '/').toLowerCase()).sort(),
		});
		const cached = this.queryCache.get(key);
		if (cached) {
			this.trace(`index.query.cache.hit version=${this.indexVersion} chunks=${cached.chunks.length}`);
			return cached;
		}

		const chunks = rankWorkspaceIndexChunks(
			[...this.files.values()].flatMap(file => file.chunks),
			request,
			relatedFiles,
		);
		const result = { version: this.indexVersion, chunks };
		this.queryCache.set(key, result);
		this.trace(`index.query version=${this.indexVersion} chunks=${chunks.length}`);
		return result;
	}

	/** Starts the initial index in the background, so the first CDE request is usually warm. */
	warm(): void {
		void this.ensureIndexed().catch(error => {
			this.trace(`index.build.error ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		this.files.clear();
		this.queryCache.clear();
	}

	private async ensureIndexed(): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (!this.buildPromise) {
			this.buildPromise = this.buildIndex().finally(() => {
				this.buildPromise = undefined;
			});
		}
		return this.buildPromise;
	}

	private async buildIndex(): Promise<void> {
		const uris = await vscode.workspace.findFiles(SOURCE_FILE_GLOB, EXCLUDED_FILE_GLOB, MAXIMUM_INDEXED_FILES);
		const indexedFiles = await mapConcurrent(uris, INDEX_READ_CONCURRENCY, async uri => this.readIndexedFile(uri));
		for (const file of indexedFiles) {
			if (file) {
				this.files.set(file.uri.toString(), file);
			}
		}
		this.initialized = true;
		this.bumpVersion();
		this.trace(`index.ready files=${this.files.size} chunks=${this.chunkCount()}${uris.length === MAXIMUM_INDEXED_FILES ? ' capped=true' : ''}`);
	}

	private async refreshUri(uri: vscode.Uri): Promise<void> {
		if (!isIndexableUri(uri)) {
			return;
		}
		const file = await this.readIndexedFile(uri);
		if (!file) {
			return;
		}
		this.files.set(uri.toString(), file);
		if (this.initialized) {
			this.bumpVersion();
		}
	}

	private removeUri(uri: vscode.Uri): void {
		if (this.files.delete(uri.toString()) && this.initialized) {
			this.bumpVersion();
		}
	}

	private updateDocument(document: vscode.TextDocument): void {
		const path = workspaceRelativePath(document.uri);
		if (!path) {
			return;
		}
		this.files.set(document.uri.toString(), {
			uri: document.uri,
			path,
			chunks: chunkWorkspaceFile(path, document.getText()),
		});
		if (this.initialized) {
			this.bumpVersion();
		}
	}

	private async readIndexedFile(uri: vscode.Uri): Promise<IndexedFile | undefined> {
		const path = workspaceRelativePath(uri);
		if (!path) {
			return undefined;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (bytes.byteLength > MAXIMUM_FILE_BYTES || looksBinary(bytes)) {
				return undefined;
			}
			const source = new TextDecoder().decode(bytes);
			return { uri, path, chunks: chunkWorkspaceFile(path, source) };
		} catch (error) {
			this.trace(`index.read.error path=${path} error=${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private bumpVersion(): void {
		this.indexVersion++;
		this.queryCache.clear();
	}

	private chunkCount(): number {
		return [...this.files.values()].reduce((count, file) => count + file.chunks.length, 0);
	}
}

function isIndexableUri(uri: vscode.Uri): boolean {
	const filename = uri.path.split('/').at(-1) ?? '';
	const extension = filename.split('.').at(-1)?.toLowerCase();
	return uri.scheme === 'file'
		&& Boolean(extension && INDEXED_EXTENSIONS.has(extension))
		&& !uri.path.split('/').some(segment => ['.git', 'node_modules', 'out', 'dist', 'build', '.build', '.vscode-test', 'coverage'].includes(segment));
}

function workspaceRelativePath(uri: vscode.Uri): string | undefined {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return undefined;
	}
	const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
	return relative && !relative.startsWith('..') ? relative : undefined;
}

function normalizeRequest(request: string): string {
	return request.trim().replace(/\s+/g, ' ').toLowerCase();
}

function looksBinary(bytes: Uint8Array): boolean {
	for (const byte of bytes.subarray(0, 8_192)) {
		if (byte === 0) {
			return true;
		}
	}
	return false;
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (nextIndex < values.length) {
			const index = nextIndex++;
			results[index] = await worker(values[index]);
		}
	});
	await Promise.all(workers);
	return results;
}
