import { useEffect, useRef } from 'react';
import type { Direction, User } from '../shared/types';
import { useStudy } from './useStudy';
import { Dictation, dictatedValue } from './Dictation';

export function Study({ user, onDirection, onBusy, onExpired }: {
	user: User; onDirection(direction: Direction): void; onBusy(busy: boolean): void; onExpired(): void;
}) {
	const study = useStudy(user);
	const input = useRef<HTMLInputElement>(null);
	const nextButton = useRef<HTMLButtonElement>(null);
	const polish = study.direction === 'ru-pl';
	const target = polish ? 'pl' : 'ru';
	const current = study.reviewedCard ?? study.current?.card;
	const grade = study.feedback && { correct: 'Верно', almost: 'Почти верно', again: 'Повторите' }[study.feedback.grade];

	useEffect(() => { onDirection(study.savedDirection); }, [study.savedDirection, onDirection]);
	useEffect(() => { onBusy(study.busy); }, [study.busy, onBusy]);
	useEffect(() => { if (study.expired) onExpired(); }, [study.expired, onExpired]);
	useEffect(() => {
		if (navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches) return;
		if (study.state === 'answering') input.current?.focus();
		if (study.state === 'feedback') nextButton.current?.focus();
	}, [study.state, current?.id]);

	return <section className="page study" aria-labelledby="study-title">
		<div className="page-heading"><h1 id="study-title">Учить слова</h1><p className="hint" data-testid="study-remaining">В очереди: {study.remaining}</p></div>
		<div className="directions" role="group" aria-label="Направление перевода">
			<button aria-label="RU -> PL" aria-pressed={polish} disabled={study.locked} onClick={() => void study.setDirection('ru-pl')}>Русский <span aria-hidden="true">→</span> Польский</button>
			<button aria-label="PL -> RU" aria-pressed={!polish} disabled={study.locked} onClick={() => void study.setDirection('pl-ru')}>Польский <span aria-hidden="true">→</span> Русский</button>
		</div>
		{study.busy && study.state !== 'checking' && <p role="status">Сохранение направления…</p>}
		{study.state === 'loading' && <p role="status">Загрузка карточек…</p>}
		{current && <div className="study-prompt">
			<h2 className="study-term" data-testid="study-term" lang={polish ? 'ru' : 'pl'}>{polish ? current.ru : current.pl}</h2>
			<p className="study-example" lang={polish ? 'ru' : 'pl'}>{polish ? current.exampleRu : current.examplePl}</p>
		</div>}
		{study.state !== 'feedback' && (current || study.locked) && <form onSubmit={event => { event.preventDefault(); void study.check(); }}>
			<label htmlFor="study-answer">{polish ? 'Ответ по-польски' : 'Ответ по-русски'}</label>
			<input ref={input} id="study-answer" lang={target} maxLength={500} autoComplete="off" value={study.answer} disabled={study.locked} onChange={event => study.setAnswer(event.target.value)} />
			<Dictation key={`${current?.id}:${current?.version}`} language={target} disabled={study.locked || study.state !== 'answering'} onExpired={onExpired} onText={text => { if (input.current) study.setAnswer(dictatedValue(input.current, text)); }} />
			<div className="study-actions">
				<button className="primary" type="submit" disabled={study.locked || study.state !== 'answering'}>Проверить</button>
				<button type="button" disabled={study.locked || study.state !== 'answering'} onClick={() => void study.reveal()}>Показать ответ</button>
			</div>
		</form>}
		{study.state === 'checking' && <p role="status">Проверяем ответ…</p>}
		{study.feedback && <>
			<div className={`study-feedback ${study.feedback.grade}`} role="status" aria-atomic="true">
				<h2>{grade}</h2>
				<p className="study-correction" data-testid="study-correction" lang={target}>{study.feedback.correction}</p>
				{current && <p className="study-example" lang={target}>{polish ? current.examplePl : current.exampleRu}</p>}
				<p>{study.feedback.explanationRu}</p>
			</div>
			<button ref={nextButton} className="primary" onClick={study.next}>Дальше</button>
		</>}
		{study.state === 'empty' && <div role="status">
			<p>{study.nextDueAt ? 'На сегодня всё готово.' : 'Добавьте слово, чтобы начать.'}</p>
			{study.nextDueAt && <p className="hint">Следующее повторение: <time dateTime={new Date(study.nextDueAt).toISOString()}>{new Date(study.nextDueAt).toLocaleString('ru-RU')}</time></p>}
		</div>}
		{study.retainedAnswer && <div className="study-recovery">
			<p className="hint">Карточка или результат изменились. Скопируйте сохранённый ответ, если он нужен для новой попытки.</p>
			<label htmlFor="retained-answer">Сохранённый ответ</label>
			<textarea id="retained-answer" readOnly value={study.retainedAnswer} />
		</div>}
		{study.error && <div className="notice">
			<p className="error" role="alert">{study.error}</p>
			<button disabled={study.busy} onClick={() => void study.retry()}>Повторить</button>
		</div>}
	</section>;
}
