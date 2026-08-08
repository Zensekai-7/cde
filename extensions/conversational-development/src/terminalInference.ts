/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAnthropicApiKey } from './apiKeys';
import type { TerminalToolResult } from './terminalOrchestrator';
import { buildTerminalInferencePrompt, parseTerminalInterpretation, TerminalInterpretation } from './terminalInferenceProtocol';

const TERMINAL_INFERENCE_TIMEOUT_MS = 15_000;
const TERMINAL_INFERENCE_MAX_TOKENS = 384;
const TERMINAL_INFERENCE_MODEL = 'claude-haiku-4-5-20251001';

export class TerminalResultInterpreter {
	constructor(private readonly trace: (message: string) => void) { }

	async interpret(originalRequest: string, result: TerminalToolResult): Promise<TerminalInterpretation> {
		const apiKey = getAnthropicApiKey();
		if (!apiKey) {
			throw new Error('Set cde.anthropicApiKey or ANTHROPIC_API_KEY before interpreting terminal output.');
		}

		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), TERMINAL_INFERENCE_TIMEOUT_MS);
		this.trace(`terminal.inference.start model=${getInferenceModel()}`);
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: getInferenceModel(),
					max_tokens: TERMINAL_INFERENCE_MAX_TOKENS,
					system: 'You interpret managed terminal results for a conversational IDE. Ground every claim in the supplied terminal evidence. Be concise, natural, and useful. Never recite raw output or shell noise aloud.',
					messages: [{ role: 'user', content: buildTerminalInferencePrompt(originalRequest, result) }],
					tools: [{
						name: 'report_terminal_result',
						description: 'Return the inferred terminal outcome for display and speech.',
						input_schema: {
							type: 'object',
							properties: {
								spoken_response: { type: 'string', description: 'A natural spoken answer of at most 45 words. Never recite raw logs.' },
								display_response: { type: 'string', description: 'A concise interpretation with important counts, errors, and file locations.' },
							},
							required: ['spoken_response', 'display_response'],
							additionalProperties: false,
						},
						strict: true,
					}],
					tool_choice: { type: 'tool', name: 'report_terminal_result', disable_parallel_tool_use: true },
				}),
				signal: abortController.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`Claude terminal inference returned ${response.status}: ${body}`);
			}
			const interpretation = parseTerminalInterpretation(JSON.parse(body));
			if (!interpretation) {
				throw new Error('Claude terminal inference returned no usable result.');
			}
			this.trace('terminal.inference.success');
			return interpretation;
		} catch (error) {
			if (abortController.signal.aborted) {
				throw new Error('Claude terminal inference timed out.');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function getInferenceModel(): string {
	return process.env.CDE_CLAUDE_ROUTER_MODEL?.trim()
		|| process.env.CDE_CLAUDE_TOOL_MODEL?.trim()
		|| TERMINAL_INFERENCE_MODEL;
}
