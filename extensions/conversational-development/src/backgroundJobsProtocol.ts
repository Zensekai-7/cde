/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const BACKGROUND_JOB_ACTIONS = ['list', 'inspect', 'show_diff', 'apply', 'cancel', 'discard'] as const;
export type BackgroundJobAction = typeof BACKGROUND_JOB_ACTIONS[number];

export const BACKGROUND_JOB_STATUSES = ['queued', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'applied', 'discarded'] as const;
export type BackgroundJobStatus = typeof BACKGROUND_JOB_STATUSES[number];

export interface BackgroundJobView {
	readonly id: string;
	readonly label: string;
	readonly request: string;
	readonly status: BackgroundJobStatus;
	readonly progress?: string;
	readonly changed_files: readonly string[];
	readonly created_at: number;
	readonly completed_at?: number;
}

export interface BackgroundJobToolResult {
	readonly ok: boolean;
	readonly spoken_response: string;
	readonly display_response?: string;
	readonly job?: BackgroundJobView;
	readonly jobs?: readonly BackgroundJobView[];
	readonly file?: string;
	readonly error?: string;
}

export type BackgroundJobResolution =
	| { readonly kind: 'resolved'; readonly job: BackgroundJobView }
	| { readonly kind: 'ambiguous'; readonly candidates: readonly BackgroundJobView[] }
	| { readonly kind: 'not_found' };

const DEICTIC_JOB_REFERENCES = new Set(['it', 'that', 'this', 'that-one', 'this-one', 'that-change', 'this-change', 'that-job', 'this-job', 'the-job']);
const OTHER_JOB_REFERENCES = new Set(['other', 'the-other', 'other-one', 'the-other-one', 'other-job', 'the-other-job', 'other-change', 'the-other-change']);
const LATEST_JOB_REFERENCES = new Set(['latest', 'the-latest', 'latest-job', 'the-latest-job', 'most-recent', 'most-recent-job']);

export function resolveBackgroundJobReference(
	jobs: readonly BackgroundJobView[],
	query?: string,
	lastReferencedId?: string,
	preferredStatuses: readonly BackgroundJobStatus[] = [],
): BackgroundJobResolution {
	const ordered = [...jobs].sort((left, right) => right.created_at - left.created_at);
	if (ordered.length === 0) {
		return { kind: 'not_found' };
	}

	const normalized = query ? normalizeBackgroundJobLabel(query) : '';
	const preferred = preferredStatuses.length > 0
		? ordered.filter(job => preferredStatuses.includes(job.status))
		: ordered;
	const lastReferenced = ordered.find(job => job.id === lastReferencedId);
	if (!normalized || DEICTIC_JOB_REFERENCES.has(normalized)) {
		if (lastReferenced) {
			return { kind: 'resolved', job: lastReferenced };
		}
		return preferred[0] ? { kind: 'resolved', job: preferred[0] } : { kind: 'not_found' };
	}

	if (LATEST_JOB_REFERENCES.has(normalized)) {
		return preferred[0] ? { kind: 'resolved', job: preferred[0] } : { kind: 'not_found' };
	}
	if (OTHER_JOB_REFERENCES.has(normalized)) {
		const alternatives = preferred.filter(job => job.id !== lastReferencedId);
		return singleOrAmbiguous(alternatives);
	}

	const exact = ordered.filter(job => job.id === query || job.label === normalized);
	if (exact.length > 0) {
		return singleOrAmbiguous(exact);
	}
	const statusMatches = jobsMatchingStatusReference(ordered, normalized);
	if (statusMatches) {
		if (isLatestReference(normalized)) {
			return statusMatches[0] ? { kind: 'resolved', job: statusMatches[0] } : { kind: 'not_found' };
		}
		return singleOrAmbiguous(statusMatches);
	}
	return singleOrAmbiguous(ordered.filter(job => job.label.includes(normalized)));
}

export function describeBackgroundJob(job: BackgroundJobView): string {
	const label = spokenBackgroundJobLabel(job.label);
	const changed = job.changed_files.length === 0
		? ''
		: ` It changed ${job.changed_files.length} file${job.changed_files.length === 1 ? '' : 's'}.`;
	switch (job.status) {
		case 'queued':
			return `${label} is waiting its turn.`;
		case 'preparing':
		case 'running':
			return `I'm still working on ${label}.`;
		case 'completed':
			return `${label} is done.${changed} Want to see the diff?`;
		case 'failed':
			return `I couldn't finish ${label}.`;
		case 'cancelled':
			return `${label} was stopped.`;
		case 'applied':
			return `${label} is already in your workspace.`;
		case 'discarded':
			return `${label} was discarded.`;
	}
}

export function summarizeBackgroundJobs(jobs: readonly BackgroundJobView[]): string {
	if (jobs.length === 0) {
		return 'Nothing is running in the background.';
	}
	return [...jobs]
		.sort((left, right) => right.created_at - left.created_at)
		.map(job => `${spokenBackgroundJobLabel(job.label)} ${briefStatus(job.status)}`)
		.join('. ') + '.';
}

export function spokenBackgroundJobLabel(label: string): string {
	return label.replace(/[-_]+/g, ' ');
}

export function normalizeBackgroundJobLabel(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

function singleOrAmbiguous(candidates: readonly BackgroundJobView[]): BackgroundJobResolution {
	if (candidates.length === 0) {
		return { kind: 'not_found' };
	}
	return candidates.length === 1
		? { kind: 'resolved', job: candidates[0] }
		: { kind: 'ambiguous', candidates };
}

function jobsMatchingStatusReference(jobs: readonly BackgroundJobView[], normalized: string): readonly BackgroundJobView[] | undefined {
	const words = new Set(normalized.split('-'));
	if (['done', 'finished', 'completed', 'ready'].some(word => words.has(word))) {
		return jobs.filter(job => job.status === 'completed');
	}
	if (['running', 'working', 'progress', 'active'].some(word => words.has(word))) {
		return jobs.filter(job => job.status === 'preparing' || job.status === 'running');
	}
	if (['waiting', 'queued'].some(word => words.has(word))) {
		return jobs.filter(job => job.status === 'queued');
	}
	if (['failed', 'broken'].some(word => words.has(word))) {
		return jobs.filter(job => job.status === 'failed');
	}
	return undefined;
}

function isLatestReference(normalized: string): boolean {
	const words = new Set(normalized.split('-'));
	return words.has('latest') || (words.has('most') && words.has('recent'));
}

function briefStatus(status: BackgroundJobStatus): string {
	switch (status) {
		case 'queued': return 'is waiting';
		case 'preparing':
		case 'running': return 'is still in progress';
		case 'completed': return 'is ready to review';
		case 'failed': return 'did not finish';
		case 'cancelled': return 'was stopped';
		case 'applied': return 'is in your workspace';
		case 'discarded': return 'was discarded';
	}
}
