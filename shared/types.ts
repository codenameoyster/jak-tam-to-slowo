export type Direction = 'ru-pl' | 'pl-ru';
export type Language = 'ru' | 'pl';
export type Grade = 'correct' | 'almost' | 'again';

export interface User {
	id: string;
	username: string;
	displayName: string;
	direction: Direction;
}

export const COMPETITION_TARGET = 20;
export type CompetitionStatus = 'waiting' | 'active' | 'finished' | 'cancelled';
export interface CompetitionParticipant { id: string; displayName: string; score: number }
export interface Competition {
	id: string;
	participants: [CompetitionParticipant, CompetitionParticipant];
	createdBy: string;
	target: number;
	status: CompetitionStatus;
	winnerId: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	version: number;
}

export interface CardContent {
	pl: string;
	ru: string;
	examplePl: string;
	exampleRu: string;
	meaningRu: string;
	alternativesPl: string[];
	alternativesRu: string[];
}

export interface Card extends CardContent {
	id: string;
	version: number;
	archived: boolean;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface CardPage { cards: Card[]; nextCursor: string | null }

export interface Progress { correct: number; incorrect: number; lastCorrectAt: number | null; lastIncorrectAt: number | null; version: number }
export interface StudyCard { card: Card; progress: Progress | null }
export interface StudyBatch { cards: StudyCard[]; dueCount: number; serverTime: number; nextDueAt: number | null }
export interface GradeResult { grade: Grade; correction: string; explanation: string }
export interface ReviewBase {
	attemptId: string;
	cardId: string;
	cardVersion: number;
	progressVersion: number;
	direction: Direction;
	competitionId?: string;
}
export type ReviewInput = ReviewBase & ({ action: 'answer'; answer: string } | { action: 'reveal' });
export interface CompetitionContribution {
	competitionId: string;
	delta: -1 | 0 | 1;
	scoreAfter: number;
	version: number;
}
export interface ReviewResult extends GradeResult {
	attemptId: string;
	cardId: string;
	direction: Direction;
	source: 'exact' | 'ai' | 'reveal';
	progress: Progress;
	competition: CompetitionContribution | null;
}

export type DraftResult = { kind: 'choices'; choices: string[] } | { kind: 'draft'; card: CardContent };
