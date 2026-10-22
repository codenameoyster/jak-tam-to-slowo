export type Direction = 'ru-pl' | 'pl-ru';
export type Language = 'ru' | 'pl';
export type Grade = 'correct' | 'almost' | 'again';

export interface User {
	id: string;
	username: string;
	displayName: string;
	direction: Direction;
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

export interface Progress { stage: number; dueAt: number; version: number; lastReviewedAt: number }
export interface StudyCard { card: Card; progress: Progress | null }
export interface StudyBatch { cards: StudyCard[]; serverTime: number; nextDueAt: number | null }
export interface GradeResult { grade: Grade; correction: string; explanationRu: string }
export interface ReviewBase {
	attemptId: string;
	cardId: string;
	cardVersion: number;
	progressVersion: number;
	direction: Direction;
}
export type ReviewInput = ReviewBase & ({ action: 'answer'; answer: string } | { action: 'reveal' });
export interface ReviewResult extends GradeResult {
	attemptId: string;
	cardId: string;
	direction: Direction;
	source: 'exact' | 'ai' | 'reveal';
	progress: Progress;
}

export type DraftResult = { kind: 'choices'; choices: string[] } | { kind: 'draft'; card: CardContent };

export interface ConnectionView {
	connected: boolean;
	canManage: boolean;
	accountLabel: string | null;
	model: string | null;
	models: { slug: string; name: string }[];
	revocationConfirmed?: boolean;
}
