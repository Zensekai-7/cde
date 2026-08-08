/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_JOB_ACTIONS, BACKGROUND_JOB_STATUSES, BackgroundJobStatus, BackgroundJobView, describeBackgroundJob, normalizeBackgroundJobLabel, resolveBackgroundJobReference, summarizeBackgroundJobs } from '../backgroundJobsProtocol';

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

test('resolves conversational references using the last discussed job', () => {
	const validation = job('job-1', 'boundary-validation', 'running', 1);
	const tests = job('job-2', 'checkout-tests', 'completed', 2);
	assert.equal(resolveBackgroundJobReference([validation, tests], 'that change', validation.id).kind, 'resolved');
	assert.equal(resolvedId(resolveBackgroundJobReference([validation, tests], undefined, validation.id)), validation.id);
	assert.equal(resolvedId(resolveBackgroundJobReference([validation, tests], 'the latest')), tests.id);
	assert.equal(resolvedId(resolveBackgroundJobReference([validation, tests], 'the finished one')), tests.id);
	assert.equal(resolvedId(resolveBackgroundJobReference([validation, tests], 'the other one', validation.id)), tests.id);
});

test('uses action-compatible jobs for unqualified follow-ups', () => {
	const running = job('job-1', 'boundary-validation', 'running', 2);
	const ready = job('job-2', 'checkout-tests', 'completed', 1);
	assert.equal(
		resolvedId(resolveBackgroundJobReference([running, ready], undefined, undefined, ['completed'])),
		ready.id,
	);
	assert.equal(
		resolvedId(resolveBackgroundJobReference([running, ready], undefined, running.id, ['completed'])),
		running.id,
	);
});

test('selects the newest job when both status and recency are explicit', () => {
	const earlier = job('job-1', 'checkout-tests', 'completed', 1);
	const latest = job('job-2', 'validation-tests', 'completed', 2);
	assert.equal(resolvedId(resolveBackgroundJobReference([earlier, latest], 'the latest finished one')), latest.id);
});

test('asks for clarification when a natural reference has multiple matches', () => {
	const current = job('job-1', 'boundary-validation', 'running', 3);
	const firstAlternative = job('job-2', 'checkout-tests', 'completed', 2);
	const secondAlternative = job('job-3', 'discount-tests', 'completed', 1);
	const resolution = resolveBackgroundJobReference([current, firstAlternative, secondAlternative], 'the other one', current.id);
	assert.equal(resolution.kind, 'ambiguous');
	if (resolution.kind === 'ambiguous') {
		assert.deepEqual(resolution.candidates.map(candidate => candidate.id), [firstAlternative.id, secondAlternative.id]);
	}
});

test('produces compact teammate-style status updates', () => {
	const running = job('job-1', 'boundary-validation', 'running', 2);
	const ready = { ...job('job-2', 'checkout-tests', 'completed', 1), changed_files: ['src/checkout.ts', 'tests/checkout.test.ts'] };
	assert.equal(describeBackgroundJob(running), "I'm still working on boundary validation.");
	assert.equal(describeBackgroundJob(ready), 'checkout tests is done. It changed 2 files. Want to see the diff?');
	assert.equal(summarizeBackgroundJobs([running, ready]), 'boundary validation is still in progress. checkout tests is ready to review.');
});

function job(id: string, label: string, status: BackgroundJobStatus, createdAt: number): BackgroundJobView {
	return {
		id,
		label,
		request: label,
		status,
		changed_files: [],
		created_at: createdAt,
	};
}

function resolvedId(resolution: ReturnType<typeof resolveBackgroundJobReference>): string | undefined {
	return resolution.kind === 'resolved' ? resolution.job.id : undefined;
}
