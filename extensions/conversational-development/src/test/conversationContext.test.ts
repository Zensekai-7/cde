/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { ConversationContextStore, formatConversationContext } from '../conversationContext';

test('keeps prior requests, outcomes, and changed files as CDE context', () => {
	const context = new ConversationContextStore();
	const firstTurn = context.beginTurn('Add calculateFinalPrice to checkout.', {
		activeFile: 'src/checkout.ts',
		activeLine: 12,
		visibleFiles: ['src/checkout.ts', 'src/cart.ts'],
	});
	context.recordAction(firstTurn, 'implement_change', '{"request":"Add calculateFinalPrice to checkout."}');
	context.recordOutcome(firstTurn, {
		ok: true,
		spoken_response: 'Added calculateFinalPrice.',
		display_response: 'Added calculateFinalPrice in src/checkout.ts.',
		changed_files: ['src/checkout.ts'],
		primary_file: 'src/checkout.ts',
	});

	const secondTurn = context.beginTurn('Now make another one that chooses based on a binary input.', {
		activeFile: 'src/checkout.ts',
		activeLine: 24,
		visibleFiles: ['src/checkout.ts'],
	});
	context.recordAction(secondTurn, 'implement_change', '{"request":"Now make another one that chooses based on a binary input."}');
	assert.strictEqual(context.getRequest(secondTurn), 'Now make another one that chooses based on a binary input.');

	const formatted = formatConversationContext(context.getContext());
	assert.match(formatted, /Add calculateFinalPrice to checkout/);
	assert.match(formatted, /Added calculateFinalPrice in src\/checkout\.ts/);
	assert.match(formatted, /Now make another one/);
	assert.match(formatted, /Current session files: src\/checkout\.ts, src\/cart\.ts/);
});

test('does not attach an earlier tool result to a newer turn', () => {
	const context = new ConversationContextStore();
	const firstTurn = context.beginTurn('Open checkout.', { visibleFiles: [] });
	const secondTurn = context.beginTurn('Explain it.', { visibleFiles: [] });
	context.recordOutcome(firstTurn, { ok: true, spoken_response: 'Opened checkout.' });

	const turns = context.getContext().recentTurns;
	assert.strictEqual(turns[0].outcome, 'Opened checkout.');
	assert.strictEqual(turns[1].outcome, undefined);
	assert.notStrictEqual(firstTurn, secondTurn);
});

test('remembers files changed by a delegated background job', () => {
	const store = new ConversationContextStore();
	const turn = store.beginTurn('Handle the checkout guard in the background.', { visibleFiles: [] });
	store.recordOutcome(turn, {
		ok: true,
		spoken_response: 'Done.',
		job: { changed_files: ['src/checkout.ts', 'tests/checkout.test.ts'] },
	});
	assert.deepEqual(store.getContext().relatedFiles, ['src/checkout.ts', 'tests/checkout.test.ts']);
});
