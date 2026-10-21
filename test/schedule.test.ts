import { expect, it } from 'vitest';
import type { Grade } from '../shared/types';
import { advance } from '../src/schedule';

const now = Date.parse('2026-10-21T10:00:00.000Z');

it.each([
	{ name: 'first correct', stage: 0, grade: 'correct', expectedStage: 1, delayMs: 86_400_000 },
	{ name: 'second correct', stage: 1, grade: 'correct', expectedStage: 2, delayMs: 259_200_000 },
	{ name: 'third correct', stage: 2, grade: 'correct', expectedStage: 3, delayMs: 604_800_000 },
	{ name: 'fourth correct', stage: 3, grade: 'correct', expectedStage: 4, delayMs: 1_209_600_000 },
	{ name: 'fifth correct', stage: 4, grade: 'correct', expectedStage: 5, delayMs: 2_592_000_000 },
	{ name: 'sixth correct', stage: 5, grade: 'correct', expectedStage: 6, delayMs: 5_184_000_000 },
	{ name: 'interval cap', stage: 6, grade: 'correct', expectedStage: 6, delayMs: 5_184_000_000 },
	{ name: 'spelling correction', stage: 4, grade: 'almost', expectedStage: 0, delayMs: 600_000 },
	{ name: 'forgotten learned word', stage: 6, grade: 'again', expectedStage: 0, delayMs: 60_000 },
] satisfies { name: string; stage: number; grade: Grade; expectedStage: number; delayMs: number }[])
('$name', ({ stage, grade, expectedStage, delayMs }) => {
	expect(advance(stage, grade, now)).toEqual({ stage: expectedStage, dueAt: now + delayMs });
});
