import { useEffect, useRef, useState } from 'react';
import type { Direction, ReviewInput, ReviewResult, StudyBatch, StudyCard, User } from '../shared/types';
import { api, ApiError } from './api';

type State = 'loading' | 'answering' | 'checking' | 'feedback' | 'empty' | 'error';
interface Recovery {
	direction: Direction;
	cardId: string | null;
	answer: string;
	pending: string | null;
	retainedAnswer: string;
}
interface Session extends Recovery {
	queue: StudyCard[];
	state: State;
	feedback: ReviewResult | null;
	nextDueAt: number | null;
	error: string;
	savedDirection: Direction;
	savingDirection: boolean;
	expired: boolean;
}

function initial(user: User): Session {
	let recovery: Recovery | null = null;
	try { recovery = JSON.parse(sessionStorage.getItem(`study-draft:${user.id}`) ?? 'null'); } catch { recovery = null; }
	return {
		direction: user.direction, cardId: null, answer: '', pending: null, retainedAnswer: '', ...recovery,
		queue: [], state: recovery?.pending ? 'error' : 'loading', feedback: null, nextDueAt: null,
		error: recovery?.pending ? 'Сохранение ответа не подтверждено. Повторите запрос.' : '',
		savedDirection: user.direction, savingDirection: false, expired: false,
	};
}

