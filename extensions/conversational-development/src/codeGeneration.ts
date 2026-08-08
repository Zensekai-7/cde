/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { getAnthropicApiKey } from './apiKeys';
import { ConversationContext } from './conversationContext';
import { buildCodeGenerationPrompt, CODE_GENERATION_OUTPUT_SCHEMA, CodeGenerationAnswer, CodeGenerationContext, CodeGenerationProgress, CodeGenerationStreamDecoder, parseCodeGenerationAnswer } from './codeGenerationProtocol';

const CODE_GENERATION_TIMEOUT_MS = 120_000;
const EDIT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const;

export interface CodeGenerationToolResult extends CodeGenerationAnswer {
	readonly ok: boolean;
	readonly error?: string;
}

interface AgentResultSuccess {
	readonly type: 'result';
	readonly subtype: 'success';
	readonly is_error: boolean;
	readonly result: string;
	readonly structured_output?: unknown;
	readonly num_turns: number;
	readonly duration_ms: number;
}

interface AgentResultError {
	readonly type: 'result';
	readonly subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
	readonly is_error: boolean;
	readonly errors: readonly string[];
}

type AgentResult = AgentResultSuccess | AgentResultError;

interface AgentQuery extends AsyncIterable<unknown> {
	close(): void;
}

interface AgentSdk {
	query(parameters: { readonly prompt: string; readonly options: AgentQueryOptions }): AgentQuery;
}

interface AgentQueryOptions {
	readonly abortController: AbortController;
	readonly cwd: string;
	readonly env: { readonly [environmentVariable: string]: string | undefined };
	readonly model: string;
	readonly tools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly permissionMode: 'dontAsk';
	readonly settingSources: readonly string[];
	readonly strictMcpConfig: boolean;
	readonly persistSession: boolean;
	readonly includePartialMessages: boolean;
	readonly maxTurns: number;
	readonly maxBudgetUsd: number;
	readonly effort: 'medium';
	readonly outputFormat: {
		readonly type: 'json_schema';
		readonly schema: typeof CODE_GENERATION_OUTPUT_SCHEMA;
	};
	readonly systemPrompt: string;
}

type NativeImport = (specifier: string) => Promise<AgentSdk>;

const nativeImport = new Function('specifier', 'return import(specifier);') as NativeImport;

export class CodeGenerationController {
	constructor(private readonly trace: (message: string) => void) { }

	async implement(request: string, reportProgress: (progress: CodeGenerationProgress) => void, conversation?: ConversationContext): Promise<CodeGenerationToolResult> {
		const apiKey = getAnthropicApiKey();
		if (!apiKey) {
			return failure('Claude is not configured in this CDE launch.', 'Set cde.anthropicApiKey or ANTHROPIC_API_KEY.');
		}
		if (!vscode.workspace.isTrusted) {
			return failure('Trust this workspace before I make a code change.', 'Workspace trust is required for code generation.');
		}

		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return failure('Open a workspace before asking me to change code.', 'No workspace folder is open.');
		}

