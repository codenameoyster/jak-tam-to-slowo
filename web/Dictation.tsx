import { useLayoutEffect, useRef, useState } from 'react';
import { DICTATION_MAX_BYTES, DICTATION_TYPES } from '../shared/dictation';
import type { Language } from '../shared/types';
import { api, ApiError } from './api';

interface Recording {
	controller: AbortController;
	chunks: Blob[];
	bytes: number;
	stream?: MediaStream;
	recorder?: MediaRecorder;
	timer?: ReturnType<typeof setTimeout>;
}

export function dictatedValue(field: HTMLInputElement, transcript: string): string {
	const { value, selectionStart: start, selectionEnd: end } = field;
	if (start !== null && end !== null && start < end) return value.slice(0, start) + transcript + value.slice(end);
	return value ? `${value} ${transcript}` : transcript;
}

export function Dictation({ language, onText, disabled = false, onExpired }: {
	language: Language; onText(text: string): void; disabled?: boolean; onExpired?(): void;
}) {
	const active = useRef<Recording | null>(null);
	const callbacks = useRef({ onText, onExpired });
	const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
	const [error, setError] = useState('');
	useLayoutEffect(() => { callbacks.current = { onText, onExpired }; }, [onText, onExpired]);

	function stop(recording: Recording) {
		clearTimeout(recording.timer);
		if (recording.recorder?.state === 'recording') recording.recorder.stop();
		recording.stream?.getTracks().forEach(track => track.stop());
		recording.stream = undefined;
	}

	function release() {
		const recording = active.current;
		active.current = null;
		if (!recording) return;
		recording.controller.abort();
		stop(recording);
		recording.chunks = [];
	}

	function cancel() { release(); setState('idle'); }
	function fail(message: string) { cancel(); setError(message); }

	useLayoutEffect(() => {
		setState('idle');
		setError('');
		function hidden() { if (document.visibilityState === 'hidden') cancel(); }
		document.addEventListener('visibilitychange', hidden);
		window.addEventListener('pagehide', cancel);
		return () => {
			release();
			document.removeEventListener('visibilitychange', hidden);
			window.removeEventListener('pagehide', cancel);
		};
	}, [language, disabled]);

	async function transcribe(recording: Recording, type: string) {
		if (active.current !== recording) return;
		stop(recording);
		setState('transcribing');
		try {
			const clip = new Blob(recording.chunks, { type });
			recording.chunks = [];
			if (!clip.size) { fail('Запись пустая. Повторите запись или введите текст.'); return; }
			const form = new FormData();
			form.set('language', language);
			form.set('clip', clip, type.startsWith('audio/mp4') ? 'clip.m4a' : 'clip.webm');
			const encoded = new Response(form);
			const body = await encoded.blob();
			if (active.current !== recording) return;
			if (body.size > DICTATION_MAX_BYTES) { fail('Запись слишком большая. Сделайте более короткую запись.'); return; }
			const result = await api<{ text: string }>('/dictation', { method: 'POST', body, headers: encoded.headers, signal: recording.controller.signal });
			if (active.current !== recording) return;
			callbacks.current.onText(result.text);
			cancel();
		} catch (error) {
			if (active.current !== recording) return;
			fail(error instanceof ApiError ? error.message : 'Не удалось распознать речь. Повторите запись или введите текст.');
			if (error instanceof ApiError && error.code === 'unauthorized') callbacks.current.onExpired?.();
		}
	}

	async function start() {
		if (disabled || active.current) return;
		setError('');
		const type = typeof MediaRecorder !== 'undefined' && DICTATION_TYPES.find(type => MediaRecorder.isTypeSupported(type));
		if (!type || !navigator.mediaDevices?.getUserMedia) { setError('Браузер не поддерживает формат записи. Введите текст.'); return; }
		const recording: Recording = { controller: new AbortController(), chunks: [], bytes: 0 };
		active.current = recording;
		setState('requesting');
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (active.current !== recording) { stream.getTracks().forEach(track => track.stop()); return; }
			recording.stream = stream;
			const recorder = recording.recorder = new MediaRecorder(stream, { mimeType: type });
			recorder.ondataavailable = event => {
				if (active.current !== recording) return;
				recording.bytes += event.data.size;
				if (recording.bytes > DICTATION_MAX_BYTES) { fail('Запись слишком большая. Сделайте более короткую запись.'); return; }
				recording.chunks.push(event.data);
			};
			recorder.onerror = () => { if (active.current === recording) fail('Не удалось записать звук. Повторите запись или введите текст.'); };
			recorder.onstop = () => { void transcribe(recording, recorder.mimeType); };
			recorder.start(1000);
			recording.timer = setTimeout(finish, 30_000);
			setState('recording');
		} catch (error) {
			if (active.current !== recording) return;
			fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону в браузере или введите текст.' : 'Не удалось записать звук. Повторите запись или введите текст.');
		}
	}

	function finish() {
		if (!active.current) return;
		stop(active.current);
		setState('transcribing');
	}

	return <div className="dictation">
		<div className="dictation-actions">
			{state === 'recording' ? <button type="button" onClick={finish}>Завершить запись</button> : <button type="button" disabled={disabled || state !== 'idle'} onClick={() => void start()}>Диктовать</button>}
			{state !== 'idle' && <button type="button" onClick={cancel}>Отменить диктовку</button>}
		</div>
		<p className="hint" aria-live="polite">{state === 'recording' ? 'Идёт запись. Не более 30 секунд.' : state === 'requesting' ? 'Разрешите доступ к микрофону.' : state === 'transcribing' ? 'Распознаём речь…' : 'После диктовки проверьте и измените текст в поле.'}</p>
		{error && <p className="error" role="alert">{error}</p>}
	</div>;
}
