/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConversationContext, formatConversationContext } from './conversationContext';
import { WorkspaceIndexChunk } from './workspaceIndexRanking';

export interface CodeGenerationContext {
	readonly request: string;
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly selection?: string;
	readonly visibleFiles: readonly string[];
	readonly conversation?: ConversationContext;
	readonly indexedChunks?: readonly WorkspaceIndexChunk[];
}

export interface CodeGenerationAnswer {
	readonly spoken_response: string;
	readonly display_response: string;
	readonly changed_files: readonly string[];
	readonly primary_file?: string;
	readonly primary_line?: number;
}

export interface CodeGenerationProgress {
	readonly kind: 'text' | 'tool' | 'code';
	readonly text: string;
	readonly file?: string;
	readonly previousText?: string;
	readonly toolIndex?: number;
}

interface StreamingToolCall {
	readonly name: string;
	input: string;
	streamedCode?: string;
}

const MAX_SELECTION_CHARS = 6_000;
const MAX_INDEXED_EVIDENCE_CHARS = 20_000;
const MAX_DISPLAY_CHARS = 4_000;
const MAX_CHANGED_FILES = 12;

export class CodeGenerationStreamDecoder {
	private readonly streamingTools = new Map<number, StreamingToolCall>();

	accept(message: unknown): readonly CodeGenerationProgress[] {
		const messageValue = asRecord(message);
		if (messageValue?.type !== 'stream_event') {
			return [];
		}

		const event = asRecord(messageValue.event);
		if (!event || typeof event.type !== 'string') {
			return [];
		}

		switch (event.type) {
			case 'content_block_start':
				return this.startTool(event);
			case 'content_block_delta':
				return this.updateBlock(event);
			case 'content_block_stop':
				return this.finishTool(event);
			default:
				return [];
		}
	}

	private startTool(event: Record<string, unknown>): readonly CodeGenerationProgress[] {
		const index = eventIndex(event);
		const block = asRecord(event.content_block);
		if (index === undefined || block?.type !== 'tool_use' || typeof block.name !== 'string') {
			return [];
		}

		this.streamingTools.set(index, { name: block.name, input: '' });
		return [{ kind: 'tool', text: describeToolActivity(block.name) }];
	}

	private updateBlock(event: Record<string, unknown>): readonly CodeGenerationProgress[] {
		const delta = asRecord(event.delta);
		if (!delta || typeof delta.type !== 'string') {
			return [];
		}
		if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
			return [{ kind: 'text', text: delta.text }];
		}
		if (delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') {
			return [];
		}

		const index = eventIndex(event);
		const tool = index === undefined ? undefined : this.streamingTools.get(index);
		if (!tool || index === undefined) {
			return [];
		}

		tool.input += delta.partial_json;
		return this.streamCode(tool, index);
	}

	private finishTool(event: Record<string, unknown>): readonly CodeGenerationProgress[] {
		const index = eventIndex(event);
		if (index === undefined) {
			return [];
		}
		const tool = this.streamingTools.get(index);
		if (!tool) {
			return [];
		}

		this.streamingTools.delete(index);
		return [{ kind: 'tool', text: describeToolActivity(tool.name, tool.input) }];
	}

	private streamCode(tool: StreamingToolCall, toolIndex: number): readonly CodeGenerationProgress[] {
		const code = streamingCode(tool.name, tool.input);
		if (!code || code.text === undefined) {
			return [];
		}

		const previous = tool.streamedCode;
		tool.streamedCode = code.text;
		if (previous === undefined) {
			if (!code.text) {
				return [];
			}
			return [{
				kind: 'code',
				text: code.text,
				file: code.file,
				previousText: code.previousText,
				toolIndex,
			}];
		}
		if (!code.text.startsWith(previous) || code.text.length === previous.length) {
			return [];
		}
		return [{
			kind: 'code',
			text: code.text.slice(previous.length),
			file: code.file,
			toolIndex,
		}];
	}
}

export const CODE_GENERATION_OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		spoken_response: {
			type: 'string',
			description: 'The completed edit. Use the fewest words necessary; state only the result.',
		},
		display_response: {
			type: 'string',
			description: 'A concise summary of the implementation, important decisions, and any remaining caveats.',
		},
		changed_files: {
			type: 'array',
			items: { type: 'string' },
			description: 'Every workspace-relative file created or edited during this request.',
		},
		primary_file: {
			type: 'string',
			description: 'The workspace-relative changed file the IDE should open after the edit.',
		},
		primary_line: {
			type: 'integer',
			description: 'A one-based line in primary_file containing the most relevant change.',
		},
	},
	required: ['spoken_response', 'display_response', 'changed_files'],
	additionalProperties: false,
} as const;

