import worker, { type Env } from '../src/index';
import { ONION_DRAFT, WORD_DRAFT } from './fixtures';
import { createOpenAI, responseStream } from './openai';

let provider: ReturnType<typeof createOpenAI> | undefined;
globalThis.fetch = async (input, init) => {
	const upstream = await (provider ??= createOpenAI());
	upstream.revokeStatus = 503;
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
		const AI = new Proxy(env.AI, { get(target, key) {
			if (key === 'run') return async (model: string, input: { audio: string; language: string; task: string; vad_filter: boolean }) => {
				if (model !== '@cf/openai/whisper-large-v3-turbo' || input.audio !== 'AAH+/w==' || input.task !== 'transcribe' || !input.vad_filter) throw new Error('Unexpected test transcription input.');
				return { text: input.language === 'pl' ? ' słowo ' : ' слово ' };
			};
			return Reflect.get(target, key);
		} });
		const response = await worker.fetch(request, { ...env, AI });
		response.headers.set('X-Test-Provider-Calls', String(provider ? (await provider).calls.length : 0));
		return response;
	},
};
