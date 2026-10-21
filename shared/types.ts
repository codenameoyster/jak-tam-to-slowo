export type Direction = 'ru-pl' | 'pl-ru';

export interface User {
	id: string;
	username: string;
	displayName: string;
	direction: Direction;
}
