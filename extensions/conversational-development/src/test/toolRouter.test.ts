/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { parseHaikuToolRoute } from '../toolRoutingProtocol';

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
