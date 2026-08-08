/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function getOpenAiApiKey(): string | undefined {
	return getConfiguredApiKey('openaiApiKey', 'OPENAI_API_KEY');
}

export function getAnthropicApiKey(): string | undefined {
	return getConfiguredApiKey('anthropicApiKey', 'ANTHROPIC_API_KEY');
}

function getConfiguredApiKey(settingName: string, environmentVariable: string): string | undefined {
	const configured = vscode.workspace.getConfiguration('cde').get<string>(settingName)?.trim();
	return configured || process.env[environmentVariable]?.trim() || undefined;
}
