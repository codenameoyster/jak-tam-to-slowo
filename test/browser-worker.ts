import worker from '../src/index';
import { createOpenAI } from './openai';

let provider: ReturnType<typeof createOpenAI> | undefined;
globalThis.fetch = async (input, init) => {
	const upstream = await (provider ??= createOpenAI());
	upstream.revokeStatus = 503;
	return upstream.fetch(input, init);
};

export default worker;
