/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeGenerationController, CodeGenerationEditorContext, CodeGenerationToolResult, captureCodeGenerationEditorContext } from './codeGeneration';
import { CodeGenerationProgress } from './codeGenerationProtocol';
import { ConversationContext } from './conversationContext';
import { BackgroundJobAction, BackgroundJobStatus, BackgroundJobToolResult, BackgroundJobView, describeBackgroundJob, normalizeBackgroundJobLabel, resolveBackgroundJobReference, spokenBackgroundJobLabel, summarizeBackgroundJobs } from './backgroundJobsProtocol';

const MAX_CONCURRENT_JOBS = 2;
const MAX_QUEUED_JOBS = 5;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

interface BackgroundJob {
	readonly id: string;
	readonly label: string;
	readonly request: string;
	readonly createdAt: number;
	readonly repositoryRoot: string;
	readonly workspaceRelativePath: string;
	readonly editorContext: CodeGenerationEditorContext;
	readonly conversation?: ConversationContext;
	readonly storageUri: vscode.Uri;
	status: BackgroundJobStatus;
	progress?: string;
	completedAt?: number;
	baseCommit?: string;
	worktreePath?: string;
	patch?: string;
	changedFiles: string[];
	result?: CodeGenerationToolResult;
	error?: string;
	abortController?: AbortController;
	cancelRequested: boolean;
	discardRequested: boolean;
}

interface GitResult {
	readonly stdout: string;
	readonly stderr: string;
}

interface GitError extends Error {
	readonly code?: number | string;
	readonly stdout?: string;
	readonly stderr?: string;
}

class BackgroundJobInteractionError extends Error { }

export class BackgroundJobManager implements vscode.Disposable {
	private readonly jobs = new Map<string, BackgroundJob>();
	private readonly changeEmitter = new vscode.EventEmitter<BackgroundJobView>();
	private sequence = 0;
	private activeJobs = 0;
	private disposed = false;
	private lastReferencedJobId: string | undefined;

	readonly onDidChange = this.changeEmitter.event;

	constructor(
		private readonly storageRoot: vscode.Uri,
		private readonly codeGeneration: CodeGenerationController,
		private readonly trace: (message: string) => void,
	) { }

	dispose(): void {
		this.disposed = true;
		this.changeEmitter.dispose();
		for (const job of this.jobs.values()) {
			job.abortController?.abort();
			void this.removeWorktree(job);
		}
	}

