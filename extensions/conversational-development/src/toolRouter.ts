/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicApiKey } from './apiKeys';
import { BACKGROUND_JOB_ACTIONS } from './backgroundJobsProtocol';
import { ConversationContext, formatConversationContext } from './conversationContext';
import {
	CALL_HIERARCHY_CONTROL_ACTIONS,
	CALL_HIERARCHY_DIRECTIONS,
	EDITOR_CONTROL_ACTIONS,
	EDITOR_PLACEMENTS,
	REFERENCE_CONTROL_ACTIONS,
} from './navigation';
import { TERMINAL_CONTROL_ACTIONS } from './terminalProtocol';
import { ROUTING_INSTRUCTIONS } from './toolRoutingInstructions';
import { parseHaikuToolRoute, ToolRoutingResult, WALKTHROUGH_CONTROL_ACTIONS } from './toolRoutingProtocol';
import { QueryCache, queryCacheKey } from './queryCache';

const TOOL_ROUTING_TIMEOUT_MS = 15_000;
const ROUTER_MODEL = 'claude-haiku-4-5-20251001';
const ROUTER_CACHE_ENTRIES = 64;
const ROUTER_CACHE_TTL_MS = 2 * 60_000;

export interface ToolRoutingContext {
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly selection?: string;
	readonly visibleFiles: readonly string[];
	readonly walkthroughActive: boolean;
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
		name: 'focus_open_file',
		description: 'Pure navigation only: focus an existing open text-editor tab by semantic filename, path, or module description. Use this instead of open_file when the user refers to a tab that is already open.',
		input_schema: objectSchema({
			query: stringProperty('A concise filename, path, or description of the already-open tab.'),
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
		name: 'control_references',
		description: 'Navigate a references view that is already open: move to the next or previous result, select a result in a named file, open the selected result, or close the view.',
		input_schema: objectSchema({
			action: enumProperty(REFERENCE_CONTROL_ACTIONS, 'The deterministic references-view action.'),
			file: stringProperty('For select_file, the filename or path containing the desired result.'),
			occurrence: integerProperty('For select_file, the one-based occurrence within the named file. Defaults to 1.'),
		}, ['action']),
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
		name: 'control_call_hierarchy',
		description: 'Navigate a call hierarchy that is already open: move between calls, select a call semantically, traverse deeper or to the parent, switch direction, open the selected call, or close the view.',
		input_schema: objectSchema({
			action: enumProperty(CALL_HIERARCHY_CONTROL_ACTIONS, 'The deterministic call-hierarchy action.'),
			query: stringProperty('For select, the symbol or caller/callee to select.'),
			file: stringProperty('Optional filename or path hint for select.'),
		}, ['action']),
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
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where the narrated walkthrough should appear. Omit to reuse the currently focused editor; set only when the user explicitly requests a split or direction.'),
		}, ['question']),
		strict: true,
	},
	{
		name: 'control_walkthrough',
		description: 'Control the active narrated code walkthrough without changing repository files. Use only when the user is clearly referring to the current walkthrough.',
		input_schema: objectSchema({
			action: enumProperty(WALKTHROUGH_CONTROL_ACTIONS, 'The walkthrough playback or editor-following action.'),
		}, ['action']),
		strict: true,
	},
	{
		name: 'implement_change',
		description: 'Foreground workspace change only: inspect the repository, make the requested scoped change with Sonnet, then open the most relevant changed file. A named symbol is implementation context, not a navigation request. Use this for normal edits; do not use it when the user explicitly asks the work to run in the background, asynchronously, or while they do something else.',
		input_schema: objectSchema({
			request: stringProperty('The complete code change requested by the user.'),
			placement: enumProperty(EDITOR_PLACEMENTS, 'Where to open the primary changed file. Omit for the current editor.'),
		}, ['request']),
		strict: true,
	},
	{
		name: 'start_background_change',
		description: 'Start an isolated coding job only when the user explicitly asks for a code change to run in the background, asynchronously, in parallel, or while they continue other work. The result is not applied automatically.',
		input_schema: objectSchema({
			request: stringProperty('The complete code change requested by the user.'),
			label: stringProperty('An optional short memorable name for later status, diff, apply, cancel, or discard requests.'),
		}, ['request']),
		strict: true,
	},
	{
		name: 'control_background_job',
		description: 'List, inspect, show a diff for, explicitly apply, cancel, or discard an existing background coding job. Never apply a completed job unless the user directly asks to apply it.',
		input_schema: objectSchema({
			action: enumProperty(BACKGROUND_JOB_ACTIONS, 'The background-job lifecycle action.'),
			job: stringProperty('Optional job id or semantic label. Omit to target the most recent job.'),
			file: stringProperty('Optional changed filename for show_diff.'),
		}, ['action']),
		strict: true,
	},
	{
		name: 'run_terminal_command',
		description: 'Start or replace a named managed terminal command. Use for tests, builds, development servers, scripts, Git inspection, logs, and other explicit shell work. Do not use for editing source files.',
		input_schema: objectSchema({
			command: stringProperty('The exact shell command to execute.'),
			session: stringProperty('A short stable name used for later follow-up controls.'),
			cwd: stringProperty('Optional workspace-relative or absolute working directory.'),
		}, ['command']),
		strict: true,
	},
	{
		name: 'control_terminal',
		description: 'Inspect or control a managed terminal session: list or focus sessions, inspect captured output, interrupt or restart work, send input, navigate captured file locations, or close a session.',
		input_schema: objectSchema({
			action: enumProperty(TERMINAL_CONTROL_ACTIONS, 'The deterministic terminal action.'),
			session: stringProperty('Optional session name. Omit to target the most recently used session.'),
			input: stringProperty('Text to send for send_input.'),
			submit: booleanProperty('Whether send_input should press Enter. Defaults to true.'),
			occurrence: integerProperty('For open_location, the one-based captured location to open.'),
		}, ['action']),
		strict: true,
	},
];

export class SemanticToolRouter {
	private readonly routeCache = new QueryCache<ToolRoutingResult>(ROUTER_CACHE_ENTRIES, ROUTER_CACHE_TTL_MS);

	constructor(private readonly trace: (message: string) => void) { }

	async route(request: string, context: ToolRoutingContext): Promise<ToolRoutingResult> {
		const apiKey = getAnthropicApiKey();
		if (!apiKey) {
			throw new Error('Set cde.anthropicApiKey or ANTHROPIC_API_KEY before using CDE actions.');
		}
		const cacheKey = queryCacheKey('tool-router', { request: normalizeRequest(request), context });
		const cached = this.routeCache.get(cacheKey);
		if (cached) {
			this.trace(`router.route.cache.hit ${cached.type === 'tool' ? cached.dispatch.name : 'respond_to_user'}`);
			return cached;
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
			this.routeCache.set(cacheKey, route);
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

function normalizeRequest(request: string): string {
	return request.trim().replace(/\s+/g, ' ').toLowerCase();
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
- Narrated walkthrough active: ${context.walkthroughActive ? 'yes' : 'no'}
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

function integerProperty(description: string): Record<string, unknown> {
	return { type: 'integer', description };
}

function booleanProperty(description: string): Record<string, unknown> {
	return { type: 'boolean', description };
}

function enumProperty(values: readonly string[], description: string): Record<string, unknown> {
	return { type: 'string', enum: values, description };
}
