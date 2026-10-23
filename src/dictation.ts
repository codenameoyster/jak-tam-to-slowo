import { DICTATION_MAX_BYTES, DICTATION_TYPES } from '../shared/dictation';
import { HttpError, methods, readBody } from './http';
import type { Env } from './index';

const unavailable = (message = 'Nie udało się rozpoznać mowy. Spróbuj ponownie lub wpisz tekst.') => new HttpError(503, 'dictation_unavailable', message);
const configurationMessage = 'Dyktowanie jest niedostępne. Poproś właściciela o sprawdzenie ustawień rozpoznawania mowy.';

export async function handleDictation(request: Request, env: Env): Promise<Response> {
	methods(request, ['POST']);
	const contentType = request.headers.get('Content-Type') ?? '';
	if (contentType.split(';')[0].trim() !== 'multipart/form-data') throw new HttpError(400, 'invalid_input', 'Wyślij nagranie w formacie multipart/form-data.');
	const upload = await readBody(request, DICTATION_MAX_BYTES, 'Nagranie jest za duże. Nagraj krótszy fragment.');
	let form: FormData;
	try { form = await new Response(upload, { headers: { 'Content-Type': contentType } }).formData(); }
	catch { throw new HttpError(400, 'invalid_input', 'Nie udało się odczytać nagrania. Nagraj ponownie.'); }
	const language = form.get('language'), clip = form.get('clip');
	if ([...form.keys()].length !== 2 || (language !== 'auto' && language !== 'pl' && language !== 'ru')) throw new HttpError(400, 'invalid_input', 'Podaj język: auto, pl lub ru.');
	if (!(clip instanceof File) || !clip.size || !DICTATION_TYPES.includes(clip.type.replace(/[\s"]/g, ''))) throw new HttpError(400, 'invalid_input', 'Wyślij niepuste nagranie WebM/Opus lub MP4/AAC.');
	if (!env.OPENAI_TRANSCRIPTION_API_KEY) throw unavailable(configurationMessage);
	const body = new FormData();
	body.set('file', clip, clip.type.startsWith('audio/mp4') ? 'recording.m4a' : 'recording.webm');
	body.set('model', 'gpt-transcribe');
	for (const hint of language === 'auto' ? ['pl', 'ru'] : [language]) body.append('languages[]', hint);
	const signal = AbortSignal.timeout(30_000);
	try {
		const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
			method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_TRANSCRIPTION_API_KEY}` }, body, signal, redirect: 'manual',
		});
		if (response.status === 401 || response.status === 403) throw unavailable(configurationMessage);
		if (response.status === 429) throw unavailable('Osiągnięto limit rozpoznawania mowy. Spróbuj później lub wpisz tekst.');
		if (!response.ok) throw unavailable();
		const result = await response.json<{ text?: unknown } | null>();
		if (typeof result?.text !== 'string') throw unavailable();
		const text = result.text.trim();
		if (!text) throw new HttpError(422, 'no_speech', 'Nie rozpoznano mowy. Nagraj ponownie lub wpisz tekst.');
		return Response.json({ text });
	} catch (error) {
		if (signal.aborted) throw unavailable('Rozpoznawanie mowy nie odpowiedziało na czas. Nagraj ponownie lub wpisz tekst.');
		throw error instanceof HttpError ? error : unavailable();
	}
}
