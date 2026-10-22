import worker, { type Env } from '../src/index';
import { ONION_DRAFT, testBindings, WORD_DRAFT } from './fixtures';
import { createOpenAI, responseStream } from './openai';

let provider: ReturnType<typeof createOpenAI> | undefined;
globalThis.fetch = async (input, init) => {
	const upstream = await (provider ??= createOpenAI());
	upstream.revokeStatus = 503;
	upstream.transcriptions = async request => {
		const body = await request.formData(), file = body.get('file'), languages = body.getAll('languages[]').join(',');
		const automatic = languages === 'pl,ru';
		if (request.headers.get('Authorization') !== `Bearer ${testBindings.OPENAI_TRANSCRIPTION_API_KEY}` || request.method !== 'POST' || request.redirect !== 'manual'
			|| [...body.keys()].sort().join(',') !== (automatic ? 'file,languages[],languages[],model' : 'file,languages[],model')
			|| body.get('model') !== 'gpt-transcribe' || (!automatic && languages !== 'pl' && languages !== 'ru')
			|| !(file instanceof File) || file.name !== (file.type.startsWith('audio/mp4') ? 'recording.m4a' : 'recording.webm')) throw new Error('Unexpected test transcription input.');
		const bytes = [...new Uint8Array(await file.arrayBuffer())].join(',');
		if (bytes !== '0,1,254,255' && (!automatic || bytes !== '1,2,253,254')) throw new Error('Unexpected test audio bytes.');
		return Response.json({ text: languages === 'ru' || bytes === '1,2,253,254' ? ' слово ' : ' słowo ', languages: [{ code: automatic ? 'pl' : languages }] });
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
