/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryCache, queryCacheKey } from '../queryCache';

test('keeps recently used query results and expires stale values', () => {
	let now = 1_000;
	const cache = new QueryCache<string>(2, 100, () => now);
	cache.set('first', 'one');
	cache.set('second', 'two');
	assert.equal(cache.get('first'), 'one');
	cache.set('third', 'three');
	assert.equal(cache.get('second'), undefined);
	assert.equal(cache.get('first'), 'one');

	now += 100;
	assert.equal(cache.get('first'), undefined);
	assert.equal(cache.get('third'), undefined);
});

test('uses a stable compact key for the same query context', () => {
	assert.equal(
		queryCacheKey('code-qa', { question: 'Where is checkout?', version: 3 }),
		queryCacheKey('code-qa', { question: 'Where is checkout?', version: 3 }),
	);
	assert.notEqual(
		queryCacheKey('code-qa', { question: 'Where is checkout?', version: 3 }),
		queryCacheKey('code-qa', { question: 'Where is checkout?', version: 4 }),
	);
});
