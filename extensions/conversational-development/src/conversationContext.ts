/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const MAX_RECENT_TURNS = 8;
const MAX_RELATED_FILES = 12;
const MAX_TURN_TEXT_LENGTH = 1_200;

export interface ConversationEditorContext {
	readonly activeFile?: string;
	readonly activeLine?: number;
	readonly visibleFiles: readonly string[];
}

export interface ConversationTurn {
	readonly request: string;
	readonly action?: string;
	readonly outcome?: string;
	readonly relatedFiles: readonly string[];
}

export interface ConversationContext {
	readonly recentTurns: readonly ConversationTurn[];
	readonly relatedFiles: readonly string[];
}

interface MutableConversationTurn {
	readonly id: number;
	readonly request: string;
	action?: string;
	outcome?: string;
	relatedFiles: string[];
}

interface ToolOutcome {
	readonly ok: boolean;
	readonly spoken_response: string;
	readonly display_response?: string;
	readonly file?: string;
	readonly primary_file?: string;
	readonly changed_files?: readonly string[];
}

/**
 * Keeps the useful continuity from one CDE request to the next while keeping each model prompt focused.
 */
export class ConversationContextStore {
	private turns: MutableConversationTurn[] = [];
	private relatedFiles: string[] = [];
	private nextTurnId = 1;

	beginTurn(request: string, editor: ConversationEditorContext): number {
		const relatedFiles = uniqueFiles([editor.activeFile, ...editor.visibleFiles]);
		const turnId = this.nextTurnId++;
		this.turns.push({
			id: turnId,
			request: truncate(request),
			relatedFiles,
		});
		this.relatedFiles = mergeFiles(relatedFiles, this.relatedFiles);
		this.trim();
		return turnId;
	}

	recordAction(turnId: number, action: string, argumentsValue?: string): void {
		const turn = this.findTurn(turnId);
		if (!turn) {
			return;
		}
		turn.action = argumentsValue ? `${action} ${truncate(argumentsValue)}` : action;
	}

	recordOutcome(turnId: number, outcome: ToolOutcome): void {
		const turn = this.findTurn(turnId);
		if (!turn) {
			return;
		}

		turn.outcome = truncate(outcome.display_response || outcome.spoken_response);
		const files = uniqueFiles([
			...turn.relatedFiles,
			outcome.file,
			outcome.primary_file,
			...(outcome.changed_files ?? []),
		]);
		turn.relatedFiles = files;
		this.relatedFiles = mergeFiles(files, this.relatedFiles);
		this.trim();
	}

	getContext(): ConversationContext {
		return {
			recentTurns: this.turns.map(turn => ({ ...turn, relatedFiles: [...turn.relatedFiles] })),
			relatedFiles: [...this.relatedFiles],
		};
	}

	getRequest(turnId: number): string | undefined {
		return this.findTurn(turnId)?.request;
	}

	private findTurn(turnId: number): MutableConversationTurn | undefined {
		return this.turns.find(turn => turn.id === turnId);
	}

	private trim(): void {
		this.turns = this.turns.slice(-MAX_RECENT_TURNS);
		this.relatedFiles = this.relatedFiles.slice(0, MAX_RELATED_FILES);
	}
}

/**
 * Formats prior CDE requests as context for a model; the current request is supplied separately.
 */
export function formatConversationContext(context: ConversationContext | undefined): string {
	if (!context || context.recentTurns.length === 0) {
		return 'No earlier CDE requests in this session.';
	}

	const turns = context.recentTurns.map((turn, index) => {
		const lines = [`${index + 1}. User: ${turn.request}`];
		if (turn.action) {
			lines.push(`   Action: ${turn.action}`);
		}
		if (turn.outcome) {
			lines.push(`   Outcome: ${turn.outcome}`);
		}
		if (turn.relatedFiles.length > 0) {
			lines.push(`   Related files: ${turn.relatedFiles.join(', ')}`);
		}
		return lines.join('\n');
	});
	const relatedFiles = context.relatedFiles.length > 0 ? context.relatedFiles.join(', ') : 'none';
	return `${turns.join('\n')}\nCurrent session files: ${relatedFiles}`;
}

function truncate(value: string): string {
	const trimmed = value.trim();
	return trimmed.length <= MAX_TURN_TEXT_LENGTH ? trimmed : `${trimmed.slice(0, MAX_TURN_TEXT_LENGTH - 1)}…`;
}

function mergeFiles(primary: readonly string[], existing: readonly string[]): string[] {
	return uniqueFiles([...primary, ...existing]).slice(0, MAX_RELATED_FILES);
}

function uniqueFiles(files: readonly (string | undefined)[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const file of files) {
		const normalized = file?.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