		const context = captureEditorContext(workspaceRoot, request, conversation);
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), CODE_GENERATION_TIMEOUT_MS);
		this.trace(`code-generation.start workspace=${workspaceRoot.fsPath} active=${context.activeFile ?? 'none'}`);
		reportProgress({ kind: 'tool', text: 'Starting the code-writing agent…' });

		try {
			const sdk = await loadAgentSdk();
			const queryHandle = sdk.query({
				prompt: buildCodeGenerationPrompt(context),
				options: createQueryOptions(workspaceRoot.fsPath, abortController, apiKey),
			});
			let finalResult: AgentResult | undefined;
			const streamDecoder = new CodeGenerationStreamDecoder();
			try {
				for await (const message of queryHandle) {
					for (const progress of streamDecoder.accept(message)) {
						reportProgress(progress);
					}
					if (isAgentResult(message)) {
						finalResult = message;
					}
				}
			} finally {
				queryHandle.close();
			}

			if (!finalResult) {
				return failure('Claude did not return an implementation result.', 'The Agent SDK stream ended without a result.');
			}
			if (finalResult.subtype !== 'success') {
				const detail = finalResult.errors.join(' ') || finalResult.subtype;
				return failure('Claude could not finish that code change.', detail);
			}
			if (finalResult.is_error) {
				return failure('Claude could not finish that code change.', finalResult.result);
			}

			const answer = parseCodeGenerationAnswer(finalResult.structured_output, finalResult.result);
			if (!answer) {
				return failure('Claude returned an empty implementation result.', 'The result contained no usable response.');
			}
			reportProgress({ kind: 'tool', text: 'Finalizing the code change…' });
			this.trace(`code-generation.success turns=${finalResult.num_turns} duration_ms=${finalResult.duration_ms} files=${answer.changed_files.join(',') || 'none'}`);
			return { ok: true, ...answer };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.trace(`code-generation.error ${message}`);
			if (abortController.signal.aborted) {
				return failure('That code change took too long, so I stopped it.', 'Claude code generation timed out.');
			}
			return failure('I could not make that code change just now.', message);
		} finally {
			clearTimeout(timeout);
		}
	}
}

function createQueryOptions(workspaceRoot: string, abortController: AbortController, apiKey: string): AgentQueryOptions {
	return {
		abortController,
		cwd: workspaceRoot,
		env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
		model: process.env.CDE_CLAUDE_CODE_MODEL?.trim() || 'sonnet',
		tools: [...EDIT_TOOLS],
		allowedTools: [...EDIT_TOOLS],
		permissionMode: 'dontAsk',
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		includePartialMessages: true,
		maxTurns: 10,
		maxBudgetUsd: 1,
		effort: 'medium',
		outputFormat: {
			type: 'json_schema',
			schema: CODE_GENERATION_OUTPUT_SCHEMA,
		},
		systemPrompt: `You are the implementation worker inside a conversational development environment. Make the requested code change directly in the opened workspace. Inspect before editing, make only scoped changes, and preserve repository conventions. You may read, search, edit, and write workspace files, but never run shell commands, browse the web, use MCP tools, modify files outside the workspace, or make unrelated changes. Return an accurate structured summary of the edits you actually made.`,
	};
}

function captureEditorContext(workspaceRoot: vscode.Uri, request: string, conversation: ConversationContext | undefined): CodeGenerationContext {
	const activeEditor = vscode.window.activeTextEditor;
	const activeFile = activeEditor && activeEditor.document.uri.scheme === 'file'
		? relativePath(workspaceRoot.fsPath, activeEditor.document.uri.fsPath)
		: undefined;
	const selection = activeEditor && !activeEditor.selection.isEmpty
		? activeEditor.document.getText(activeEditor.selection)
		: undefined;
	const visibleFiles = vscode.window.visibleTextEditors
		.filter(editor => editor.document.uri.scheme === 'file')
		.map(editor => relativePath(workspaceRoot.fsPath, editor.document.uri.fsPath))
		.filter((file, index, files) => files.indexOf(file) === index);

	return {
		request,
		activeFile,
		activeLine: activeEditor ? activeEditor.selection.active.line + 1 : undefined,
		selection,
		visibleFiles,
		conversation,
	};
}

function getWorkspaceRoot(): vscode.Uri | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri)?.uri : undefined)
		?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function relativePath(root: string, target: string): string {
	const relative = path.relative(root, target);
	return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : target;
}

async function loadAgentSdk(): Promise<AgentSdk> {
	const entrypoint = require.resolve('@anthropic-ai/claude-agent-sdk');
	return nativeImport(pathToFileURL(entrypoint).href);
}

function failure(spokenResponse: string, error: string): CodeGenerationToolResult {
	return {
		ok: false,
		spoken_response: spokenResponse,
		display_response: spokenResponse,
		changed_files: [],
		error,
	};
}

function isAgentResult(value: unknown): value is AgentResult {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'result' && typeof candidate.subtype === 'string';
}
