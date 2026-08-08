/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getOpenAiApiKey } from './apiKeys';
import { CodeGenerationController, CodeGenerationToolResult } from './codeGeneration';
import { CodeGenerationProgress } from './codeGenerationProtocol';
import { CodeQaController, CodeQaToolResult } from './codeQa';
import { CodeQaWalkthroughStep } from './codeQaProtocol';
import { HaikuToolRouter, ToolRoutingContext } from './toolRouter';
import { CdeToolName, WALKTHROUGH_CONTROL_ACTIONS, WalkthroughControlAction } from './toolRoutingProtocol';
import { TerminalOrchestrator, TerminalToolResult } from './terminalOrchestrator';
import { TERMINAL_CONTROL_ACTIONS, TerminalControlAction } from './terminalProtocol';
import {
	CALL_HIERARCHY_CONTROL_ACTIONS,
	CALL_HIERARCHY_DIRECTIONS,
	CallHierarchyControlAction,
	CallHierarchyDirection,
	EDITOR_CONTROL_ACTIONS,
	EDITOR_PLACEMENTS,
	EditorControlAction,
	EditorPlacement,
	NavigationController,
	NavigationToolResult,
	REFERENCE_CONTROL_ACTIONS,
	ReferenceControlAction,
} from './navigation';
import { WalkthroughController } from './walkthrough';

const VIEW_ID = 'cde.conversation';
const SDP_EXCHANGE_TIMEOUT_MS = 15_000;

interface CdeToolArguments {
	readonly query?: string;
	readonly question?: string;
	readonly request?: string;
	readonly command?: string;
	readonly session?: string;
	readonly cwd?: string;
	readonly input?: string;
	readonly symbol?: string;
	readonly file?: string;
	readonly placement?: EditorPlacement;
	readonly action?: EditorControlAction;
	readonly referenceAction?: ReferenceControlAction;
	readonly callHierarchyAction?: CallHierarchyControlAction;
	readonly walkthroughAction?: WalkthroughControlAction;
	readonly terminalAction?: TerminalControlAction;
	readonly direction?: CallHierarchyDirection;
	readonly occurrence?: number;
	readonly submit?: boolean;
}

type WebviewMessage =
	| { readonly type: 'exchangeSdp'; readonly requestId: string; readonly sdp: string }
	| { readonly type: 'routeTool'; readonly requestId: string; readonly sessionEpoch: number; readonly transcript: string; readonly walkthroughActive: boolean }
	| { readonly type: 'executeTool'; readonly requestId: string; readonly sessionEpoch: number; readonly callId: string; readonly name: string; readonly arguments: string }
	| { readonly type: 'revealWalkthroughStep'; readonly requestId: string; readonly sessionEpoch: number; readonly walkthroughId: string; readonly stepIndex: number; readonly step: CodeQaWalkthroughStep }
	| { readonly type: 'resetWalkthrough' }
	| { readonly type: 'openCheckoutDirectly'; readonly requestId: string };

const realtimeSession = {
	type: 'realtime',
	model: 'gpt-realtime-2.1',
	instructions: `You are CDE's voice output. Never decide, route, or perform IDE actions. Speak only the exact response supplied in a response.create instruction, with no additions.`,
	audio: {
		input: {
			transcription: { model: 'gpt-4o-mini-transcribe' },
			turn_detection: {
				type: 'semantic_vad',
				eagerness: 'high',
				create_response: false,
				interrupt_response: true,
			},
		},
		output: {
			voice: 'marin',
			speed: 1.1,
		},
	},
} as const;

class ConversationViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly output: vscode.OutputChannel,
		private readonly navigation: NavigationController,
		private readonly codeQa: CodeQaController,
		private readonly codeGeneration: CodeGenerationController,
		private readonly toolRouter: HaikuToolRouter,
		private readonly walkthrough: WalkthroughController,
		private readonly terminal: TerminalOrchestrator,
	) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage));
		this.trace('view.ready');
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'exchangeSdp':
				await this.exchangeSdp(message.requestId, message.sdp);
				return;
			case 'routeTool':
				await this.routeTool(message);
				return;
			case 'executeTool':
				await this.executeTool(message);
				return;
			case 'revealWalkthroughStep': {
				const result = await this.walkthrough.reveal(message.step);
				this.trace(`walkthrough.reveal index=${message.stepIndex} ${JSON.stringify(result)}`);
				await this.post({
					type: 'walkthroughStepReady',
					requestId: message.requestId,
					sessionEpoch: message.sessionEpoch,
					walkthroughId: message.walkthroughId,
					stepIndex: message.stepIndex,
					result,
				});
				return;
			}
			case 'resetWalkthrough':
				this.walkthrough.reset();
				return;
			case 'openCheckoutDirectly': {
				const result = await this.navigation.openPreparedCheckout();
				this.trace(`direct.result ${JSON.stringify(result)}`);
				await this.post({ type: 'directResult', requestId: message.requestId, result });
				return;
			}
		}
	}

	private async routeTool(message: Extract<WebviewMessage, { type: 'routeTool' }>): Promise<void> {
		try {
			const route = await this.toolRouter.route(message.transcript, captureToolRoutingContext(message.walkthroughActive));
			if (route.type === 'response') {
				await this.post({
					type: 'routeResponse',
					requestId: message.requestId,
					sessionEpoch: message.sessionEpoch,
					spokenResponse: route.spokenResponse,
				});
				return;
			}
			await this.post({
				type: 'toolRoute',
				requestId: message.requestId,
				sessionEpoch: message.sessionEpoch,
				name: route.dispatch.name,
				arguments: route.dispatch.arguments,
			});
		} catch (error) {
			const detail = formatError(error);
			this.trace(`haiku.route.error ${detail}`);
			await this.post({
				type: 'routeError',
				requestId: message.requestId,
				sessionEpoch: message.sessionEpoch,
				message: detail,
			});
		}
	}

	private async exchangeSdp(requestId: string, sdp: string): Promise<void> {
		try {
			this.trace('realtime.sdp.request');
			const apiKey = getOpenAiApiKey();
			if (!apiKey) {
				throw new Error(vscode.l10n.t('Set cde.openaiApiKey or OPENAI_API_KEY before connecting.'));
			}

			const form = new FormData();
			form.set('sdp', sdp);
			form.set('session', JSON.stringify(realtimeSession));
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), SDP_EXCHANGE_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch('https://api.openai.com/v1/realtime/calls', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'OpenAI-Safety-Identifier': 'cde-local-spike',
					},
					body: form,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error('OpenAI Realtime session setup timed out.');
				}
				throw error;
			} finally {
				clearTimeout(timeout);
			}

			const answer = await response.text();
			if (!response.ok) {
				throw new Error(`OpenAI Realtime returned ${response.status}: ${answer}`);
			}

			this.trace('realtime.sdp.answer');
			await this.post({ type: 'sdpAnswer', requestId, sdp: answer });
		} catch (error) {
			const message = formatError(error);
			this.trace(`realtime.error ${message}`);
			await this.post({ type: 'requestError', requestId, message });
		}
	}

	private async executeTool(message: Extract<WebviewMessage, { type: 'executeTool' }>): Promise<void> {
		this.trace(`tool.call ${message.name} ${message.arguments}`);
		let result: NavigationToolResult | CodeQaToolResult | CodeGenerationToolResult | TerminalToolResult;
		const argumentsValue = isCdeToolName(message.name) ? parseCdeToolArguments(message.name, message.arguments) : undefined;
		if (!isCdeToolName(message.name)) {
			result = {
				ok: false,
				spoken_response: 'That tool is not available in this experiment.',
				error: `Unknown tool: ${message.name}`,
			};
		} else if (!argumentsValue) {
			result = {
				ok: false,
				spoken_response: 'I could not understand that IDE request.',
				error: `Invalid arguments for ${message.name}.`,
			};
		} else {
			switch (message.name) {
				case 'open_file':
					result = await this.navigation.openFile(argumentsValue.query!, argumentsValue.placement);
					break;
				case 'focus_open_file':
					result = await this.navigation.focusOpenFile(argumentsValue.query!);
					break;
				case 'open_symbol':
					result = await this.navigation.openSymbol(argumentsValue.query!, argumentsValue.file, argumentsValue.placement);
					break;
				case 'show_references':
					result = await this.navigation.showReferences(argumentsValue.symbol, argumentsValue.file);
					break;
				case 'control_references':
					result = await this.navigation.controlReferences(argumentsValue.referenceAction!, argumentsValue.file, argumentsValue.occurrence);
					break;
				case 'show_call_hierarchy':
					result = await this.navigation.showCallHierarchy(argumentsValue.direction!, argumentsValue.symbol, argumentsValue.file);
					break;
				case 'control_call_hierarchy':
					result = await this.navigation.controlCallHierarchy(argumentsValue.callHierarchyAction!, argumentsValue.query, argumentsValue.file);
					break;
				case 'go_to_definition':
					result = await this.navigation.goToDefinition(argumentsValue.symbol, argumentsValue.file, argumentsValue.placement);
					break;
				case 'control_editor':
					result = await this.navigation.controlEditor(argumentsValue.action!);
					break;
				case 'ask_codebase':
					result = await this.codeQa.ask(argumentsValue.question!);
					break;
				case 'control_walkthrough':
					result = {
						ok: false,
						spoken_response: 'The walkthrough control is handled by the conversation view.',
						error: 'Walkthrough control was sent to the extension host instead of the webview.',
					};
					break;
				case 'implement_change':
					result = await this.implementChange(argumentsValue.request!, argumentsValue.placement, progress => this.reportCodeGenerationProgress(message, progress));
					break;
				case 'run_terminal_command':
					result = await this.terminal.runCommand(argumentsValue.command!, argumentsValue.session, argumentsValue.cwd);
					break;
				case 'control_terminal':
					result = await this.terminal.control(
						argumentsValue.terminalAction!,
						argumentsValue.session,
						argumentsValue.input,
						argumentsValue.submit ?? true,
						argumentsValue.occurrence,
					);
					break;
			}
		}

		this.trace(`tool.result ${JSON.stringify(result)}`);
		await this.post({
			type: 'toolResult',
			requestId: message.requestId,
			sessionEpoch: message.sessionEpoch,
			callId: message.callId,
			result,
		});
	}

	private async implementChange(request: string, placement: EditorPlacement | undefined, reportProgress: (progress: CodeGenerationProgress) => void): Promise<CodeGenerationToolResult> {
		const result = await this.codeGeneration.implement(request, reportProgress);
		if (!result.ok || !result.primary_file) {
			return result;
		}

		const navigation = await this.navigation.openGeneratedFile(result.primary_file, result.primary_line, placement);
		if (!navigation.ok) {
			this.trace(`code-generation.reveal.error ${navigation.error ?? 'unknown error'}`);
			return result;
		}

		return {
			...result,
			primary_file: navigation.file,
			primary_line: navigation.line,
		};
	}

	private reportCodeGenerationProgress(message: Extract<WebviewMessage, { type: 'executeTool' }>, progress: CodeGenerationProgress): void {
		if (progress.kind === 'tool') {
			this.trace(`code-generation.progress ${progress.text}`);
		}
		void this.post({
			type: 'codeGenerationProgress',
			sessionEpoch: message.sessionEpoch,
			callId: message.callId,
			kind: progress.kind,
			text: progress.text,
		});
	}

	private async post(message: object): Promise<void> {
		await this.view?.webview.postMessage(message);
	}

	private trace(message: string): void {
		this.output.appendLine(`${new Date().toISOString()} ${message}`);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; media-src blob:;">
	<link rel="stylesheet" href="${styleUri}">
	<title>CDE Conversation</title>
</head>
<body>
	<main>
		<header>
			<div id="orb" class="orb idle" aria-hidden="true"></div>
			<div>
				<h1>CDE</h1>
				<p id="state">Disconnected</p>
			</div>
		</header>
		<div class="connection-controls">
			<button id="connect" class="primary">Connect</button>
			<button id="mute" class="mute" type="button" aria-pressed="false" title="Mute microphone" disabled>Mute</button>
		</div>
		<section class="transcript" aria-live="polite">
			<span class="label">You</span>
			<p id="userText">Say “why can the discount make this negative?”</p>
			<span class="label">CDE</span>
			<p id="assistantText">Waiting to connect.</p>
		</section>
		<section id="walkthrough" class="walkthrough" hidden>
			<div class="walkthrough-header">
				<div>
					<span class="label">Walkthrough</span>
					<p id="walkthroughProgress" class="walkthrough-progress"></p>
				</div>
				<button id="walkthroughFollow" class="compact" type="button" aria-pressed="true" title="Toggle automatic editor following">Follow On</button>
			</div>
			<ol id="walkthroughSteps" class="walkthrough-steps"></ol>
			<div class="walkthrough-controls">
				<button id="walkthroughPrevious" class="compact" type="button" title="Previous walkthrough step">Previous</button>
				<button id="walkthroughPause" class="compact" type="button" title="Pause walkthrough">Pause</button>
				<button id="walkthroughRepeat" class="compact" type="button" title="Repeat walkthrough step">Repeat</button>
				<button id="walkthroughNext" class="compact" type="button" title="Next walkthrough step">Next</button>
				<button id="walkthroughStop" class="compact" type="button" title="Stop walkthrough">Stop</button>
			</div>
		</section>
		<form id="textForm">
			<input id="textInput" type="text" placeholder="Text fallback" autocomplete="off">
			<button type="submit" title="Send text">Send</button>
		</form>
		<details>
			<summary>Architecture checks</summary>
			<button id="direct" class="secondary">Test IDE bridge</button>
			<pre id="events"></pre>
		</details>
	</main>
	<audio id="remoteAudio" autoplay></audio>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function isCdeToolName(name: string): name is CdeToolName {
	return name === 'open_file'
		|| name === 'focus_open_file'
		|| name === 'open_symbol'
		|| name === 'show_references'
		|| name === 'control_references'
		|| name === 'show_call_hierarchy'
		|| name === 'control_call_hierarchy'
		|| name === 'go_to_definition'
		|| name === 'control_editor'
		|| name === 'ask_codebase'
		|| name === 'control_walkthrough'
		|| name === 'implement_change'
		|| name === 'run_terminal_command'
		|| name === 'control_terminal';
}

const CDE_TOOL_ARGUMENT_KEYS: Readonly<Record<CdeToolName, readonly string[]>> = {
	open_file: ['query', 'placement'],
	focus_open_file: ['query'],
	open_symbol: ['query', 'file', 'placement'],
	show_references: ['symbol', 'file'],
	control_references: ['action', 'file', 'occurrence'],
	show_call_hierarchy: ['direction', 'symbol', 'file'],
	control_call_hierarchy: ['action', 'query', 'file'],
	go_to_definition: ['symbol', 'file', 'placement'],
	control_editor: ['action'],
	ask_codebase: ['question'],
	control_walkthrough: ['action'],
	implement_change: ['request', 'placement'],
	run_terminal_command: ['command', 'session', 'cwd'],
	control_terminal: ['action', 'session', 'input', 'submit', 'occurrence'],
};

function parseCdeToolArguments(toolName: CdeToolName, serializedArguments: string): CdeToolArguments | undefined {
	try {
		const value = JSON.parse(serializedArguments) as Record<string, unknown> | null;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}

		const allowedKeys = CDE_TOOL_ARGUMENT_KEYS[toolName];
		if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
			return undefined;
		}

		for (const [key, candidate] of Object.entries(value)) {
			if (key === 'occurrence') {
				if (!Number.isInteger(candidate) || (candidate as number) < 1) {
					return undefined;
				}
				continue;
			}
			if (key === 'submit') {
				if (typeof candidate !== 'boolean') {
					return undefined;
				}
				continue;
			}
			if (typeof candidate !== 'string' || !candidate.trim()) {
				return undefined;
			}
		}
		if ((toolName === 'open_file' || toolName === 'focus_open_file' || toolName === 'open_symbol') && typeof value.query !== 'string') {
			return undefined;
		}
		if (toolName === 'ask_codebase' && typeof value.question !== 'string') {
			return undefined;
		}
		if (toolName === 'implement_change' && typeof value.request !== 'string') {
			return undefined;
		}
		if (toolName === 'run_terminal_command' && typeof value.command !== 'string') {
			return undefined;
		}
		if (typeof value.placement === 'string' && !EDITOR_PLACEMENTS.includes(value.placement as EditorPlacement)) {
			return undefined;
		}
		if (toolName === 'control_editor'
			&& (typeof value.action !== 'string' || !EDITOR_CONTROL_ACTIONS.includes(value.action as EditorControlAction))) {
			return undefined;
		}
		if (toolName === 'control_references'
			&& (typeof value.action !== 'string' || !REFERENCE_CONTROL_ACTIONS.includes(value.action as ReferenceControlAction))) {
			return undefined;
		}
		if (toolName === 'control_references' && value.action === 'select_file' && typeof value.file !== 'string') {
			return undefined;
		}
		if (toolName === 'control_call_hierarchy'
			&& (typeof value.action !== 'string' || !CALL_HIERARCHY_CONTROL_ACTIONS.includes(value.action as CallHierarchyControlAction))) {
			return undefined;
		}
		if (toolName === 'control_call_hierarchy' && value.action === 'select' && typeof value.query !== 'string') {
			return undefined;
		}
		if (toolName === 'control_walkthrough'
			&& (typeof value.action !== 'string' || !WALKTHROUGH_CONTROL_ACTIONS.includes(value.action as WalkthroughControlAction))) {
			return undefined;
		}
		if (toolName === 'control_terminal'
			&& (typeof value.action !== 'string' || !TERMINAL_CONTROL_ACTIONS.includes(value.action as TerminalControlAction))) {
			return undefined;
		}
		if (toolName === 'show_call_hierarchy'
			&& (typeof value.direction !== 'string' || !CALL_HIERARCHY_DIRECTIONS.includes(value.direction as CallHierarchyDirection))) {
			return undefined;
		}

		return {
			query: typeof value.query === 'string' ? value.query.trim() : undefined,
			question: typeof value.question === 'string' ? value.question.trim() : undefined,
			request: typeof value.request === 'string' ? value.request.trim() : undefined,
			command: typeof value.command === 'string' ? value.command.trim() : undefined,
			session: typeof value.session === 'string' ? value.session.trim() : undefined,
			cwd: typeof value.cwd === 'string' ? value.cwd.trim() : undefined,
			input: typeof value.input === 'string' ? value.input.trim() : undefined,
			symbol: typeof value.symbol === 'string' ? value.symbol.trim() : undefined,
			file: typeof value.file === 'string' ? value.file.trim() : undefined,
			placement: typeof value.placement === 'string' ? value.placement as EditorPlacement : undefined,
			action: toolName === 'control_editor' && typeof value.action === 'string' ? value.action as EditorControlAction : undefined,
			referenceAction: toolName === 'control_references' && typeof value.action === 'string' ? value.action as ReferenceControlAction : undefined,
			callHierarchyAction: toolName === 'control_call_hierarchy' && typeof value.action === 'string' ? value.action as CallHierarchyControlAction : undefined,
			walkthroughAction: toolName === 'control_walkthrough' && typeof value.action === 'string' ? value.action as WalkthroughControlAction : undefined,
			terminalAction: toolName === 'control_terminal' && typeof value.action === 'string' ? value.action as TerminalControlAction : undefined,
			direction: typeof value.direction === 'string' ? value.direction as CallHierarchyDirection : undefined,
			occurrence: typeof value.occurrence === 'number' ? value.occurrence : undefined,
			submit: typeof value.submit === 'boolean' ? value.submit : undefined,
		};
	} catch {
		return undefined;
	}
}

