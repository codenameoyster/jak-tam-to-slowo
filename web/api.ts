export class ApiError extends Error {
	constructor(public status: number, message: string, public code?: string, public reviewEditable = false) { super(message); }
}

let accountId = '';
export function setApiAccount(id: string | null) { accountId = id ?? ''; }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	const expectedAccount = accountId;
	if (path !== '/session' || (init.method && init.method !== 'GET' && init.method !== 'POST')) headers.set('X-Account-ID', expectedAccount);
	if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
	const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
	if (!response.ok) {
		const data = await response.json() as { error?: string; code?: string };
		if (expectedAccount && expectedAccount === accountId && (data.code === 'account_mismatch' || data.code === 'unauthorized')) window.dispatchEvent(new Event('session-ended'));
		throw new ApiError(response.status, data.error ?? 'Nie udało się wykonać żądania. Spróbuj ponownie.', data.code, response.headers.get('X-Review-Recovery') === 'editable');
	}
	return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
