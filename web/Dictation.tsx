import { useLayoutEffect, useRef, useState } from 'react';
import { DICTATION_MAX_BYTES, DICTATION_TYPES, type DictationLanguage } from '../shared/dictation';
import { api, ApiError } from './api';
import { Icon } from './Icon';

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

export function Dictation({ language, onText, disabled = false }: {
	language: DictationLanguage; onText(text: string): void; disabled?: boolean;
}) {
	const active = useRef<Recording | null>(null);
	const onTextRef = useRef(onText);
	const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
	const [error, setError] = useState('');
	useLayoutEffect(() => { onTextRef.current = onText; }, [onText]);

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
			if (!clip.size) { fail('Nagranie jest puste. Nagraj ponownie lub wpisz tekst.'); return; }
			const form = new FormData();
			form.set('language', language);
			form.set('clip', clip, type.startsWith('audio/mp4') ? 'clip.m4a' : 'clip.webm');
			const encoded = new Response(form);
			const body = await encoded.blob();
			if (active.current !== recording) return;
			if (body.size > DICTATION_MAX_BYTES) { fail('Nagranie jest za duże. Nagraj krótszy fragment.'); return; }
			const result = await api<{ text: string }>('/dictation', { method: 'POST', body, headers: encoded.headers, signal: recording.controller.signal });
			if (active.current !== recording) return;
			onTextRef.current(result.text);
			cancel();
		} catch (error) {
			if (active.current !== recording) return;
			fail(error instanceof ApiError ? error.message : 'Nie udało się rozpoznać mowy. Nagraj ponownie lub wpisz tekst.');
		}
	}

	async function start() {
		if (disabled || active.current) return;
		setError('');
		const type = typeof MediaRecorder !== 'undefined' && DICTATION_TYPES.find(type => MediaRecorder.isTypeSupported(type));
		if (!type || !navigator.mediaDevices?.getUserMedia) { setError('Przeglądarka nie obsługuje formatu nagrania. Wpisz tekst.'); return; }
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
				if (recording.bytes > DICTATION_MAX_BYTES) { fail('Nagranie jest za duże. Nagraj krótszy fragment.'); return; }
				recording.chunks.push(event.data);
			};
			recorder.onerror = () => { if (active.current === recording) fail('Nie udało się nagrać dźwięku. Nagraj ponownie lub wpisz tekst.'); };
			recorder.onstop = () => { void transcribe(recording, recorder.mimeType); };
			recorder.start(1000);
			recording.timer = setTimeout(finish, 30_000);
			setState('recording');
		} catch (error) {
			if (active.current !== recording) return;
			fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Zezwól na dostęp do mikrofonu w przeglądarce lub wpisz tekst.' : 'Nie udało się nagrać dźwięku. Nagraj ponownie lub wpisz tekst.');
		}
	}

	function finish() {
		if (!active.current) return;
		stop(active.current);
		setState('transcribing');
	}

	return <>
		<p className="hint dictation-hint" hidden={state !== 'idle' || !!error}>Po dyktowaniu sprawdź i popraw tekst w polu.</p>
		<div className="dictation" data-state={state}>
			<div className="dictation-status" hidden={state === 'idle' && !error}>
				<p className="hint" aria-live="polite">{state === 'recording' ? 'Trwa nagrywanie. Najwyżej 30 sekund.' : state === 'requesting' ? 'Zezwól na dostęp do mikrofonu.' : state === 'transcribing' ? 'Rozpoznawanie mowy…' : ''}</p>
				{error && <p className="error" role="alert">{error}</p>}
				{state !== 'idle' && <button className="quiet" type="button" aria-label="Anuluj dyktowanie" onMouseDown={event => event.preventDefault()} onClick={cancel}>Anuluj</button>}
			</div>
			<button className="mic" type="button" aria-label={state === 'recording' ? 'Zatrzymaj nagrywanie' : 'Dyktuj'} disabled={disabled || state === 'requesting' || state === 'transcribing'} onMouseDown={event => event.preventDefault()} onClick={() => state === 'recording' ? finish() : void start()}><Icon name={state === 'recording' ? 'stop' : 'mic'} /></button>
		</div>
	</>;
}
