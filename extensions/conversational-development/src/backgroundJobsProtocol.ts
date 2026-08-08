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

export function normalizeBackgroundJobLabel(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}
