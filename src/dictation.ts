import { DICTATION_MAX_BYTES, DICTATION_TYPES } from '../shared/dictation';
import type { User } from '../shared/types';
import { HttpError, methods } from './http';
import type { Env } from './index';

export const handleDictation: (request: Request, env: Env, user: User) => Promise<Response> = async (request, env) => {
	methods(request, ['POST']);
	const contentType = request.headers.get('Content-Type') ?? '';
	if (contentType.split(';')[0].trim() !== 'multipart/form-data') throw new HttpError(400, 'invalid_input', 'Отправьте запись в формате multipart/form-data.');
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > DICTATION_MAX_BYTES) { await reader.cancel(); throw new HttpError(413, 'too_large', 'Запись слишком большая. Сделайте более короткую запись.'); }
			chunks.push(value);
		}
	}
	let form: FormData;
	try { form = await new Response(new Blob(chunks), { headers: { 'Content-Type': contentType } }).formData(); }
	catch { throw new HttpError(400, 'invalid_input', 'Не удалось прочитать запись. Повторите запись.'); }
	const language = form.get('language'), clip = form.get('clip');
	if ([...form.keys()].length !== 2 || (language !== 'pl' && language !== 'ru')) throw new HttpError(400, 'invalid_input', 'Выберите польский или русский язык.');
	if (!(clip instanceof File) || !clip.size || !DICTATION_TYPES.includes(clip.type.replace(/[\s"]/g, ''))) throw new HttpError(400, 'invalid_input', 'Отправьте непустую запись WebM/Opus или MP4/AAC.');
	let result;
	try {
		const bytes = new Uint8Array(await clip.arrayBuffer());
		let binary = '';
		for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
		result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
			audio: btoa(binary), language, task: 'transcribe', vad_filter: true,
		});
	} catch { throw new HttpError(503, 'dictation_unavailable', 'Не удалось распознать речь. Попробуйте снова или введите текст.'); }
	if (typeof result?.text !== 'string') throw new HttpError(503, 'dictation_unavailable', 'Не удалось распознать речь. Попробуйте снова или введите текст.');
	const text = result.text.trim();
	if (!text) throw new HttpError(422, 'no_speech', 'Речь не распознана. Повторите запись или введите текст.');
	return Response.json({ text });
};
