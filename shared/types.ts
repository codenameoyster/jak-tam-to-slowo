export type Direction = 'ru-pl' | 'pl-ru';

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
