/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const WALKTHROUGH_CONTROL_ACTIONS = ['next', 'previous', 'repeat', 'pause', 'resume', 'stop', 'follow_on', 'follow_off'] as const;
export type WalkthroughControlAction = typeof WALKTHROUGH_CONTROL_ACTIONS[number];

export type CdeToolName = 'open_file' | 'focus_open_file' | 'open_symbol' | 'show_references' | 'control_references' | 'show_call_hierarchy' | 'control_call_hierarchy' | 'go_to_definition' | 'control_editor' | 'ask_codebase' | 'control_walkthrough' | 'implement_change' | 'run_terminal_command' | 'control_terminal';

export interface ToolDispatch {
	readonly name: CdeToolName;
	readonly arguments: string;
}

export type ToolRoutingResult =
	| { readonly type: 'tool'; readonly dispatch: ToolDispatch }
	| { readonly type: 'response'; readonly spokenResponse: string };

interface AnthropicToolUse {
	readonly type: 'tool_use';
	readonly name: string;
	readonly input: unknown;
}

export function parseHaikuToolRoute(value: unknown): ToolRoutingResult | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return undefined;
	}

	const toolUse = value.content.find(isToolUse);
	if (!toolUse || !isRecord(toolUse.input)) {
		return undefined;
	}
	if (toolUse.name === 'respond_to_user') {
		const spokenResponse = toolUse.input.spoken_response;
		return typeof spokenResponse === 'string' && spokenResponse.trim()
			? { type: 'response', spokenResponse: spokenResponse.trim() }
			: undefined;
	}
	if (!isCdeToolName(toolUse.name)) {
		return undefined;
	}
	return { type: 'tool', dispatch: { name: toolUse.name, arguments: JSON.stringify(toolUse.input) } };
}

function isToolUse(value: unknown): value is AnthropicToolUse {
	return isRecord(value)
		&& value.type === 'tool_use'
		&& typeof value.name === 'string'
		&& 'input' in value;
}

function isCdeToolName(name: string): name is CdeToolName {
	return name === 'open_file'
		|| name === 'focus_open_file'
		|| name === 'open_symbol'
		|| name === 'show_references'
		|| name === 'control_references'
		|| name === 'show_call_hierarchy'
		|| name === 'control_call_hierarchy'
		|| name === 'go_to_definition'
		|| name === 'control_editor'
		|| name === 'ask_codebase'
		|| name === 'control_walkthrough'
		|| name === 'implement_change'
		|| name === 'run_terminal_command'
		|| name === 'control_terminal';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
