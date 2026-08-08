/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicApiKey } from './apiKeys';
import { ConversationContext, formatConversationContext } from './conversationContext';
import {
	CALL_HIERARCHY_DIRECTIONS,
	EDITOR_CONTROL_ACTIONS,
	EDITOR_PLACEMENTS,
} from './navigation';
import { ROUTING_INSTRUCTIONS } from './toolRoutingInstructions';
import { parseHaikuToolRoute, ToolRoutingResult } from './toolRoutingProtocol';

const TOOL_ROUTING_TIMEOUT_MS = 15_000;
const ROUTER_MODEL = 'claude-sonnet-4-5';

export interface ToolRoutingContext {
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly selection?: string;
	readonly visibleFiles: readonly string[];
	readonly conversation?: ConversationContext;
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
		description: 'Pure navigation only: fuzzy-find and reveal an existing file when opening it is the complete requested outcome. Never use as a preliminary step before a workspace change.',
		input_schema: objectSchema({
			query: stringProperty('A concise filename, path, or module phrase.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the file. Omit for the current editor.'),
		}, ['query']),
		strict: true,
	},
	{
		name: 'open_symbol',
		description: 'Pure navigation only: reveal and select an existing symbol when navigation is the complete requested outcome. Never use as a preliminary step for a requested workspace change.',
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
		description: 'Workspace change only: inspect the repository, make the requested scoped change with Sonnet, then open the most relevant changed file. A named symbol is implementation context, not a navigation request. Do not use for questions or pure navigation.',
		input_schema: objectSchema({
			request: stringProperty('The complete code change requested by the user.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the primary changed file. Omit for the current editor.'),
		}, ['request']),
		strict: true,
	},
];

export class SemanticToolRouter {
	constructor(private readonly trace: (message: string) => void) { }

	async route(request: string, context: ToolRoutingContext): Promise<ToolRoutingResult> {
		const apiKey = getAnthropicApiKey();
		if (!apiKey) {
			throw new Error('Set cde.anthropicApiKey or ANTHROPIC_API_KEY before using CDE actions.');
		}

		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), TOOL_ROUTING_TIMEOUT_MS);
		this.trace(`router.route.start model=${getRouterModel()}`);
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: getRouterModel(),
					max_tokens: 256,
					system: ROUTING_INSTRUCTIONS,
					messages: [{ role: 'user', content: buildRoutingPrompt(request, context) }],
					tools: TOOLS,
					tool_choice: { type: 'any', disable_parallel_tool_use: true },
				}),
				signal: abortController.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`Claude router returned ${response.status}: ${body}`);
			}

			const route = parseHaikuToolRoute(JSON.parse(body) as AnthropicMessageResponse);
			if (!route) {
				throw new Error('Claude router did not return a valid CDE tool call.');
			}
			this.trace(`router.route.selected ${route.type === 'tool' ? route.dispatch.name : 'respond_to_user'}`);
			return route;
		} catch (error) {
			if (abortController.signal.aborted) {
				throw new Error('Claude router tool selection timed out.');
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
	const conversation = formatConversationContext(context.conversation);
	return `User request: ${request}

Recent CDE conversation:
${conversation}

Live editor context:
- Active location: ${activeLocation}
- Visible files: ${visibleFiles}
- Selected code:\n${selection}

Use conversation only to resolve intent and references. The current request and live editor context take precedence when they conflict.`;
}

function getRouterModel(): string {
	return process.env.CDE_CLAUDE_ROUTER_MODEL?.trim()
		|| process.env.CDE_CLAUDE_TOOL_MODEL?.trim()
		|| ROUTER_MODEL;
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
