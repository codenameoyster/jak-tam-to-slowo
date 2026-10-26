import { useEffect, useRef, useState } from 'react';
import type { Card, Direction, ReviewInput, ReviewResult, StudyBatch, StudyCard, User } from '../shared/types';
import { api, ApiError } from './api';

type State = 'loading' | 'answering' | 'checking' | 'feedback' | 'empty' | 'error';
interface Recovery {
	direction: Direction;
	cardId: string | null;
	answer: string;
	pending: string | null;
	reviewedCard: Pick<Card, 'id' | 'version' | 'pl' | 'ru' | 'examplePl' | 'exampleRu'> | null;
	retainedAnswer: string;
}
interface Session extends Recovery {
	queue: StudyCard[];
	dueCount: number;
	state: State;
	feedback: ReviewResult | null;
	nextDueAt: number | null;
	error: string;
	savedDirection: Direction;
	savingDirection: boolean;
}

function initial(user: User): Session {
	let recovery: Recovery | null = null;
	try { recovery = JSON.parse(sessionStorage.getItem(`study-draft:${user.id}`) ?? 'null'); } catch { recovery = null; }
	return {
		direction: user.direction, cardId: null, answer: '', pending: null, reviewedCard: null, retainedAnswer: '', ...recovery,
		queue: [], dueCount: 0, state: recovery?.pending ? 'error' : 'loading', feedback: null, nextDueAt: null,
		error: recovery?.pending ? 'Zapis odpowiedzi nie został potwierdzony. Ponów żądanie.' : '',
		savedDirection: user.direction, savingDirection: false,
	};
}