export function buildCodeGenerationPrompt(context: CodeGenerationContext): string {
	const activeLocation = context.activeFile
		? `${context.activeFile}${context.activeLine ? `:${context.activeLine}` : ''}`
		: 'none';
	const visibleFiles = context.visibleFiles.length > 0 ? context.visibleFiles.join(', ') : 'none';
	const selection = context.selection
		? truncate(context.selection, MAX_SELECTION_CHARS)
		: 'none';
	const conversation = formatConversationContext(context.conversation);
	const indexedEvidence = formatIndexedEvidence(context.indexedChunks);

	return `Implement the requested repository change directly in the workspace.

Request: ${context.request}

Recent CDE conversation:
${conversation}

Live editor context:
- Active location: ${activeLocation}
- Visible files: ${visibleFiles}
- Selected code:
${selection}

Relevant local codebase index (source ranges only):
${indexedEvidence}

Use the indexed ranges to start from likely code, then inspect the relevant code before editing. Use the conversation to resolve follow-ups such as "that", "this", "another one", and "the function you just added". The current request and live editor context take precedence when they conflict. Make the smallest complete change that satisfies the request and preserve surrounding conventions. Use only the available read, search, edit, and write tools; do not run shell commands, browse the web, use MCP, modify files outside the workspace, or make unrelated changes. Treat the selection as the target when the request says "this", "it", or "here".

When finished, return every changed workspace-relative file in changed_files. Set primary_file to the most useful changed file for the editor to open, and primary_line to a changed one-based line. spoken_response must state only the completed result in the fewest words necessary. If the request cannot be implemented safely from the repository, make no edits and explain why.`;
}

function formatIndexedEvidence(chunks: readonly WorkspaceIndexChunk[] | undefined): string {
	if (!chunks || chunks.length === 0) {
		return 'No matching indexed source was found.';
	}
	let remaining = MAX_INDEXED_EVIDENCE_CHARS;
	const sections: string[] = [];
	for (const chunk of chunks) {
		if (remaining <= 0) {
			break;
		}
		const source = chunk.text.split(/\r?\n/).map((line, index) => `${chunk.startLine + index}: ${line}`).join('\n');
		const section = `--- ${chunk.path}:${chunk.startLine}-${chunk.endLine} ---\n${source}`;
		sections.push(truncate(section, remaining));
		remaining -= section.length;
	}
	return sections.join('\n\n');
}

export function parseCodeGenerationAnswer(structuredOutput: unknown, fallback: string): CodeGenerationAnswer | undefined {
	if (isRecord(structuredOutput)) {
		const answer = fromRecord(structuredOutput);
		if (answer) {
			return answer;
		}
	}

	try {
		const parsed = JSON.parse(fallback) as unknown;
		if (isRecord(parsed)) {
			const answer = fromRecord(parsed);
			if (answer) {
				return answer;
			}
		}
	} catch {
		// Fall back to the plain result from the Agent SDK.
	}

	const plainText = fallback.trim();
	if (!plainText) {
		return undefined;
	}
	return normalizeAnswer(plainText, plainText, [], undefined, undefined);
}

function fromRecord(value: Record<string, unknown>): CodeGenerationAnswer | undefined {
	if (typeof value.spoken_response !== 'string'
		|| typeof value.display_response !== 'string'
		|| !Array.isArray(value.changed_files)
		|| value.changed_files.some(file => typeof file !== 'string')) {
		return undefined;
	}

	return normalizeAnswer(
		value.spoken_response,
		value.display_response,
		value.changed_files,
		typeof value.primary_file === 'string' ? value.primary_file : undefined,
		typeof value.primary_line === 'number' ? value.primary_line : undefined,
	);
}

