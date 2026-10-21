import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { USER_A, USER_B } from './fixtures';

export function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}): Promise<Response> {
	const headers = new Headers({ Origin: options.origin ?? 'https://learn.rustatian.me' });
	if (options.cookie) headers.set('Cookie', options.cookie);
	if (options.body !== undefined) headers.set('Content-Type', 'application/json');
	return worker.fetch(new Request(`https://learn.rustatian.me${path}`, {
		method: options.method ?? 'GET', headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}), env);
}

export async function login(userId: string): Promise<string> {
	const user = [USER_A, USER_B].find(user => user.id === userId);
	if (!user) throw new Error('Unknown test user.');
	const response = await request('/api/session', { method: 'POST', body: { username: user.username, password: user.password } });
	if (response.status !== 200) throw new Error(`Login failed: ${response.status}`);
	return response.headers.get('Set-Cookie')!.split(';')[0];
}
