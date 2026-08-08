/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_JOB_ACTIONS, BACKGROUND_JOB_STATUSES, normalizeBackgroundJobLabel } from '../backgroundJobsProtocol';

test('normalizes conversational background-job labels', () => {
	assert.deepEqual([
		normalizeBackgroundJobLabel(' Boundary Validation '),
		normalizeBackgroundJobLabel('PR 52 / tests'),
		normalizeBackgroundJobLabel('Worker_2'),
	], ['boundary-validation', 'pr-52-tests', 'worker_2']);
	assert.equal(normalizeBackgroundJobLabel('x'.repeat(60)).length, 48);
});

test('exposes the complete background-job lifecycle controls', () => {
	assert.deepEqual(BACKGROUND_JOB_ACTIONS, ['list', 'inspect', 'show_diff', 'apply', 'cancel', 'discard']);
	assert.deepEqual(BACKGROUND_JOB_STATUSES, ['queued', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'applied', 'discarded']);
});
