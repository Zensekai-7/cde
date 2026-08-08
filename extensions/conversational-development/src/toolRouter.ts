/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicApiKey } from './apiKeys';
import {
	CALL_HIERARCHY_DIRECTIONS,
	EDITOR_CONTROL_ACTIONS,
	EDITOR_PLACEMENTS,
} from './navigation';
import { parseHaikuToolRoute, ToolRoutingResult } from './toolRoutingProtocol';

const TOOL_ROUTING_TIMEOUT_MS = 15_000;
const HAIKU_MODEL = 'claude-haiku-4-5';

export interface ToolRoutingContext {
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly selection?: string;
	readonly visibleFiles: readonly string[];
}

interface AnthropicTool {
	readonly name: string;
	readonly description: string;
	readonly input_schema: Record<string, unknown>;
	readonly strict: true;
}

interface AnthropicMessageResponse {
	readonly content: readonly unknown[];
}

const TOOLS: readonly AnthropicTool[] = [
	{
		name: 'respond_to_user',
		description: 'Use only when no IDE action is requested. Return the shortest correct spoken answer.',
		input_schema: objectSchema({
			spoken_response: stringProperty('The direct spoken answer, with no filler or process narration.'),
		}, ['spoken_response']),
		strict: true,
	},
	{
		name: 'open_file',
		description: 'Pure navigation only: fuzzy-find and open an existing file in the current workspace. Do not use for questions or requested edits.',
		input_schema: objectSchema({
			query: stringProperty('A concise filename, path, or module phrase.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the file. Omit for the current editor.'),
		}, ['query']),
		strict: true,
	},
	{
		name: 'open_symbol',
		description: 'Pure navigation only: find, open, select, and highlight an existing named workspace symbol. Do not use for questions or requested workspace changes.',
		input_schema: objectSchema({
			query: stringProperty('The source symbol name to find.'),
			file: stringProperty('Optional filename or path hint.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the symbol. Omit for the current editor.'),
		}, ['query']),
		strict: true,
	},
	{
		name: 'show_references',
		description: 'Pure navigation only: show native VS Code references for an explicit, selected, or recently opened symbol.',
		input_schema: objectSchema({
			symbol: stringProperty('Optional explicit source symbol name. Omit for contextual follow-ups.'),
			file: stringProperty('Optional filename or path hint for the explicit symbol.'),
		}),
		strict: true,
	},
	{
		name: 'show_call_hierarchy',
		description: 'Pure navigation only: show true incoming callers or outgoing calls for an explicit, selected, or recently opened symbol.',
		input_schema: objectSchema({
			direction: enumProperty(CALL_HIERARCHY_DIRECTIONS, 'Incoming means callers; outgoing means symbols called by the target.'),
			symbol: stringProperty('Optional explicit source symbol name. Omit for contextual follow-ups.'),
			file: stringProperty('Optional filename or path hint for the explicit symbol.'),
		}, ['direction']),
		strict: true,
	},
	{
		name: 'go_to_definition',
		description: 'Pure navigation only: go to the definition of an explicit, selected, or recently opened symbol.',
		input_schema: objectSchema({
			symbol: stringProperty('Optional explicit source symbol name. Omit for contextual follow-ups.'),
			file: stringProperty('Optional filename or path hint for the explicit symbol.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the definition. Omit for the current editor.'),
		}),
		strict: true,
	},
	{
		name: 'control_editor',
		description: 'Editor control only: change layout, focus, tabs, groups, or navigation history without answering questions or modifying workspace files.',
		input_schema: objectSchema({
			action: enumProperty(EDITOR_CONTROL_ACTIONS, 'The deterministic editor action to execute.'),
		}, ['action']),
		strict: true,
	},
	{
		name: 'ask_codebase',
		description: 'Repository inquiry only: inspect the current repository with Haiku and answer a grounded code question using live editor context. Do not use for navigation or requested edits.',
		input_schema: objectSchema({
			question: stringProperty('The complete repository question in the user\'s own words.'),
		}, ['question']),
		strict: true,
	},
	{
		name: 'implement_change',
		description: 'Workspace change only: inspect the repository, make the requested scoped edit with Sonnet, then open the most relevant changed file. A mention of an existing symbol is implementation context, not a navigation request. Do not use for questions or pure navigation.',
		input_schema: objectSchema({
			request: stringProperty('The complete code change requested by the user.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the primary changed file. Omit for the current editor.'),
		}, ['request']),
		strict: true,
	},
];

export class HaikuToolRouter {
	constructor(private readonly trace: (message: string) => void) { }

	async route(request: string, context: ToolRoutingContext): Promise<ToolRoutingResult> {
		const apiKey = getAnthropicApiKey();
		if (!apiKey) {
			throw new Error('Set cde.anthropicApiKey or ANTHROPIC_API_KEY before using CDE actions.');
		}

		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), TOOL_ROUTING_TIMEOUT_MS);
		this.trace(`haiku.route.start model=${getHaikuModel()}`);
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: getHaikuModel(),
					max_tokens: 256,
					system: 'You are CDE\'s semantic IDE dispatcher. Call exactly one tool for every request. Decide from the user\'s intended outcome, never exact trigger phrases. A named file or symbol is context: changing it is implement_change, explaining it is ask_codebase, and revealing it is a navigation tool. Use respond_to_user only when no IDE action is requested. Never answer in prose outside a tool call. Do not call more than one tool.',
					messages: [{ role: 'user', content: buildRoutingPrompt(request, context) }],
					tools: TOOLS,
					tool_choice: { type: 'any', disable_parallel_tool_use: true },
				}),
				signal: abortController.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`Claude Haiku returned ${response.status}: ${body}`);
			}

			const route = parseHaikuToolRoute(JSON.parse(body) as AnthropicMessageResponse);
			if (!route) {
				throw new Error('Claude Haiku did not return a valid CDE tool call.');
			}
			this.trace(`haiku.route.selected ${route.type === 'tool' ? route.dispatch.name : 'respond_to_user'}`);
			return route;
		} catch (error) {
			if (abortController.signal.aborted) {
				throw new Error('Claude Haiku tool selection timed out.');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function buildRoutingPrompt(request: string, context: ToolRoutingContext): string {
	const activeLocation = context.activeFile
		? `${context.activeFile}${context.activeLine ? `:${context.activeLine}` : ''}`
		: 'none';
	const visibleFiles = context.visibleFiles.length > 0 ? context.visibleFiles.join(', ') : 'none';
	const selection = context.selection?.slice(0, 4_000) || 'none';
	return `User request: ${request}

Live editor context:
- Active location: ${activeLocation}
- Visible files: ${visibleFiles}
- Selected code:\n${selection}`;
}

function getHaikuModel(): string {
	return process.env.CDE_CLAUDE_TOOL_MODEL?.trim() || HAIKU_MODEL;
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
	return {
		type: 'object',
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	};
}

function stringProperty(description: string): Record<string, unknown> {
	return { type: 'string', description };
}

function enumProperty(values: readonly string[], description: string): Record<string, unknown> {
	return { type: 'string', enum: values, description };
}
