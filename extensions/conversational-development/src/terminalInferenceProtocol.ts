/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TerminalToolResult } from './terminalOrchestrator';

const MAX_TERMINAL_INFERENCE_CHARS = 12_000;

export interface TerminalInterpretation {
	readonly spoken_response: string;
	readonly display_response: string;
}

interface AnthropicToolUse {
	readonly type: 'tool_use';
	readonly name: string;
	readonly input: unknown;
}

export function buildTerminalInferencePrompt(originalRequest: string, result: TerminalToolResult): string {
	const terminalEvidence = {
		ok: result.ok,
		session: result.session,
		status: result.status,
		command: result.command,
		cwd: result.cwd,
		exit_code: result.exit_code,
		output_tail: result.output_tail?.slice(-MAX_TERMINAL_INFERENCE_CHARS),
		location_count: result.location_count,
		file: result.file,
		line: result.line,
		sessions: result.sessions,
		error: result.error,
	};

	return `Original user request: ${originalRequest}

Terminal evidence:
${JSON.stringify(terminalEvidence, null, 2)}

Infer what this terminal evidence means specifically for the original request. Distinguish a command that merely started from one that completed. Do not read raw logs aloud. Preserve useful error names, counts, and file locations in the display response.`;
}

export function parseTerminalInterpretation(value: unknown): TerminalInterpretation | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return undefined;
	}
	const toolUse = value.content.find(isInterpretationToolUse);
	if (!toolUse || !isRecord(toolUse.input)) {
		return undefined;
	}
	const spoken = typeof toolUse.input.spoken_response === 'string' ? toolUse.input.spoken_response.trim() : '';
	const display = typeof toolUse.input.display_response === 'string' ? toolUse.input.display_response.trim() : '';
	return spoken && display ? { spoken_response: spoken, display_response: display } : undefined;
}

function isInterpretationToolUse(value: unknown): value is AnthropicToolUse {
	return isRecord(value)
		&& value.type === 'tool_use'
		&& value.name === 'report_terminal_result'
		&& 'input' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