function captureToolRoutingContext(walkthroughActive: boolean): ToolRoutingContext {
	const activeEditor = vscode.window.activeTextEditor;
	const activeFile = activeEditor && activeEditor.document.uri.scheme === 'file'
		? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
		: undefined;
	const selection = activeEditor && !activeEditor.selection.isEmpty
		? activeEditor.document.getText(activeEditor.selection)
		: undefined;
	const visibleFiles = vscode.window.visibleTextEditors
		.filter(editor => editor.document.uri.scheme === 'file')
		.map(editor => vscode.workspace.asRelativePath(editor.document.uri, false))
		.filter((file, index, files) => files.indexOf(file) === index);

	return {
		activeFile,
		activeLine: activeEditor ? activeEditor.selection.active.line + 1 : undefined,
		selection,
		visibleFiles,
		walkthroughActive,
	};
}

function formatError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}

	if (error.cause instanceof Error) {
		return `${error.name}: ${error.message}; cause: ${error.cause.name}: ${error.cause.message}`;
	}

	return error.cause === undefined
		? `${error.name}: ${error.message}`
		: `${error.name}: ${error.message}; cause: ${String(error.cause)}`;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(vscode.l10n.t('CDE Spike'));
	const highlight = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full,
	});
	const navigation = new NavigationController(highlight);
	const codeQa = new CodeQaController(message => output.appendLine(`${new Date().toISOString()} ${message}`));
	const codeGeneration = new CodeGenerationController(message => output.appendLine(`${new Date().toISOString()} ${message}`));
	const toolRouter = new HaikuToolRouter(message => output.appendLine(`${new Date().toISOString()} ${message}`));
	const walkthrough = new WalkthroughController(highlight);
	const terminal = new TerminalOrchestrator(message => output.appendLine(`${new Date().toISOString()} ${message}`));
	const provider = new ConversationViewProvider(context.extensionUri, output, navigation, codeQa, codeGeneration, toolRouter, walkthrough, terminal);
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.name = vscode.l10n.t('CDE Spike');
	status.text = '$(mic) CDE Spike';
	status.tooltip = vscode.l10n.t('Open the CDE voice-to-IDE experiment');
	status.command = 'cde.openConversation';
	status.show();

	context.subscriptions.push(
		output,
		highlight,
		terminal,
		status,
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('cde.openConversation', () => vscode.commands.executeCommand('workbench.view.extension.cde')),
		vscode.commands.registerCommand('cde.openCheckoutDirectly', () => navigation.openPreparedCheckout()),
	);
}
