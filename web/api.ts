export class ApiError extends Error {
	constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
	const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
	if (!response.ok) {
		const data = await response.json() as { error?: string };
		throw new ApiError(response.status, data.error ?? 'Не удалось выполнить запрос. Попробуйте снова.');
	}
	return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
