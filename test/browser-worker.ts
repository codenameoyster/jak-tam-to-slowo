import worker from '../src/index';
import { ONION_DRAFT, WORD_DRAFT } from './fixtures';
import { createOpenAI, responseStream } from './openai';

let provider: ReturnType<typeof createOpenAI> | undefined;
globalThis.fetch = async (input, init) => {
	const upstream = await (provider ??= createOpenAI());
	upstream.revokeStatus = 503;
	upstream.responses = async request => {
		const body = await request.json<{ input: { content: string }[] }>();
		const input = JSON.parse(body.input[0].content);
		if (input.text === 'ошибка подключения') return new Response('event: error\ndata: {"type":"error","code":"subscription_sharing_invalid_user"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
		if (input.text === 'лук' && !input.meaningRu) return responseStream({ kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] });
		return responseStream({ kind: 'draft', card: input.text === 'лук' ? ONION_DRAFT : WORD_DRAFT });
	};
	return upstream.fetch(input, init);
};

export default worker;
