import worker, { type Env } from '../src/index';
import { ONION_DRAFT, testBindings, WORD_DRAFT } from './fixtures';
import { apiError, createProvider, message } from './provider';

const provider = createProvider();
provider.transcriptions = async request => {
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
provider.messages = async request => {
	const body = await request.json<{ messages: { content: string }[] }>();
	const input = JSON.parse(body.messages[0].content);
	if (input.text === 'ошибка подключения' || input.answer === 'ошибка подключения') return apiError(401, 'authentication_error');
	if (input.answer === 'лимит') return apiError(429, 'rate_limit_error');
	if ('answer' in input) return message({ grade: input.answer === 'domu' ? 'almost' : 'again', explanation: 'Użyj formy słownikowej.' });
	if (input.text === 'лук' && !input.meaningRu) return message({ result: { kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] } });
	return message({ result: { kind: 'draft', card: input.text === 'лук' ? ONION_DRAFT : WORD_DRAFT } });
};
globalThis.fetch = provider.fetch;

export default {
	async fetch(request: Request, env: Env) {
		const response = await worker.fetch(request, env);
		response.headers.set('X-Test-Provider-Calls', String(provider.calls.length));
		return response;
	},
};
