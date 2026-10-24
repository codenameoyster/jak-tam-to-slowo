import type { DraftResult } from '../shared/types';
import type { Env } from './index';
import { requestAiJson } from './ai';
import { parseCard } from './cards';
import { HttpError, methods, object, readJson, text } from './http';
import instructions from './prompts/card.txt';

// The root must be an object, so the two reply kinds sit under result.
const string = { type: 'string' }, strings = { type: 'array', items: string };
const schema = { type: 'object', properties: { result: { anyOf: [
	{ type: 'object', properties: { kind: { type: 'string', enum: ['choices'] }, choices: strings }, required: ['kind', 'choices'], additionalProperties: false },
	{ type: 'object', properties: { kind: { type: 'string', enum: ['draft'] }, card: {
		type: 'object', properties: { pl: string, ru: string, examplePl: string, exampleRu: string, meaningRu: string, alternativesPl: { ...strings, minItems: 1 }, alternativesRu: strings },
		required: ['pl', 'ru', 'examplePl', 'exampleRu', 'meaningRu', 'alternativesPl', 'alternativesRu'], additionalProperties: false,
	} }, required: ['kind', 'card'], additionalProperties: false },
] } }, required: ['result'], additionalProperties: false };

export async function handleDraft(request: Request, env: Env): Promise<Response> {
	methods(request, ['POST']);
	const data = object(await readJson(request), ['text', 'meaningRu']);
	const input = { text: text(data.text, 200).trim(), ...('meaningRu' in data ? { meaningRu: text(data.meaningRu, 200).trim() } : {}) };
	const value = await requestAiJson(env, instructions, input, schema);
	let result: DraftResult;
	try {
		const data = object(object(value, ['result']).result, ['kind', 'card', 'choices']);
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
	} catch { throw new HttpError(503, 'ai_invalid_response', 'Model AI zwrócił nieprawidłową fiszkę. Spróbuj ponownie.'); }
	return Response.json(result);
}
