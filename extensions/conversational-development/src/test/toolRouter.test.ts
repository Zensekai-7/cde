/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { ROUTING_INSTRUCTIONS } from '../toolRoutingInstructions';
import { parseHaikuToolRoute } from '../toolRoutingProtocol';

test('uses end-state semantics for workspace changes rather than navigation', () => {
	assert.match(ROUTING_INSTRUCTIONS, /semantic end state that would make the request complete/);
	assert.match(ROUTING_INSTRUCTIONS, /end state differs from the current workspace, choose implement_change by default/);
	assert.match(ROUTING_INSTRUCTIONS, /Never choose navigation merely to locate or inspect a target before changing it/);
});

test('reserves background jobs for explicit parallel work and explicit application', () => {
	assert.match(ROUTING_INSTRUCTIONS, /start_background_change instead only when the user explicitly asks/);
	assert.match(ROUTING_INSTRUCTIONS, /Never apply a background result automatically/);
});

test('parses a strict Haiku IDE tool call', () => {
	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'implement_change',
			input: { request: 'Add tax to checkout.' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'implement_change',
			arguments: '{"request":"Add tax to checkout."}',
		},
	});
});

test('parses a direct Haiku response', () => {
	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'respond_to_user',
			input: { spoken_response: 'The discount is applied before the total is clamped.' },
		}],
	}), {
		type: 'response',
		spokenResponse: 'The discount is applied before the total is clamped.',
	});
});

test('parses semantic open-tab and nested navigation tool calls', () => {
	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'focus_open_file',
			input: { query: 'the checkout tab' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'focus_open_file',
			arguments: '{"query":"the checkout tab"}',
		},
	});

	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'control_references',
			input: { action: 'select_file', file: 'checkout.ts', occurrence: 2 },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'control_references',
			arguments: '{"action":"select_file","file":"checkout.ts","occurrence":2}',
		},
	});

	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'control_call_hierarchy',
			input: { action: 'deeper' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'control_call_hierarchy',
			arguments: '{"action":"deeper"}',
		},
	});

	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'control_walkthrough',
			input: { action: 'previous' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'control_walkthrough',
			arguments: '{"action":"previous"}',
		},
	});
});

test('rejects an invalid Haiku tool call', () => {
	assert.strictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'run_shell',
			input: { command: 'pwd' },
		}],
	}), undefined);
});

test('parses managed terminal tool calls', () => {
	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'run_terminal_command',
			input: { command: 'npm test', session: 'tests' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'run_terminal_command',
			arguments: '{"command":"npm test","session":"tests"}',
		},
	});

	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'control_terminal',
			input: { action: 'send_input', session: 'server', input: 'rs', submit: false },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'control_terminal',
			arguments: '{"action":"send_input","session":"server","input":"rs","submit":false}',
		},
	});
});

test('parses background coding job tool calls', () => {
	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'start_background_change',
			input: { request: 'Add boundary validation and tests.', label: 'boundary guard' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'start_background_change',
			arguments: '{"request":"Add boundary validation and tests.","label":"boundary guard"}',
		},
	});

	assert.deepStrictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'control_background_job',
			input: { action: 'show_diff', job: 'boundary-guard', file: 'checkout.ts' },
		}],
	}), {
		type: 'tool',
		dispatch: {
			name: 'control_background_job',
			arguments: '{"action":"show_diff","job":"boundary-guard","file":"checkout.ts"}',
		},
	});
});
