import { useCallback, useEffect, useRef, useState } from 'react';
import type { Competition, User } from '../shared/types';
import { api, ApiError } from './api';

export interface CompetitionState {
	round: Competition | null;
	loading: boolean;
	readError: string;
	actionError: string;
	busy: boolean;
	refresh(): Promise<void>;
	invite(): Promise<void>;
	accept(): Promise<void>;
	cancel(): Promise<void>;
}

type Methods = Pick<CompetitionState, 'refresh' | 'invite' | 'accept' | 'cancel'>;
const empty = { round: null, loading: false, readError: '', actionError: '', busy: false };

export function useCompetition(user: User | null): CompetitionState {
	const userId = user?.id ?? null;
	const [state, setState] = useState<Omit<CompetitionState, keyof Methods> & { userId: string | null }>({ ...empty, userId: null });
	const methods = useRef<Methods | null>(null);
	const refresh = useCallback(async () => { await methods.current?.refresh(); }, []);
	const invite = useCallback(async () => { await methods.current?.invite(); }, []);
	const accept = useCallback(async () => { await methods.current?.accept(); }, []);
	const cancel = useCallback(async () => { await methods.current?.cancel(); }, []);

	useEffect(() => {
		setState({ ...empty, userId, loading: !!userId });
		if (!userId) return;
		let active = true, generation = 0, queued = false, busy = false;
		let round: Competition | null = null, invitationId: string | null = null;
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
						if (invitationId && round && (round.id === invitationId || round.status === 'waiting' || round.status === 'active')) {
							invitationId = null;
							update({ actionError: '' });
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
		async function mutate(action: 'invite' | 'accept' | 'cancel'): Promise<void> {
			if (busy || !active || (action !== 'invite' && !round)) return;
			busy = true;
			generation++;
			update({ busy: true, actionError: '' });
			try {
				if (action === 'invite') invitationId ??= crypto.randomUUID();
				await api<Competition>(action === 'invite' ? '/competitions' : `/competitions/${round!.id}/${action}`, {
					method: 'POST', body: JSON.stringify(action === 'invite' ? { id: invitationId } : {}),
				});
				if (!active) return;
				invitationId = null;
			} catch (error) {
				if (!active) return;
				if (error instanceof ApiError && error.status < 500) invitationId = null;
				update({ actionError: error instanceof ApiError ? error.message : 'Nie udało się zapisać wyzwania. Sprawdź połączenie i ponów próbę.' });
			} finally {
				if (active) {
					await refresh();
					busy = false;
					update({ busy: false });
				}
			}
		}
		methods.current = { refresh, invite: () => mutate('invite'), accept: () => mutate('accept'), cancel: () => mutate('cancel') };
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

	return { ...(state.userId === userId ? state : { ...empty, loading: !!userId }), refresh, invite, accept, cancel };
}
