/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A small in-memory LRU cache for deterministic CDE requests.
 *
 * Results are intentionally kept in the extension host only: source snippets and model answers
 * never leave the current local session through this cache.
 */
export class QueryCache<T> {
	private readonly entries = new Map<string, { readonly value: T; readonly expiresAt: number }>();

	constructor(
		private readonly maximumEntries: number,
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) { }

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}

		// Reinsert so a cache hit becomes the most recently used entry.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
		while (this.entries.size > this.maximumEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}
}

/** Creates a stable, compact key without storing the original request as a Map key. */
export function queryCacheKey(namespace: string, value: unknown): string {
	return `${namespace}:${hash(JSON.stringify(value))}`;
}

function hash(value: string): string {
	let result = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16_777_619);
	}
	return (result >>> 0).toString(36);
}