function normalizeAnswer(
	spokenResponse: string,
	displayResponse: string,
	changedFiles: readonly string[],
	primaryFile: string | undefined,
	primaryLine: number | undefined,
): CodeGenerationAnswer | undefined {
	const spoken = spokenResponse.trim();
	const display = truncate(displayResponse.trim(), MAX_DISPLAY_CHARS);
	if (!spoken || !display) {
		return undefined;
	}

	const normalizedFiles = changedFiles
		.map(normalizeRelativePath)
		.filter((file): file is string => Boolean(file))
		.filter((file, index, files) => files.indexOf(file) === index)
		.slice(0, MAX_CHANGED_FILES);
	const normalizedPrimaryFile = normalizeRelativePath(primaryFile ?? '');
	const selectedPrimaryFile = normalizedPrimaryFile && normalizedFiles.includes(normalizedPrimaryFile)
		? normalizedPrimaryFile
		: normalizedFiles[0];
	const selectedPrimaryLine = selectedPrimaryFile && typeof primaryLine === 'number' && Number.isInteger(primaryLine) && primaryLine > 0
		? primaryLine
		: undefined;

	return {
		spoken_response: spoken,
		display_response: display,
		changed_files: normalizedFiles,
		primary_file: selectedPrimaryFile,
		primary_line: selectedPrimaryLine,
	};
}

function normalizeRelativePath(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
	if (!normalized || normalized.startsWith('/') || normalized.split('/').some(segment => !segment || segment === '..')) {
		return undefined;
	}
	return normalized;
}

function truncate(value: string, maximumLength: number): string {
	if (value.length <= maximumLength) {
		return value;
	}
	return `${value.slice(0, maximumLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function eventIndex(event: Record<string, unknown>): number | undefined {
	return typeof event.index === 'number' && Number.isInteger(event.index) ? event.index : undefined;
}

function describeToolActivity(name: string, serializedInput?: string): string {
	const file = serializedInput ? toolFile(serializedInput) : undefined;
	switch (name) {
		case 'Read':
			return file ? `Reading ${file}…` : 'Reading the workspace…';
		case 'Glob':
		case 'Grep':
			return 'Searching the workspace…';
		case 'Edit':
		case 'Write':
			return file ? `Writing ${file}…` : 'Writing code…';
		default:
			return `Using ${name}…`;
	}
}

function toolFile(serializedInput: string): string | undefined {
	try {
		const input = asRecord(JSON.parse(serializedInput));
		if (!input) {
			return undefined;
		}
		for (const key of ['file_path', 'path', 'file']) {
			if (typeof input[key] === 'string' && input[key]) {
				return input[key];
			}
		}
	} catch {
		// Tool input may be incomplete when the stream is interrupted.
	}
	return undefined;
}

function streamingCode(name: string, serializedInput: string): { readonly text?: string; readonly file?: string; readonly previousText?: string } | undefined {
	if (name === 'Edit') {
		return {
			text: partialJsonString(serializedInput, 'new_string'),
			file: partialToolFile(serializedInput),
			previousText: partialJsonString(serializedInput, 'old_string'),
		};
	}
	if (name === 'Write') {
		return {
			text: partialJsonString(serializedInput, 'content'),
			file: partialToolFile(serializedInput),
		};
	}
	return undefined;
}

function partialToolFile(serializedInput: string): string | undefined {
	for (const key of ['file_path', 'path', 'file']) {
		const file = partialJsonString(serializedInput, key);
		if (file) {
			return file;
		}
	}
	return undefined;
}

function partialJsonString(serializedInput: string, key: string): string | undefined {
	const property = new RegExp(`"${key}"\\s*:\\s*"`).exec(serializedInput);
	if (!property) {
		return undefined;
	}

	let result = '';
	for (let index = property.index + property[0].length; index < serializedInput.length; index++) {
		const character = serializedInput[index];
		if (character === '"') {
			return result;
		}
		if (character !== '\\') {
			result += character;
			continue;
		}

		const escape = serializedInput[index + 1];
		if (!escape) {
			return result;
		}
		index++;
		switch (escape) {
			case '"':
			case '\\':
			case '/':
				result += escape;
				break;
			case 'b':
				result += '\b';
				break;
			case 'f':
				result += '\f';
				break;
			case 'n':
				result += '\n';
				break;
			case 'r':
				result += '\r';
				break;
			case 't':
				result += '\t';
				break;
			case 'u': {
				const codePoint = serializedInput.slice(index + 1, index + 5);
				if (!/^[\da-f]{4}$/i.test(codePoint)) {
					return result;
				}
				result += String.fromCharCode(Number.parseInt(codePoint, 16));
				index += 4;
				break;
			}
			default:
				return result;
		}
	}
	return result;
}