export function useStudy(user: User) {
	const [session, setSession] = useState(() => initial(user));
	const live = useRef(session);
	const generation = useRef(0);
	const refill = useRef<symbol | null>(null);
	const retryAction = useRef<(() => void) | null>(null);
	const clockOffset = useRef(0);
	const key = `study-draft:${user.id}`;

	function update(value: Partial<Session>) {
		live.current = { ...live.current, ...value };
		setSession(live.current);
	}

	function persist(value: Recovery = live.current): boolean {
		try {
			const { direction, cardId, answer, pending, retainedAnswer } = value;
			if (answer || pending || retainedAnswer) sessionStorage.setItem(key, JSON.stringify({ direction, cardId, answer, pending, retainedAnswer }));
			else sessionStorage.removeItem(key);
			return true;
		} catch {
			update({ error: 'Браузер не сохранил ответ. Скопируйте текст и освободите место перед повтором.' });
			return false;
		}
	}

	function failed(error: unknown, fallback: string) {
		return { error: error instanceof ApiError ? error.message : fallback, expired: error instanceof ApiError && error.code === 'unauthorized' };
	}

	async function load() {
		const before = live.current;
		if (refill.current || before.queue.length >= 10 || before.pending || before.savingDirection) return;
		const version = generation.current, flight = Symbol();
		refill.current = flight;
		const excluded = before.queue.map(item => item.card.id);
		const params = new URLSearchParams({ direction: before.direction, limit: String(10 - excluded.length) });
		if (excluded.length) params.set('exclude', excluded.join(','));
		if (!before.queue.length && before.state !== 'feedback') update({ state: 'loading' });
		try {
			const batch = await api<StudyBatch>(`/study?${params}`);
			if (version !== generation.current) return;
			clockOffset.current = Date.now() - batch.serverTime;
			const current = live.current;
			const ids = new Set([...excluded, ...current.queue.map(item => item.card.id)]);
			let queue = [...current.queue];
			for (const item of batch.cards) {
				if (!ids.has(item.card.id) && queue.length < 10) queue.push(item);
				ids.add(item.card.id);
			}
			let { answer, cardId, retainedAnswer } = current;
			if (!current.queue.length && answer && !current.pending) {
				const recovered = queue.find(item => item.card.id === cardId);
				if (recovered) queue = [recovered, ...queue.filter(item => item !== recovered)];
				else { retainedAnswer = answer; answer = ''; cardId = null; }
			}
			const future = [batch.nextDueAt, current.nextDueAt].filter((time): time is number => time !== null && time > batch.serverTime);
			update({ queue, answer, cardId, retainedAnswer, nextDueAt: future.length ? Math.min(...future) : null, error: current.pending ? current.error : '',
				state: current.feedback ? 'feedback' : current.pending ? current.state : queue.length ? 'answering' : 'empty' });
			if (!current.pending) retryAction.current = null;
			persist();
		} catch (error) {
			if (version !== generation.current) return;
			retryAction.current = () => void load();
			update({ ...failed(error, 'Нет связи с сервером. Карточки остались в очереди. Повторите загрузку.'),
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
			if (session.nextDueAt === null || session.queue.length >= 10 || !['answering', 'empty'].includes(session.state) || document.visibilityState !== 'visible') return;
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
	}, [session.direction, session.nextDueAt, session.queue.length, session.state]);

	function setAnswer(answer: string) {
		const current = live.current;
		if (current.state !== 'answering' || current.pending || current.savingDirection) return;
		update({ answer, cardId: current.queue[0]?.card.id ?? null });
		persist();
	}

	async function setDirection(direction: Direction) {
		const current = live.current;
		if (direction === current.direction || current.pending || current.savingDirection) return;
		if ((current.answer || current.retainedAnswer) && !window.confirm('Сменить направление и удалить несохранённый ответ?')) return;
		const version = ++generation.current;
		refill.current = null;
		update({ savingDirection: true, error: '' });
		try {
			const saved = await api<User>('/me', { method: 'PATCH', body: JSON.stringify({ direction }) });
			if (version !== generation.current) return;
			update({ direction: saved.direction, savedDirection: saved.direction, queue: [], state: 'loading', feedback: null,
				answer: '', cardId: null, retainedAnswer: '', nextDueAt: null, savingDirection: false });
			retryAction.current = null;
			persist();
			void load();
		} catch (error) {
			if (version !== generation.current) return;
			retryAction.current = () => void setDirection(direction);
			update({ ...failed(error, 'Не удалось сохранить направление. Ответ остался в форме.'), savingDirection: false });
		}
	}

	async function submit(action: ReviewInput['action']) {
		const current = live.current, item = current.queue[0];
		if (current.state === 'checking' || current.state === 'feedback' || current.savingDirection || (!current.pending && !item)) return;
		const input: ReviewInput | null = current.pending ? null : {
			attemptId: crypto.randomUUID(), cardId: item.card.id, cardVersion: item.card.version,
			progressVersion: item.progress?.version ?? 0, direction: current.direction,
			...(action === 'answer' ? { action, answer: current.answer } : { action }),
		};
		const pending = current.pending ?? JSON.stringify(input);
		retryAction.current = () => void submit(action);
		if (!persist({ ...current, pending })) return;
		const version = generation.current;
		update({ pending, state: 'checking', error: '' });
		try {
			const feedback = await api<ReviewResult>('/reviews', { method: 'POST', body: pending });
			if (version !== generation.current) return;
			update({ feedback, state: 'feedback', pending: null, answer: '', cardId: null, retainedAnswer: '', error: '',
				nextDueAt: Math.min(live.current.nextDueAt ?? Infinity, feedback.progress.dueAt) });
			retryAction.current = null;
			persist();
		} catch (error) {
			if (version !== generation.current) return;
			if (error instanceof ApiError && (error.code === 'version_conflict' || error.code === 'review_conflict')) {
				generation.current++;
				refill.current = null;
				update({ pending: null, answer: '', cardId: null, retainedAnswer: current.answer || current.retainedAnswer,
					queue: [], state: 'loading', error: error.message });
				persist();
				void load();
			} else update({ ...failed(error, 'Нет связи с сервером. Сохранение ответа не подтверждено. Повторите запрос.'), state: 'error' });
		}
	}

	function next() {
		const current = live.current;
		if (current.state !== 'feedback') return;
		const queue = current.queue.filter(item => item.card.id !== current.feedback?.cardId);
		update({ queue, feedback: null, state: queue.length ? 'answering' : 'empty', error: '' });
		if (queue.length <= 3) void load();
	}

	return {
		current: session.queue[0] ?? null,
		remaining: session.queue.length - (session.feedback && session.queue[0]?.card.id === session.feedback.cardId ? 1 : 0),
		state: session.state, answer: session.answer, feedback: session.feedback, nextDueAt: session.nextDueAt, error: session.error,
		direction: session.direction, savedDirection: session.savedDirection, retainedAnswer: session.retainedAnswer,
		busy: session.state === 'checking' || session.savingDirection, locked: !!session.pending || session.savingDirection, expired: session.expired,
		setAnswer, setDirection, check: () => submit('answer'), reveal: () => submit('reveal'), next,
		retry: () => live.current.pending ? void submit('answer') : (retryAction.current ?? load)(),
	};
}