	async start(request: string, requestedLabel: string | undefined, conversation?: ConversationContext): Promise<BackgroundJobToolResult> {
		try {
			const workspaceRoot = currentWorkspaceRoot();
			if (!workspaceRoot) {
				throw new Error('Open a workspace before starting a background job.');
			}
			const repositoryRoot = (await runGit(['rev-parse', '--show-toplevel'], workspaceRoot.fsPath)).stdout.trim();
			const workspaceRelativePath = normalizeRelativePath(path.relative(repositoryRoot, workspaceRoot.fsPath));
			if (workspaceRelativePath.startsWith('..')) {
				throw new Error('The opened workspace is not inside its Git repository.');
			}
			const dirty = (await runGit(['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot)).stdout.trim();
			if (dirty) {
				throw new Error('Commit or stash the current workspace changes before starting a background job.');
			}
			const queued = [...this.jobs.values()].filter(job => job.status === 'queued').length;
			if (this.activeJobs >= MAX_CONCURRENT_JOBS && queued >= MAX_QUEUED_JOBS) {
				throw new Error(`The background queue is full (${MAX_CONCURRENT_JOBS} running and ${MAX_QUEUED_JOBS} queued).`);
			}

			const id = `job-${++this.sequence}`;
			const fallbackLabel = normalizeBackgroundJobLabel(request) || `background-${this.sequence}`;
			const label = this.uniqueLabel(normalizeBackgroundJobLabel(requestedLabel || fallbackLabel) || fallbackLabel);
			const job: BackgroundJob = {
				id,
				label,
				request,
				createdAt: Date.now(),
				repositoryRoot,
				workspaceRelativePath,
				editorContext: captureCodeGenerationEditorContext(workspaceRoot),
				conversation,
				storageUri: vscode.Uri.joinPath(this.storageRoot, 'background-jobs', id),
				status: 'queued',
				progress: 'Waiting to start…',
				changedFiles: [],
				cancelRequested: false,
				discardRequested: false,
			};
			this.jobs.set(id, job);
			this.lastReferencedJobId = id;
			this.emit(job);
			this.drainQueue();
			return {
				ok: true,
				job: this.view(job),
				spoken_response: `Got it. I'll handle ${spokenBackgroundJobLabel(label)} in the background.`,
				display_response: `${label} is queued as ${id}. You can continue working while it runs.`,
			};
		} catch (error) {
			return failure('I could not start that background job.', error);
		}
	}

	async control(action: BackgroundJobAction, query?: string, fileQuery?: string): Promise<BackgroundJobToolResult> {
		try {
			if (action === 'list') {
				return this.list();
			}
			const job = this.resolveJob(action, query);
			this.lastReferencedJobId = job.id;
			switch (action) {
				case 'inspect':
					return this.inspect(job);
				case 'show_diff':
					return await this.showDiff(job, fileQuery);
				case 'apply':
					return await this.apply(job);
				case 'cancel':
					return await this.cancel(job);
				case 'discard':
					return await this.discard(job);
			}
		} catch (error) {
			return failure(
				error instanceof BackgroundJobInteractionError ? error.message : 'I could not complete that background job action.',
				error,
			);
		}
	}

	listViews(): readonly BackgroundJobView[] {
		return [...this.jobs.values()]
			.sort((left, right) => right.createdAt - left.createdAt)
			.map(job => this.view(job));
	}

	private drainQueue(): void {
		if (this.disposed) {
			return;
		}
		while (this.activeJobs < MAX_CONCURRENT_JOBS) {
			const next = [...this.jobs.values()].find(job => job.status === 'queued');
			if (!next) {
				return;
			}
			this.activeJobs += 1;
			next.status = 'preparing';
			next.progress = 'Creating an isolated worktree…';
			this.emit(next);
			void this.run(next).finally(() => {
				this.activeJobs -= 1;
				this.drainQueue();
			});
		}
	}

	private async run(job: BackgroundJob): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(job.storageUri);
			job.baseCommit = (await runGit(['rev-parse', 'HEAD'], job.repositoryRoot)).stdout.trim();
			job.worktreePath = vscode.Uri.joinPath(job.storageUri, 'worktree').fsPath;
			await runGit(['worktree', 'add', '--detach', job.worktreePath, job.baseCommit], job.repositoryRoot);
			if (job.discardRequested || job.cancelRequested) {
				job.status = job.discardRequested ? 'discarded' : 'cancelled';
				job.completedAt = Date.now();
				job.progress = job.discardRequested ? 'Discarded.' : 'Cancelled.';
				return;
			}

			job.status = 'running';
			job.progress = 'Inspecting the isolated workspace…';
			job.abortController = new AbortController();
			this.emit(job);
			const jobWorkspacePath = job.workspaceRelativePath
				? path.join(job.worktreePath, job.workspaceRelativePath)
				: job.worktreePath;
			job.result = await this.codeGeneration.implementInWorkspace(
				job.request,
				vscode.Uri.file(jobWorkspacePath),
				job.editorContext,
				progress => this.reportProgress(job, progress),
				job.conversation,
				job.abortController,
			);

			await runGit(['add', '-N', '--all'], job.worktreePath);
			job.patch = (await runGit(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], job.worktreePath)).stdout;
			job.changedFiles = splitLines((await runGit(['diff', '--name-only', 'HEAD', '--'], job.worktreePath)).stdout);
			job.completedAt = Date.now();
			if (job.discardRequested) {
				job.status = 'discarded';
			} else if (job.cancelRequested || job.abortController.signal.aborted) {
				job.status = 'cancelled';
			} else if (job.result.ok) {
				job.status = 'completed';
				job.progress = job.changedFiles.length > 0
					? `Changed ${job.changedFiles.length} file${job.changedFiles.length === 1 ? '' : 's'}.`
					: 'Finished without workspace changes.';
			} else {
				job.status = 'failed';
				job.error = job.result.error;
				job.progress = job.result.spoken_response;
			}
			this.trace(`background-job.finish id=${job.id} status=${job.status} files=${job.changedFiles.join(',') || 'none'}`);
		} catch (error) {
			job.completedAt = Date.now();
			job.status = job.discardRequested ? 'discarded' : job.cancelRequested || job.abortController?.signal.aborted ? 'cancelled' : 'failed';
			job.error = errorMessage(error);
			job.progress = job.error;
			this.trace(`background-job.error id=${job.id} error=${job.error}`);
		} finally {
			job.abortController = undefined;
			this.emit(job);
			if (job.status === 'discarded' || job.status === 'cancelled') {
				await this.removeWorktree(job);
			}
		}
	}