export function useStudy(user: User, competitionId: string | null, onReview: (result: ReviewResult) => void) {
	const [session, setSession] = useState(() => initial(user));
	const live = useRef(session);
	const generation = useRef(0);
	const refill = useRef<symbol | null>(null);
	const retryAction = useRef<ReviewInput['action'] | (() => void) | null>(null);
	const clockOffset = useRef(0);
	const key = `study-draft:${user.id}`;

	function update(value: Partial<Session>) {
		live.current = { ...live.current, ...value };
		setSession(live.current);
	}

	function persist(value: Recovery = live.current): boolean {
		try {
			const { direction, cardId, answer, pending, reviewedCard, retainedAnswer } = value;
			if (answer || pending || retainedAnswer) sessionStorage.setItem(key, JSON.stringify({ direction, cardId, answer, pending, retainedAnswer, ...(pending ? { reviewedCard } : {}) }));
			else sessionStorage.removeItem(key);
			return true;
		} catch {
			update({ error: 'Przeglądarka nie zapisała odpowiedzi. Skopiuj tekst i zwolnij miejsce przed ponowną próbą.' });
			return false;
		}
	}

	function failed(error: unknown, fallback: string) {
		return error instanceof ApiError ? error.message : fallback;
	}

	async function load() {
		const before = live.current;
		if (refill.current || before.pending || before.savingDirection) return;
		const version = generation.current, flight = Symbol();
		refill.current = flight;
		if (!before.queue.length && before.state !== 'feedback') update({ state: 'loading' });
		try {
			const batch = await api<StudyBatch>('/study');
			if (version !== generation.current) return;
			clockOffset.current = Date.now() - batch.serverTime;
			const current = live.current;
			// The card on screen stays first. After feedback, the reviewed card leaves the queue.
			const head = current.state === 'feedback' ? undefined : current.queue[0];
			let queue = head ? [head, ...batch.cards.filter(item => item.card.id !== head.card.id)] : batch.cards;
			let { answer, cardId, retainedAnswer } = current;
			if (!current.queue.length && answer && !current.pending) {
				const recovered = queue.find(item => item.card.id === cardId);
				if (recovered) queue = [recovered, ...queue.filter(item => item !== recovered)];
				else { retainedAnswer = answer; answer = ''; cardId = null; }
			}
			update({ queue, dueCount: batch.dueCount, answer, cardId, retainedAnswer, nextDueAt: batch.nextDueAt, error: current.pending ? current.error : '',
				state: current.feedback ? 'feedback' : current.pending ? current.state : queue.length ? 'answering' : 'empty' });
			if (!current.pending) retryAction.current = null;
			persist();
		} catch (error) {
			if (version !== generation.current) return;
			retryAction.current = () => void load();
			update({ error: failed(error, 'Brak połączenia z serwerem. Fiszki zostały w kolejce. Ponów wczytywanie.'),
				state: live.current.queue.length ? live.current.state : 'error' });
		} finally { if (refill.current === flight) refill.current = null; }
	}

	useEffect(() => {
		if (!live.current.pending) void load();
		return () => { generation.current++; refill.current = null; };
	}, [user.id]);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		function refresh() {
			const current = live.current;
			if (document.visibilityState === 'visible' && (current.state === 'answering' || current.state === 'empty')) void load();
		}
		function schedule() {
			if (session.nextDueAt === null || !['answering', 'empty'].includes(session.state) || document.visibilityState !== 'visible') return;
			const delay = session.nextDueAt + clockOffset.current - Date.now();
			timer = setTimeout(delay > 2_147_483_647 ? schedule : refresh, Math.min(2_147_483_647, Math.max(0, delay)));
		}
		function visibility() {
			clearTimeout(timer);
			refresh();
			schedule();
		}
		schedule();
		document.addEventListener('visibilitychange', visibility);
		return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
	}, [session.nextDueAt, session.state]);

	function setAnswer(answer: string) {
		const current = live.current;
		if (current.state !== 'answering' || current.pending || current.savingDirection) return;
		update({ answer, cardId: current.queue[0]?.card.id ?? null });
		persist();
	}

	async function setDirection(direction: Direction) {
		const current = live.current;
		if (direction === current.direction || current.pending || current.savingDirection) return;
		if ((current.answer || current.retainedAnswer) && !window.confirm('Zmienić kierunek i usunąć niezapisaną odpowiedź?')) return;
		const version = generation.current;
		update({ savingDirection: true, error: current.queue.length ? '' : current.error });
		try {
			const saved = await api<User>('/me', { method: 'PATCH', body: JSON.stringify({ direction }) });
			if (version !== generation.current) return;
			// Both directions share the progress, so the same queue continues in the new direction.
			const queue = live.current.queue.filter(item => item.card.id !== live.current.feedback?.cardId);
			update({ direction: saved.direction, savedDirection: saved.direction, queue, state: queue.length ? 'answering' : 'loading', feedback: null, reviewedCard: null,
				answer: '', cardId: null, retainedAnswer: '', savingDirection: false });
			retryAction.current = null;
			persist();
			if (!queue.length) void load();
		} catch (error) {
			if (version !== generation.current) return;
			retryAction.current = () => void setDirection(direction);
			update({ error: failed(error, 'Nie udało się zmienić kierunku. Odpowiedź została w formularzu.'), savingDirection: false });
		}
	}

	async function submit(action: ReviewInput['action']) {
		const current = live.current, item = current.queue[0];
		if (current.state === 'checking' || current.state === 'feedback' || current.savingDirection || (!current.pending && !item)) return;
		if (!current.pending && action === 'answer' && current.answer.length > 500) {
			update({ error: 'Skróć odpowiedź do 500 znaków i sprawdź ponownie.' });
			return;
		}
		const input: ReviewInput | null = current.pending ? null : {
			attemptId: crypto.randomUUID(), cardId: item.card.id, cardVersion: item.card.version,
			progressVersion: item.progress?.version ?? 0, direction: current.direction,
			...(competitionId ? { competitionId } : {}),
			...(action === 'answer' ? { action, answer: current.answer } : { action }),
		};
		const pending = current.pending ?? JSON.stringify(input);
		const reviewedCard = current.pending ? current.reviewedCard : {
			id: item.card.id, version: item.card.version, pl: item.card.pl, ru: item.card.ru, examplePl: item.card.examplePl, exampleRu: item.card.exampleRu,
		};
		retryAction.current = action;
		if (!persist({ ...current, pending, reviewedCard })) return;
		const version = generation.current;
		update({ pending, reviewedCard, state: 'checking', error: '' });
		try {
			const feedback = await api<ReviewResult>('/reviews', { method: 'POST', body: pending });
			if (version !== generation.current) return;
			update({ feedback, state: 'feedback', pending: null, answer: '', cardId: null, retainedAnswer: '', error: '' });
			retryAction.current = null;
			persist();
			onReview(feedback);
			// The answer changes the order, so the queue is built again while the feedback shows.
			generation.current++;
			refill.current = null;
			void load();
		} catch (error) {
			if (version !== generation.current) return;
			if (error instanceof ApiError && (error.code === 'version_conflict' || error.code === 'review_conflict')) {
				generation.current++;
				refill.current = null;
				update({ pending: null, reviewedCard: null, answer: '', cardId: null, retainedAnswer: current.answer || current.retainedAnswer,
					queue: [], state: 'loading', error: error.message });
				persist();
				void load();
			} else if (error instanceof ApiError && error.reviewEditable) {
				const rejected: ReviewInput = JSON.parse(pending);
				update({ pending: null, reviewedCard: null, cardId: rejected.cardId, state: current.queue.length ? 'answering' : 'loading', error: error.message });
				persist();
				if (!current.queue.length) void load();
			} else update({ error: failed(error, 'Brak połączenia z serwerem. Zapis odpowiedzi nie został potwierdzony. Ponów żądanie.'), state: 'error' });
		}
	}

	function next() {
		const current = live.current;
		if (current.state !== 'feedback') return;
		const queue = current.queue.filter(item => item.card.id !== current.feedback?.cardId);
		update({ queue, feedback: null, reviewedCard: null, state: queue.length ? 'answering' : 'empty' });
	}

	return {
		current: session.queue[0] ?? null,
		reviewedCard: session.reviewedCard,
		dueCount: session.dueCount,
		state: session.state, answer: session.answer, feedback: session.feedback, nextDueAt: session.nextDueAt, error: session.error,
		direction: session.direction, savedDirection: session.savedDirection, retainedAnswer: session.retainedAnswer,
		busy: session.state === 'checking' || session.savingDirection, locked: !!session.pending || session.savingDirection,
		setAnswer, setDirection, check: () => submit('answer'), reveal: () => submit('reveal'), next,
		retry: () => {
			if (live.current.pending) void submit('answer');
			else if (typeof retryAction.current === 'string') void submit(retryAction.current);
			else (retryAction.current ?? load)();
		},
	};
}
