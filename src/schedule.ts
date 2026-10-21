import type { Grade } from '../shared/types';

export function advance(stage: number, grade: Grade, now: number): { stage: number; dueAt: number } {
	if (grade !== 'correct') return { stage: 0, dueAt: now + (grade === 'almost' ? 600_000 : 60_000) };
	const next = Math.min(stage + 1, 6);
	return { stage: next, dueAt: now + [1, 3, 7, 14, 30, 60][next - 1] * 86_400_000 };
}
