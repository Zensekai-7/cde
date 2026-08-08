/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { test } from 'node:test';
import { buildCodeGenerationPrompt, CodeGenerationStreamDecoder, parseCodeGenerationAnswer } from '../codeGenerationProtocol';

test('buildCodeGenerationPrompt includes the explicit request and live editor context', () => {
	const prompt = buildCodeGenerationPrompt({
		request: 'Clamp the discount percentage before calculating the total.',
		activeFile: 'src/checkout.ts',
		activeLine: 7,
		selection: 'return request.subtotalCents - discount;',
		visibleFiles: ['src/checkout.ts', 'src/cart/cart-summary.ts'],
	});

	assert.match(prompt, /Clamp the discount percentage/);
	assert.match(prompt, /src\/checkout\.ts:7/);
	assert.match(prompt, /return request\.subtotalCents/);
	assert.match(prompt, /smallest complete change/);
});

test('parseCodeGenerationAnswer keeps workspace-relative changed files and selects the primary file', () => {
	const answer = parseCodeGenerationAnswer({
		spoken_response: 'Clamped the discount before calculating the total.',
		display_response: 'Updated the discount calculation.',
		changed_files: ['src\\checkout.ts', '../outside.ts', 'src/checkout.ts', '/tmp/unsafe.ts'],
		primary_file: 'src/checkout.ts',
		primary_line: 7,
	}, 'ignored');

	assert.deepStrictEqual(answer, {
		spoken_response: 'Clamped the discount before calculating the total.',
		display_response: 'Updated the discount calculation.',
		changed_files: ['src/checkout.ts'],
		primary_file: 'src/checkout.ts',
		primary_line: 7,
	});
});

test('parseCodeGenerationAnswer falls back to the first changed file and plain text', () => {
	assert.deepStrictEqual(parseCodeGenerationAnswer({
		spoken_response: 'Added a helper.',
		display_response: 'Created `src/helper.ts`.',
		changed_files: ['src/helper.ts'],
	}, 'ignored'), {
		spoken_response: 'Added a helper.',
		display_response: 'Created `src/helper.ts`.',
		changed_files: ['src/helper.ts'],
		primary_file: 'src/helper.ts',
		primary_line: undefined,
	});

	assert.deepStrictEqual(parseCodeGenerationAnswer(undefined, 'No edit was needed.'), {
		spoken_response: 'No edit was needed.',
		display_response: 'No edit was needed.',
		changed_files: [],
		primary_file: undefined,
		primary_line: undefined,
	});
});

test('CodeGenerationStreamDecoder exposes live text and workspace tool activity', () => {
	const decoder = new CodeGenerationStreamDecoder();
	assert.deepStrictEqual(decoder.accept({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', name: 'Edit' },
		},
	}), [{ kind: 'tool', text: 'Writing code…' }]);
	assert.deepStrictEqual(decoder.accept({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/checkout.ts"}' },
		},
	}), []);
	assert.deepStrictEqual(decoder.accept({
		type: 'stream_event',
		event: { type: 'content_block_stop', index: 0 },
	}), [{ kind: 'tool', text: 'Writing src/checkout.ts…' }]);
	assert.deepStrictEqual(decoder.accept({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 1,
			delta: { type: 'text_delta', text: 'I found the right helper.' },
		},
	}), [{ kind: 'text', text: 'I found the right helper.' }]);
});
