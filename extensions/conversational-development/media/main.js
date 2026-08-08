(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const connectButton = document.getElementById('connect');
	const muteButton = document.getElementById('mute');
	const directButton = document.getElementById('direct');
	const textForm = document.getElementById('textForm');
	const textInput = document.getElementById('textInput');
	const stateText = document.getElementById('state');
	const orb = document.getElementById('orb');
	const userText = document.getElementById('userText');
	const assistantText = document.getElementById('assistantText');
	const events = document.getElementById('events');
	const remoteAudio = document.getElementById('remoteAudio');

	let peerConnection;
	let dataChannel;
	let microphone;
	let microphoneMuted = false;
	let sequence = 0;
	let sessionEpochSequence = 0;
	let activeSessionEpoch;
	let assistantBuffer = '';
	let userBuffer = '';
	let pinnedToolAnswer = false;
	let awaitingToolFollowup = false;
	let responseInProgress = false;
	let responseCreateRequested = false;
	let activeRouteRequestId;
	const pendingSdp = new Map();
	const handledCalls = new Set();
	const pendingTools = new Map();
	const queuedResponses = [];
	const codeGenerationStreams = new Map();

	function nextId(prefix) {
		sequence += 1;
		return `${prefix}-${Date.now()}-${sequence}`;
	}

	function log(label, detail) {
		const time = new Date().toLocaleTimeString();
		const line = `${time}  ${label}${detail ? `  ${detail}` : ''}`;
		const current = events.textContent ? events.textContent.split('\n') : [];
		current.push(line);
		events.textContent = current.slice(-24).join('\n');
		events.scrollTop = events.scrollHeight;
	}

	function setState(state, label) {
		stateText.textContent = label;
		orb.className = `orb ${state}`;
		log(`state.${state}`);
	}

	function setReadyState() {
		setState(microphoneMuted ? 'muted' : 'listening', microphoneMuted ? 'Muted' : 'Listening');
	}

	function setMicrophoneMuted(muted) {
		const audioTrack = microphone?.getAudioTracks()[0];
		if (!audioTrack) {
			return;
		}

		microphoneMuted = muted;
		audioTrack.enabled = !muted;
		muteButton.textContent = muted ? 'Unmute' : 'Mute';
		muteButton.title = muted ? 'Unmute microphone' : 'Mute microphone';
		muteButton.setAttribute('aria-pressed', String(muted));
		try {
			sendEvent({
				type: 'session.update',
				session: {
					type: 'realtime',
					audio: {
						input: {
							turn_detection: {
								type: 'semantic_vad',
								eagerness: 'high',
								create_response: false,
								interrupt_response: !muted,
							},
						},
					},
				},
			});
		} catch (error) {
			log('microphone.session-update.error', error.message);
		}
		setReadyState();
		log(muted ? 'microphone.muted' : 'microphone.unmuted');
	}

	function sendEvent(event) {
		if (!dataChannel || dataChannel.readyState !== 'open') {
			throw new Error('Realtime data channel is not open.');
		}
		dataChannel.send(JSON.stringify(event));
	}

	function queueResponse(response) {
		queuedResponses.push(response);
		log('response.queued');
		flushQueuedResponse();
	}

	function flushQueuedResponse() {
		if (responseInProgress || responseCreateRequested || queuedResponses.length === 0) {
			return;
		}

		const response = queuedResponses.shift();
		responseCreateRequested = true;
		try {
			sendEvent(response ? { type: 'response.create', response } : { type: 'response.create' });
		} catch (error) {
			responseCreateRequested = false;
			queuedResponses.unshift(response);
			throw error;
		}
	}

	function requestToolRoute(transcript) {
		if (!activeSessionEpoch || !transcript.trim() || activeRouteRequestId) {
			return;
		}
		const requestId = nextId('route');
		activeRouteRequestId = requestId;
		setState('thinking', 'Choosing an action…');
		assistantText.textContent = 'Choosing the right IDE action…';
		log('router.route.request');
		vscode.postMessage({
			type: 'routeTool',
			requestId,
			sessionEpoch: activeSessionEpoch,
			transcript,
		});
	}

	function speakExact(text) {
		awaitingToolFollowup = true;
		pinnedToolAnswer = true;
		assistantText.textContent = text;
		queueResponse({
			instructions: `Speak only the string value in this JSON and add nothing: ${JSON.stringify(text)}`,
			tool_choice: 'none',
		});
	}

	async function connect() {
		if (peerConnection) {
			disconnect();
			return;
		}

		connectButton.disabled = true;
		setState('connecting', 'Connecting…');
		assistantText.textContent = 'Starting the conversational IDE.';

		try {
			const sessionEpoch = ++sessionEpochSequence;
			activeSessionEpoch = sessionEpoch;
			const connection = new RTCPeerConnection();
			peerConnection = connection;
			connection.addEventListener('connectionstatechange', () => {
				if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
					return;
				}
				log('webrtc.connection', connection.connectionState);
				if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
					setState('error', 'Connection lost');
				}
			});
			connection.addEventListener('track', event => {
				if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
					return;
				}
				remoteAudio.srcObject = event.streams[0];
				void remoteAudio.play().catch(error => log('audio.play.error', error.message));
			});

			microphone = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
			connection.addTrack(microphone.getAudioTracks()[0], microphone);

			const channel = connection.createDataChannel('oai-events');
			dataChannel = channel;
			channel.addEventListener('open', () => {
				if (activeSessionEpoch !== sessionEpoch || dataChannel !== channel) {
					return;
				}
				setReadyState();
				connectButton.disabled = false;
				connectButton.textContent = 'Disconnect';
				muteButton.disabled = false;
				assistantText.textContent = 'Ask me to navigate or explain the workspace.';
				log('realtime.ready');
			});
			channel.addEventListener('message', event => {
				if (activeSessionEpoch === sessionEpoch && dataChannel === channel) {
					handleRealtimeEvent(JSON.parse(event.data), sessionEpoch);
				}
			});
			channel.addEventListener('close', () => log('realtime.closed'));

			const offer = await connection.createOffer();
			await connection.setLocalDescription(offer);
			const requestId = nextId('sdp');
			const answerPromise = new Promise((resolve, reject) => pendingSdp.set(requestId, { resolve, reject }));
			vscode.postMessage({ type: 'exchangeSdp', requestId, sdp: offer.sdp });
			const answerSdp = await answerPromise;
			if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
				return;
			}
			await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
		} catch (error) {
			log('connect.error', error.message);
			assistantText.textContent = error.message;
			setState('error', 'Could not connect');
			disconnect(false);
			connectButton.disabled = false;
		}
	}

	function disconnect(updateCopy = true) {
		microphone?.getTracks().forEach(track => track.stop());
		dataChannel?.close();
		peerConnection?.close();
		microphone = undefined;
		microphoneMuted = false;
		dataChannel = undefined;
		peerConnection = undefined;
		activeSessionEpoch = undefined;
		pinnedToolAnswer = false;
		awaitingToolFollowup = false;
		responseInProgress = false;
		responseCreateRequested = false;
		activeRouteRequestId = undefined;
		handledCalls.clear();
		pendingTools.clear();
		queuedResponses.length = 0;
		codeGenerationStreams.clear();
		for (const pending of pendingSdp.values()) {
			pending.reject(new Error('Connection cancelled.'));
		}
		pendingSdp.clear();
		connectButton.textContent = 'Connect';
		connectButton.disabled = false;
		muteButton.textContent = 'Mute';
		muteButton.title = 'Mute microphone';
		muteButton.setAttribute('aria-pressed', 'false');
		muteButton.disabled = true;
		if (updateCopy) {
			setState('idle', 'Disconnected');
			assistantText.textContent = 'Waiting to connect.';
		}
	}

	function handleRealtimeEvent(event, sessionEpoch) {
		log(event.type);
		switch (event.type) {
			case 'input_audio_buffer.speech_started':
				pinnedToolAnswer = false;
				userBuffer = '';
				setReadyState();
				break;
			case 'input_audio_buffer.speech_stopped':
				setState('thinking', 'Understanding…');
				break;
			case 'conversation.item.input_audio_transcription.delta':
				userBuffer += event.delta || '';
				userText.textContent = userBuffer;
				break;
			case 'conversation.item.input_audio_transcription.completed':
				userBuffer = event.transcript || userBuffer;
				userText.textContent = userBuffer;
				requestToolRoute(userBuffer);
				break;
			case 'response.created':
				responseInProgress = true;
				responseCreateRequested = false;
				assistantBuffer = '';
				setState('thinking', 'Thinking…');
				break;
			case 'response.output_audio_transcript.delta':
			case 'response.audio_transcript.delta':
			case 'response.output_text.delta':
				assistantBuffer += event.delta || '';
				if (!pinnedToolAnswer) {
					assistantText.textContent = assistantBuffer;
				}
				setState('speaking', 'Speaking');
				break;
			case 'response.done': {
				responseInProgress = false;
				responseCreateRequested = false;
				const responseStatus = event.response?.status || 'unknown';
				const responseReason = event.response?.status_details?.reason;
				log('response.done.detail', `${responseStatus}${responseReason ? ` ${responseReason}` : ''}`);
				if (pendingTools.size > 0) {
					setState('acting', 'Using the IDE…');
				} else {
					awaitingToolFollowup = false;
					setReadyState();
				}
				flushQueuedResponse();
				break;
			}
			case 'error':
				responseCreateRequested = false;
				assistantText.textContent = event.error?.message || 'Realtime returned an error.';
				setState('error', 'Realtime error');
				break;
		}
	}

	function dispatchTool(callId, name, args, sessionEpoch, conversationTurnId) {
		if (activeSessionEpoch !== sessionEpoch || !callId || handledCalls.has(callId)) {
			return;
		}
		handledCalls.add(callId);
		pendingTools.set(callId, sessionEpoch);
		const requestId = nextId('tool');
		const isCodeQuestion = name === 'ask_codebase';
		const isCodeGeneration = name === 'implement_change';
		if (isCodeGeneration) {
			codeGenerationStreams.set(callId, { activity: 'Starting the code-writing agent…', text: '', patches: new Map() });
		}
		setState('acting', isCodeQuestion ? 'Inspecting the codebase…' : isCodeGeneration ? 'Implementing…' : 'Using the IDE…');
		assistantText.textContent = isCodeQuestion ? 'Reading the relevant code…' : isCodeGeneration ? 'Making the requested change…' : 'Working in the editor…';
		log('tool.dispatch', `${name} ${args || '{}'}`);
		vscode.postMessage({
			type: 'executeTool',
			requestId,
			sessionEpoch,
			callId,
			conversationTurnId,
			name,
			arguments: args || '{}',
		});
	}

	function handleToolRoute(message) {
		if (message.sessionEpoch !== activeSessionEpoch || message.requestId !== activeRouteRequestId) {
			log('router.route.stale');
			return;
		}
		activeRouteRequestId = undefined;
		log('router.route.selected', message.name);
		dispatchTool(nextId('haiku-call'), message.name, message.arguments, message.sessionEpoch, message.conversationTurnId);
	}

	function handleRouteResponse(message) {
		if (message.sessionEpoch !== activeSessionEpoch || message.requestId !== activeRouteRequestId) {
			log('router.response.stale');
			return;
		}
		activeRouteRequestId = undefined;
		log('router.response');
		speakExact(message.spokenResponse);
	}

	function handleRouteError(message) {
		if (message.sessionEpoch !== activeSessionEpoch || message.requestId !== activeRouteRequestId) {
			log('router.error.stale');
			return;
		}
		activeRouteRequestId = undefined;
		assistantText.textContent = message.message;
		setState('error', 'Action selection failed');
		log('router.route.error', message.message);
	}

	function handleToolResult(message) {
		if (message.sessionEpoch !== activeSessionEpoch || pendingTools.get(message.callId) !== message.sessionEpoch) {
			log('tool.result.stale', message.callId || 'unknown call');
			return;
		}
		pendingTools.delete(message.callId);
		const codeStream = codeGenerationStreams.get(message.callId);
		codeGenerationStreams.delete(message.callId);
		awaitingToolFollowup = true;
		log('tool.result', JSON.stringify(message.result));
		pinnedToolAnswer = Boolean(message.result.display_response);
		const patches = codeStream ? [...codeStream.patches.values()].map(formatCodePatch) : [];
		assistantText.textContent = [message.result.spoken_response, ...patches].filter(Boolean).join('\n\n');
		speakExact(message.result.spoken_response);
	}

	function handleCodeGenerationProgress(message) {
		if (message.sessionEpoch !== activeSessionEpoch || pendingTools.get(message.callId) !== message.sessionEpoch) {
			log('code-generation.progress.stale', message.callId || 'unknown call');
			return;
		}
		if ((message.kind !== 'text' && message.kind !== 'tool' && message.kind !== 'code') || typeof message.text !== 'string' || (message.kind !== 'code' && !message.text)) {
			return;
		}

		const stream = codeGenerationStreams.get(message.callId);
		if (!stream) {
			return;
		}
		if (message.kind === 'text') {
			stream.text = `${stream.text}${message.text}`.slice(-4_000);
		} else if (message.kind === 'tool') {
			stream.activity = message.text;
			log('code-generation.progress', message.text);
		} else {
			const patchId = Number.isInteger(message.toolIndex) ? message.toolIndex : stream.patches.size;
			let patch = stream.patches.get(patchId);
			if (!patch) {
				patch = {
					file: message.file || 'workspace file',
					previousText: message.previousText,
					text: '',
				};
				stream.patches.set(patchId, patch);
			}
			patch.text += message.text;
		}
		const patches = [...stream.patches.values()].map(formatCodePatch);
		const output = [stream.activity, stream.text ? `${stream.text}▍` : '', ...patches].filter(Boolean).join('\n\n');
		assistantText.textContent = output;
	}

	function formatCodePatch(patch) {
		const header = patch.previousText === undefined ? `Writing ${patch.file}` : `Editing ${patch.file}`;
		const next = prefixLines('+ ', patch.text || '');
		if (patch.previousText === undefined) {
			return `${header}\n\n${next}`;
		}
		return `${header}\n\n${prefixLines('- ', patch.previousText)}\n${next}`;
	}

	function prefixLines(prefix, text) {
		return text.split('\n').map(line => `${prefix}${line}`).join('\n');
	}

	window.addEventListener('message', event => {
		const message = event.data;
		switch (message.type) {
			case 'sdpAnswer': {
				const pending = pendingSdp.get(message.requestId);
				pendingSdp.delete(message.requestId);
				pending?.resolve(message.sdp);
				break;
			}
			case 'requestError': {
				const pending = pendingSdp.get(message.requestId);
				pendingSdp.delete(message.requestId);
				pending?.reject(new Error(message.message));
				break;
			}
			case 'toolResult':
				handleToolResult(message);
				break;
			case 'toolRoute':
				handleToolRoute(message);
				break;
			case 'routeResponse':
				handleRouteResponse(message);
				break;
			case 'routeError':
				handleRouteError(message);
				break;
			case 'codeGenerationProgress':
				handleCodeGenerationProgress(message);
				break;
			case 'directResult':
				assistantText.textContent = message.result.spoken_response;
				log('direct.result', JSON.stringify(message.result));
				break;
		}
	});

	connectButton.addEventListener('click', () => void connect());
	muteButton.addEventListener('click', () => setMicrophoneMuted(!microphoneMuted));
	directButton.addEventListener('click', () => {
		const requestId = nextId('direct');
		log('direct.request');
		vscode.postMessage({ type: 'openCheckoutDirectly', requestId });
	});
	textForm.addEventListener('submit', event => {
		event.preventDefault();
		const text = textInput.value.trim();
		if (!text) {
			return;
		}
		try {
			pinnedToolAnswer = false;
			userText.textContent = text;
			requestToolRoute(text);
			textInput.value = '';
		} catch (error) {
			assistantText.textContent = error.message;
			log('text.error', error.message);
		}
	});
}());
