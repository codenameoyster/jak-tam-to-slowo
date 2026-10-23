import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { HttpError } from './http';

const unconfigured = () => new HttpError(503, 'ai_unavailable', 'ИИ не настроен. Попросите владельца проверить ключ API.');
const invalid = () => new HttpError(503, 'ai_invalid_response', 'ИИ вернул неверный ответ. Попробуйте снова.');

export async function requestAiJson(env: Env, instructions: string, input: unknown, schema: Record<string, unknown>): Promise<unknown> {
	let requestId: string | null | undefined;
	try {
		if (!env.ANTHROPIC_API_KEY) throw unconfigured();
		const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 0 });
		const message = await client.messages.create({
			model: 'claude-sonnet-5-5', max_tokens: 16_000, system: instructions, messages: [{ role: 'user', content: JSON.stringify(input) }],
			output_config: { effort: 'high', format: { type: 'json_schema', schema } },
		});
		requestId = message._request_id;
		if (message.stop_reason === 'refusal') throw new HttpError(503, 'ai_refused', 'ИИ отказался отвечать. Измените запрос.');
		if (message.stop_reason !== 'end_turn') throw invalid();
		// Thinking blocks can come before the text.
		try { return JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('')); } catch { throw invalid(); }
	} catch (cause) {
		// handleReview marks only an HttpError as editable, so every failure becomes one.
		const error = cause instanceof HttpError ? cause
			: cause instanceof Anthropic.AuthenticationError || cause instanceof Anthropic.PermissionDeniedError ? unconfigured()
			: cause instanceof Anthropic.RateLimitError ? new HttpError(429, 'ai_limit', 'Достигнут лимит ИИ. Повторите позже.')
			: cause instanceof Anthropic.APIConnectionTimeoutError ? new HttpError(503, 'ai_timeout', 'ИИ не ответил вовремя. Попробуйте снова.')
			: new HttpError(503, 'ai_unavailable', 'ИИ сейчас недоступен. Попробуйте снова.');
		if (cause instanceof Anthropic.APIError) requestId = cause.requestID;
		const providerStatus = cause instanceof Anthropic.APIError ? cause.status ?? null : null;
		console.error(JSON.stringify({ event: 'ai_failed', status: error.status, code: error.code, providerStatus, requestId: requestId ?? null }));
		throw error;
	}
}
