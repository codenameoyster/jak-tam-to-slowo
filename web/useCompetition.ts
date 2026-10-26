import { useCallback, useEffect, useRef, useState } from 'react';
import type { Competition, User } from '../shared/types';
import { api, ApiError } from './api';

type Action = 'invite' | 'accept' | 'cancel';

export interface CompetitionState {
	round: Competition | null;
	loading: boolean;
	readError: string;
	actionError: string;
	retryAction: Action | null;
	busy: boolean;
	refresh(): Promise<void>;
	invite(): Promise<void>;
	accept(): Promise<void>;
	cancel(): Promise<void>;
	retry(): Promise<void>;
}

type Methods = Pick<CompetitionState, 'refresh' | 'invite' | 'accept' | 'cancel' | 'retry'>;
const empty = { round: null, loading: false, readError: '', actionError: '', retryAction: null, busy: false };

export function useCompetition(user: User | null): CompetitionState {
	const userId = user?.id ?? null;
	const [state, setState] = useState<Omit<CompetitionState, keyof Methods> & { userId: string | null }>({ ...empty, userId: null });
	const methods = useRef<Methods | null>(null);
	const refresh = useCallback(async () => { await methods.current?.refresh(); }, []);
	const invite = useCallback(async () => { await methods.current?.invite(); }, []);
	const accept = useCallback(async () => { await methods.current?.accept(); }, []);
	const cancel = useCallback(async () => { await methods.current?.cancel(); }, []);
	const retry = useCallback(async () => { await methods.current?.retry(); }, []);

	useEffect(() => {
		setState({ ...empty, userId, loading: !!userId });
		if (!userId) return;
		let active = true, generation = 0, queued = false, busy = false;
		let round: Competition | null = null;
		let pending: { action: Action; id: string } | null = null;
		let flight: Promise<void> | null = null;
		function update(value: Partial<CompetitionState>) {
			if (active) setState(current => ({ ...current, ...value }));
		}
		function read(): Promise<void> {
			if (flight) return flight;
			flight = (async () => {
				do {
					queued = false;
					const version = generation;
					try {
						const saved = await api<Competition | null>('/competitions/current');
						if (!active || version !== generation) continue;
						if (!round || !saved || round.id !== saved.id || saved.version >= round.version) round = saved;
						update({ round, readError: '' });
						if (pending && (
							pending.action === 'invite' && saved && (saved.id === pending.id || saved.status === 'waiting' || saved.status === 'active') ||
							pending.action === 'accept' && saved?.id === pending.id && (saved.status === 'active' || saved.status === 'finished') ||
							pending.action === 'cancel' && saved?.id !== pending.id
						)) {
							pending = null;
							update({ actionError: '', retryAction: null });
						}
					} catch (error) {
						if (active && version === generation) update({ readError: error instanceof ApiError ? error.message : 'Nie udało się wczytać wyzwania. Sprawdź połączenie i spróbuj ponownie.' });
					}
				} while (active && queued);
				flight = null;
				update({ loading: false });
			})();
			return flight;
		}
		function refresh(): Promise<void> {
			// A write needs a read that starts after the write, even when a poll is still pending.
			generation++;
			queued = true;
			update({ loading: true });
			return read();
		}
		async function mutate(action: Action, id = action === 'invite' ? crypto.randomUUID() : round?.id): Promise<void> {
			if (busy || !active || !id) return;
			busy = true;
			generation++;
			pending = null;
			update({ busy: true, actionError: '', retryAction: null });
			try {
				await api<Competition>(action === 'invite' ? '/competitions' : `/competitions/${id}/${action}`, {
					method: 'POST', body: JSON.stringify(action === 'invite' ? { id } : {}),
				});
			} catch (error) {
				if (!active) return;
				if (!(error instanceof ApiError) || error.status >= 500) pending = { action, id };
				update({ retryAction: pending?.action ?? null, actionError: error instanceof ApiError ? error.message : 'Nie udało się zapisać wyzwania. Sprawdź połączenie i ponów próbę.' });
			} finally {
				if (active) {
					await refresh();
					busy = false;
					update({ busy: false });
				}
			}
		}
		methods.current = { refresh, invite: () => mutate('invite'), accept: () => mutate('accept'), cancel: () => mutate('cancel'),
			retry: async () => { if (pending) await mutate(pending.action, pending.id); } };
		function visible() { if (document.visibilityState === 'visible') void refresh(); }
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && !flight && !busy) void read();
		}, 5000);
		document.addEventListener('visibilitychange', visible);
		void refresh();
		return () => {
			active = false;
			methods.current = null;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', visible);
		};
	}, [userId]);

	return { ...(state.userId === userId ? state : { ...empty, loading: !!userId }), refresh, invite, accept, cancel, retry };
}
