/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface WorkspaceIndexChunk {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

export interface RankedWorkspaceIndexChunk extends WorkspaceIndexChunk {
	readonly score: number;
}

const QUERY_FILLER_WORDS = new Set([
	'a', 'an', 'and', 'are', 'can', 'code', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
	'me', 'of', 'please', 'show', 'tell', 'that', 'the', 'this', 'to', 'what', 'where', 'why', 'with',
]);

/** Splits source by natural line boundaries so every retrieved snippet has a tight source range. */
export function chunkWorkspaceFile(path: string, source: string, maximumLines = 72, maximumChars = 7_000): WorkspaceIndexChunk[] {
	const lines = source.split(/\r?\n/);
	const chunks: WorkspaceIndexChunk[] = [];
	let start = 0;
	while (start < lines.length) {
		let end = Math.min(lines.length, start + maximumLines);
		let characters = 0;
		for (let index = start; index < end; index++) {
			characters += lines[index].length + 1;
			if (characters > maximumChars && index > start) {
				end = index;
				break;
			}
		}

		// Prefer an empty line as a boundary when one is nearby, without making tiny chunks.
		for (let index = end - 1; index > start + 16; index--) {
			if (!lines[index].trim()) {
				end = index + 1;
				break;
			}
		}
		const text = lines.slice(start, end).join('\n').trim();
		if (text) {
			chunks.push({ path, startLine: start + 1, endLine: end, text });
		}
		start = Math.max(end, start + 1);
	}
	return chunks;
}

/**
 * Scores path, identifiers, and source text together. This is lexical on purpose: it is local,
 * instant after indexing, and produces source ranges the model can cite and verify.
 */
export function rankWorkspaceIndexChunks(
	chunks: readonly WorkspaceIndexChunk[],
	query: string,
	relatedFiles: readonly string[] = [],
	maximumResults = 8,
): RankedWorkspaceIndexChunk[] {
	const terms = queryTerms(query);
	if (terms.length === 0) {
		return [];
	}
	const related = new Set(relatedFiles.map(file => file.replace(/\\/g, '/').toLowerCase()));
	const phrase = terms.join(' ');

	return chunks
		.map(chunk => ({ chunk, score: scoreChunk(chunk, terms, phrase, related) }))
		.filter(candidate => candidate.score > 0)
		.sort((left, right) => right.score - left.score
			|| left.chunk.path.localeCompare(right.chunk.path)
			|| left.chunk.startLine - right.chunk.startLine)
		.slice(0, maximumResults)
		.map(({ chunk, score }) => ({ ...chunk, score }));
}

function scoreChunk(chunk: WorkspaceIndexChunk, terms: readonly string[], phrase: string, relatedFiles: ReadonlySet<string>): number {
	const path = chunk.path.replace(/\\/g, '/').toLowerCase();
	const text = normalize(chunk.text);
	const sourceTerms = new Set(words(`${chunk.path}\n${chunk.text}`));
	let score = 0;
	for (const term of terms) {
		if (path.includes(term)) {
			score += 18;
		}
		if (sourceTerms.has(term)) {
			score += 10;
		}
		if (text.includes(term)) {
			score += 3;
		}
	}
	if (phrase.length > 3 && text.includes(phrase)) {
		score += 30;
	}
	if (relatedFiles.has(path)) {
		score += 14;
	}
	return score;
}

function queryTerms(value: string): string[] {
	const terms = words(value).filter(term => !QUERY_FILLER_WORDS.has(term));
	return terms.length > 0 ? [...new Set(terms)] : words(value);
}

function words(value: string): string[] {
	return normalize(value).split(/[^a-z\d]+/).filter(Boolean);
}

function normalize(value: string): string {
	return value
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase();
}
