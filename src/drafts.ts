import type { DraftResult } from '../shared/types';
import type { Env } from './index';
import { requestAiJson } from './ai';
import { parseCard } from './cards';
import { HttpError, methods, object, readJson, text } from './http';
import instructions from './prompts/card.txt';

export async function handleDraft(request: Request, env: Env): Promise<Response> {
	methods(request, ['POST']);
	const data = object(await readJson(request), ['text', 'language', 'meaningRu']);
	const input = { text: text(data.text, 200).trim(), language: data.language,
		...('meaningRu' in data ? { meaningRu: text(data.meaningRu, 200).trim() } : {}),
	};
	if (input.language !== 'pl' && input.language !== 'ru') throw new HttpError(400, 'invalid_input', 'Выберите польский или русский язык.');
	const value = await requestAiJson(env, instructions, input);
	let result: DraftResult;
	try {
		const data = object(value, ['kind', 'card', 'choices']);
		if (data.kind === 'draft') {
			object(data, ['kind', 'card']);
			result = { kind: 'draft', card: parseCard(data.card) };
		} else {
			object(data, ['kind', 'choices']);
			if (data.kind !== 'choices' || input.meaningRu || !Array.isArray(data.choices) || data.choices.length < 2 || data.choices.length > 8) throw new Error('Invalid choices.');
			const choices = data.choices.map(value => text(value, 200).trim());
			if (new Set(choices).size !== choices.length) throw new Error('Duplicate choices.');
			result = { kind: 'choices', choices };
		}
	} catch { throw new HttpError(503, 'ai_invalid_response', 'ChatGPT вернул неверную карточку. Попробуйте снова.'); }
	return Response.json(result);
}
