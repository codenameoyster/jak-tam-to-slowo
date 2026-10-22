import worker, { type Env } from '../src/index';
import { ONION_DRAFT, testBindings, WORD_DRAFT } from './fixtures';
import { createOpenAI, responseStream } from './openai';

let provider: ReturnType<typeof createOpenAI> | undefined;
globalThis.fetch = async (input, init) => {
	const upstream = await (provider ??= createOpenAI());
	upstream.revokeStatus = 503;
	upstream.transcriptions = async request => {
		const body = await request.formData(), file = body.get('file'), language = body.get('languages[]');
		if (request.headers.get('Authorization') !== `Bearer ${testBindings.OPENAI_TRANSCRIPTION_API_KEY}` || request.method !== 'POST' || request.redirect !== 'manual'
			|| [...body.keys()].sort().join(',') !== 'file,languages[],model' || body.get('model') !== 'gpt-transcribe' || (language !== 'pl' && language !== 'ru')
			|| !(file instanceof File) || file.name !== (file.type.startsWith('audio/mp4') ? 'recording.m4a' : 'recording.webm')
			|| [...new Uint8Array(await file.arrayBuffer())].join(',') !== '0,1,254,255') throw new Error('Unexpected test transcription input.');
		return Response.json({ text: language === 'pl' ? ' słowo ' : ' слово ', languages: [{ code: language }] });
	};
	upstream.responses = async request => {
		const body = await request.json<{ input: { content: string }[] }>();
		const input = JSON.parse(body.input[0].content);
		if (input.text === 'ошибка подключения' || input.answer === 'ошибка подключения') return new Response('event: error\ndata: {"type":"error","code":"subscription_sharing_invalid_user"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
		if (input.answer === 'лимит') return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 });
		if ('answer' in input) return responseStream({ grade: input.answer === 'domu' ? 'almost' : 'again', correction: input.card[input.direction === 'ru-pl' ? 'pl' : 'ru'], explanationRu: 'Используйте словарную форму.' });
		if (input.text === 'лук' && !input.meaningRu) return responseStream({ kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] });
		return responseStream({ kind: 'draft', card: input.text === 'лук' ? ONION_DRAFT : WORD_DRAFT });
	};
	return upstream.fetch(input, init);
};

export default {
	async fetch(request: Request, env: Env) {
		const response = await worker.fetch(request, env);
		response.headers.set('X-Test-Provider-Calls', String(provider ? (await provider).calls.length : 0));
		return response;
	},
};