	private reportProgress(job: BackgroundJob, progress: CodeGenerationProgress): void {
		if (job.status !== 'running') {
			return;
		}
		let nextProgress: string | undefined;
		if (progress.kind === 'tool') {
			nextProgress = progress.text;
		} else if (progress.kind === 'code' && progress.file) {
			nextProgress = `Writing ${progress.file}…`;
		}
		if (!nextProgress || nextProgress === job.progress) {
			return;
		}
		job.progress = nextProgress;
		this.emit(job);
	}

	private list(): BackgroundJobToolResult {
		const jobs = this.listViews();
		return {
			ok: true,
			jobs,
			spoken_response: summarizeBackgroundJobs(jobs),
			display_response: jobs.length === 0
				? 'No background jobs.'
				: jobs.map(job => `${job.label} (${job.id}): ${job.status}`).join('\n'),
		};
	}

	private inspect(job: BackgroundJob): BackgroundJobToolResult {
		return {
			ok: true,
			job: this.view(job),
			spoken_response: describeBackgroundJob(this.view(job)),
			display_response: job.result?.display_response || job.progress || `${job.label} is ${job.status}.`,
		};
	}

	private async showDiff(job: BackgroundJob, fileQuery?: string): Promise<BackgroundJobToolResult> {
		this.requireCompleted(job, 'show');
		if (!job.baseCommit || !job.worktreePath || job.changedFiles.length === 0) {
			throw new Error(`${job.label} has no changed files to show.`);
		}
		const file = selectChangedFile(job, fileQuery);
		const baseUri = vscode.Uri.joinPath(job.storageUri, 'diff', 'base', ...file.split('/'));
		const resultUri = vscode.Uri.joinPath(job.storageUri, 'diff', 'result', ...file.split('/'));
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(baseUri.fsPath)));
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resultUri.fsPath)));
		const base = await gitFileAt(job.repositoryRoot, job.baseCommit, file);
		const result = await readFileOrEmpty(vscode.Uri.file(path.join(job.worktreePath, file)));
		await vscode.workspace.fs.writeFile(baseUri, base);
		await vscode.workspace.fs.writeFile(resultUri, result);
		await vscode.commands.executeCommand('vscode.diff', baseUri, resultUri, `${job.label} — ${file}`, { preview: false });
		return {
			ok: true,
			job: this.view(job),
			file,
			spoken_response: `Here's the diff for ${spokenBackgroundJobLabel(job.label)}.`,
		};
	}

	private async apply(job: BackgroundJob): Promise<BackgroundJobToolResult> {
		this.requireCompleted(job, 'apply');
		if (!job.baseCommit || job.patch === undefined) {
			throw new Error(`${job.label} has no completed patch.`);
		}
		if (!job.patch.trim()) {
			job.status = 'applied';
			job.completedAt = Date.now();
			this.emit(job);
			await this.removeWorktree(job);
			return { ok: true, job: this.view(job), spoken_response: `${spokenBackgroundJobLabel(job.label)} finished without making any changes.` };
		}

		const conflicts: string[] = [];
		for (const file of job.changedFiles) {
			if (!await this.matchesBaseline(job, file)) {
				conflicts.push(file);
			}
		}
		if (conflicts.length > 0) {
			throw new Error(`The workspace changed in ${conflicts.join(', ')} after ${job.label} started. Review the diff before applying.`);
		}

		const patchUri = vscode.Uri.joinPath(job.storageUri, 'result.patch');
		await vscode.workspace.fs.writeFile(patchUri, Buffer.from(job.patch));
		await runGit(['apply', '--check', '--whitespace=nowarn', patchUri.fsPath], job.repositoryRoot);
		await runGit(['apply', '--whitespace=nowarn', patchUri.fsPath], job.repositoryRoot);
		job.status = 'applied';
		job.completedAt = Date.now();
		job.progress = `Applied ${job.changedFiles.length} file${job.changedFiles.length === 1 ? '' : 's'} to the workspace.`;
		this.emit(job);
		await this.removeWorktree(job);
		return {
			ok: true,
			job: this.view(job),
			spoken_response: `Done. I brought ${spokenBackgroundJobLabel(job.label)} into your workspace.`,
			display_response: job.progress,
		};
	}

	private async cancel(job: BackgroundJob): Promise<BackgroundJobToolResult> {
		if (job.status === 'queued') {
			job.status = 'cancelled';
			job.completedAt = Date.now();
			job.progress = 'Cancelled before starting.';
			this.emit(job);
		} else if (job.status === 'preparing' || job.status === 'running') {
			job.cancelRequested = true;
			job.abortController?.abort();
			job.progress = 'Cancelling…';
			this.emit(job);
		} else {
			return { ok: true, job: this.view(job), spoken_response: describeBackgroundJob(this.view(job)) };
		}
		return { ok: true, job: this.view(job), spoken_response: `Okay. I stopped ${spokenBackgroundJobLabel(job.label)}.` };
	}

	private async discard(job: BackgroundJob): Promise<BackgroundJobToolResult> {
		job.discardRequested = true;
		job.abortController?.abort();
		if (job.status !== 'preparing' && job.status !== 'running') {
			job.status = 'discarded';
			job.completedAt = Date.now();
			job.progress = 'Discarded.';
			this.emit(job);
			await this.removeWorktree(job);
		}
		return { ok: true, job: this.view(job), spoken_response: `Okay. I discarded ${spokenBackgroundJobLabel(job.label)}.` };
	}

	private async matchesBaseline(job: BackgroundJob, file: string): Promise<boolean> {
		if (!job.baseCommit) {
			return false;
		}
		const existedAtBaseline = await gitObjectExists(job.repositoryRoot, `${job.baseCommit}:${file}`);
		const currentUri = vscode.Uri.file(path.join(job.repositoryRoot, file));
		const existsNow = await fileExists(currentUri);
		if (!existedAtBaseline) {
			return !existsNow;
		}
		try {
			await runGit(['diff', '--quiet', job.baseCommit, '--', file], job.repositoryRoot);
			return true;
		} catch {
			return false;
		}
	}

	private requireCompleted(job: BackgroundJob, action: 'show' | 'apply'): void {
		if (job.status !== 'completed') {
			const status = describeBackgroundJob(this.view(job));
			throw new BackgroundJobInteractionError(action === 'apply'
				? `${status} It isn't ready to bring in yet.`
				: `${status} There isn't a finished diff to show yet.`);
		}
	}

	private resolveJob(action: BackgroundJobAction, query?: string): BackgroundJob {
		const jobs = [...this.jobs.values()];
		const resolution = resolveBackgroundJobReference(
			jobs.map(job => this.view(job)),
			query,
			this.lastReferencedJobId,
			preferredStatuses(action),
		);
		if (resolution.kind === 'resolved') {
			return this.jobs.get(resolution.job.id)!;
		}
		if (resolution.kind === 'ambiguous') {
			throw new BackgroundJobInteractionError(`Did you mean ${humanJoin(resolution.candidates.map(candidate => spokenBackgroundJobLabel(candidate.label)))}?`);
		}
		if (jobs.length === 0) {
			throw new BackgroundJobInteractionError("I don't have any background jobs yet.");
		}
		if (!query && (action === 'apply' || action === 'show_diff')) {
			throw new BackgroundJobInteractionError('Nothing is ready to review yet.');
		}
		if (!query && action === 'cancel') {
			throw new BackgroundJobInteractionError('Nothing is running in the background right now.');
		}
		throw new BackgroundJobInteractionError(`I couldn't tell which background job you meant. I have ${humanJoin(jobs.map(job => spokenBackgroundJobLabel(job.label)))}.`);
	}

	private uniqueLabel(candidate: string): string {
		if (![...this.jobs.values()].some(job => job.label === candidate)) {
			return candidate;
		}
		let occurrence = 2;
		while (true) {
			const suffix = `-${occurrence}`;
			const label = `${candidate.slice(0, 48 - suffix.length)}${suffix}`;
			if (![...this.jobs.values()].some(job => job.label === label)) {
				return label;
			}
			occurrence += 1;
		}
	}

	private view(job: BackgroundJob): BackgroundJobView {
		return {
			id: job.id,
			label: job.label,
			request: job.request,
			status: job.status,
			progress: job.progress,
			changed_files: [...job.changedFiles],
			created_at: job.createdAt,
			completed_at: job.completedAt,
		};
	}

	private emit(job: BackgroundJob): void {
		if (!this.disposed) {
			this.changeEmitter.fire(this.view(job));
		}
	}

	private async removeWorktree(job: BackgroundJob): Promise<void> {
		if (!job.worktreePath) {
			return;
		}
		const worktreePath = job.worktreePath;
		job.worktreePath = undefined;
		try {
			await runGit(['worktree', 'remove', '--force', worktreePath], job.repositoryRoot);
			await runGit(['worktree', 'prune'], job.repositoryRoot);
		} catch (error) {
			this.trace(`background-job.cleanup_error id=${job.id} error=${errorMessage(error)}`);
		}
	}
}

