/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Converts a workspace path into a concise, natural label for voice responses.
 */
export function voiceFileLabel(filePath: string): string {
	const fileName = filePath.replace(/\\/g, '/').split('/').at(-1) ?? filePath;
	const extensionStart = fileName.lastIndexOf('.');
	const stem = extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
	return stem
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/[-_]+/g, ' ')
		.trim() || 'file';
}
