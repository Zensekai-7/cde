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
	assert.match(ROUTING_INSTRUCTIONS, /end state differs from the current workspace, choose implement_change/);
	assert.match(ROUTING_INSTRUCTIONS, /Never choose navigation merely to locate or inspect a target before changing it/);
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

test('rejects an invalid Haiku tool call', () => {
	assert.strictEqual(parseHaikuToolRoute({
		content: [{
			type: 'tool_use',
			name: 'run_shell',
			input: { command: 'pwd' },
		}],
	}), undefined);
});