function currentWorkspaceRoot(): vscode.Uri | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri : undefined)
		?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function selectChangedFile(job: BackgroundJob, query?: string): string {
	if (!query) {
		const primary = job.result?.primary_file;
		if (primary) {
			const repositoryPrimary = job.workspaceRelativePath
				? path.posix.join(job.workspaceRelativePath.split(path.sep).join('/'), primary)
				: primary;
			if (job.changedFiles.includes(repositoryPrimary)) {
				return repositoryPrimary;
			}
		}
		return job.changedFiles[0];
	}
	const normalized = query.trim().toLowerCase().replace(/\\/g, '/');
	const exact = job.changedFiles.find(file => file.toLowerCase() === normalized || file.toLowerCase().endsWith(`/${normalized}`));
	const partial = exact ?? job.changedFiles.find(file => file.toLowerCase().includes(normalized));
	if (!partial) {
		throw new Error(`${job.label} did not change a file matching ${query}.`);
	}
	return partial;
}

async function gitFileAt(repositoryRoot: string, commit: string, file: string): Promise<Uint8Array> {
	try {
		return Buffer.from((await runGit(['show', `${commit}:${file}`], repositoryRoot)).stdout);
	} catch {
		return new Uint8Array();
	}
}

async function gitObjectExists(repositoryRoot: string, object: string): Promise<boolean> {
	try {
		await runGit(['cat-file', '-e', object], repositoryRoot);
		return true;
	} catch {
		return false;
	}
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function readFileOrEmpty(uri: vscode.Uri): Promise<Uint8Array> {
	try {
		return await vscode.workspace.fs.readFile(uri);
	} catch {
		return new Uint8Array();
	}
}

function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		execFile('git', [...args], { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
			if (error) {
				const gitError = error as GitError;
				Object.assign(gitError, { stdout, stderr });
				reject(gitError);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function normalizeRelativePath(value: string): string {
	return value === '.' ? '' : value.split(path.sep).join('/');
}

function splitLines(value: string): string[] {
	return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function preferredStatuses(action: BackgroundJobAction): readonly BackgroundJobStatus[] {
	switch (action) {
		case 'apply':
		case 'show_diff':
			return ['completed'];
		case 'cancel':
			return ['queued', 'preparing', 'running'];
		default:
			return [];
	}
}

function humanJoin(values: readonly string[]): string {
	if (values.length <= 1) {
		return values[0] ?? '';
	}
	if (values.length === 2) {
		return `${values[0]} or ${values[1]}`;
	}
	return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		const gitError = error as GitError;
		return gitError.stderr?.trim() || gitError.message;
	}
	return String(error);
}

function failure(spokenResponse: string, error: unknown): BackgroundJobToolResult {
	return {
		ok: false,
		spoken_response: spokenResponse,
		display_response: spokenResponse,
		error: errorMessage(error),
	};
}
