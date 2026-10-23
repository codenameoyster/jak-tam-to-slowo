type Handler = (request: Request) => Response | Promise<Response>;

export function message(value: unknown, stopReason = 'end_turn', content: unknown[] = [{ type: 'text', text: JSON.stringify(value) }]): Response {
	return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'request-id': 'req_test' } });
}

export function apiError(status: number, type: string): Response {
	return Response.json({ type: 'error', error: { type, message: 'private provider text' }, request_id: 'req_test' }, { status, headers: { 'request-id': 'req_test' } });
}

export function createProvider() {
	const provider = {
		messages: null as Handler | null,
		transcriptions: null as Handler | null,
		calls: [] as Request[],
		fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const request = new Request(input, init);
			provider.calls.push(request.clone());
			if (request.url === 'https://api.anthropic.com/v1/messages' && provider.messages) return provider.messages(request);
			if (request.url === 'https://api.openai.com/v1/audio/transcriptions' && provider.transcriptions) return provider.transcriptions(request);
			throw new Error('Unexpected provider request.');
		},
	};
	return provider;
}
