/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkWorkspaceFile, rankWorkspaceIndexChunks } from '../workspaceIndexRanking';

test('chunks source into line-addressable evidence', () => {
	const chunks = chunkWorkspaceFile('src/checkout.ts', 'export function checkout() {\n\treturn calculateFinalPrice();\n}\n');
	assert.deepEqual(chunks, [{
		path: 'src/checkout.ts',
		startLine: 1,
		endLine: 4,
		text: 'export function checkout() {\n\treturn calculateFinalPrice();\n}',
	}]);
});

test('ranks matching source evidence above unrelated snippets', () => {
	const chunks = [
		...chunkWorkspaceFile('src/checkout.ts', 'export function calculateFinalPrice(subtotal: number, discount: number) {\n\treturn subtotal - discount;\n}'),
		...chunkWorkspaceFile('src/profile.ts', 'export function updateProfile() {\n\treturn true;\n}'),
	];
	const results = rankWorkspaceIndexChunks(chunks, 'Why can the final price become negative?');
	assert.equal(results[0]?.path, 'src/checkout.ts');
	assert.match(results[0]?.text ?? '', /subtotal - discount/);
});

test('boosts files from the active conversation when relevance is otherwise equal', () => {
	const chunks = [
		...chunkWorkspaceFile('src/checkout.ts', 'export function validateRequest() { return true; }'),
		...chunkWorkspaceFile('src/orders.ts', 'export function validateRequest() { return true; }'),
	];
	const results = rankWorkspaceIndexChunks(chunks, 'validate request', ['src/orders.ts']);
	assert.equal(results[0]?.path, 'src/orders.ts');
});
