import type { Card, Direction, GradeResult } from '../shared/types';
import type { Env } from './index';
import { requestAiJson } from './ai';
import { HttpError, object, text } from './http';
import instructions from './prompts/grade.txt';

function normalized(value: string): string {
	return value.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function gradeAnswer(env: Env, card: Card, direction: Direction, answer: string): Promise<{ result: GradeResult; source: 'exact' | 'ai' }> {
	const correction = direction === 'ru-pl' ? card.pl : card.ru;
	const alternatives = direction === 'ru-pl' ? card.alternativesPl : card.alternativesRu;
	const value = normalized(answer);
	if (!value) return { result: { grade: 'again', correction, explanationRu: 'Ответ не указан. Повторите слово.' }, source: 'exact' };
	if ([correction, ...alternatives].some(term => normalized(term) === value)) {
		return { result: { grade: 'correct', correction, explanationRu: 'Верно.' }, source: 'exact' };
	}
	const response = await requestAiJson(env, instructions, { card, direction, answer });
	try {
		const data = object(response, ['grade', 'correction', 'explanationRu']);
		if (data.grade !== 'correct' && data.grade !== 'almost' && data.grade !== 'again') throw new Error('Invalid grade.');
		text(data.correction, 200);
		return { result: { grade: data.grade, correction, explanationRu: text(data.explanationRu, 500).trim() }, source: 'ai' };
	} catch { throw new HttpError(503, 'ai_invalid_response', 'ChatGPT вернул неверную оценку. Попробуйте снова.'); }
}
