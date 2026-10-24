import { useEffect, useRef } from 'react';
import type { Direction, User } from '../shared/types';
import { useStudy } from './useStudy';
import { Dictation, dictatedValue } from './Dictation';
import { Icon } from './Icon';

export function Study({ user, onDirection, onBusy }: {
	user: User; onDirection(direction: Direction): void; onBusy(busy: boolean): void;
}) {
	const study = useStudy(user);
	const input = useRef<HTMLInputElement>(null);
	const nextButton = useRef<HTMLButtonElement>(null);
	const polish = study.direction === 'ru-pl';
	const target = polish ? 'pl' : 'ru';
	const current = study.reviewedCard ?? study.current?.card;
	const grade = study.feedback && { correct: 'Dobrze', almost: 'Prawie dobrze', again: 'Powtórz' }[study.feedback.grade];

	useEffect(() => { onDirection(study.savedDirection); }, [study.savedDirection, onDirection]);
	useEffect(() => { onBusy(study.busy); }, [study.busy, onBusy]);
	useEffect(() => {
		if (navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches) return;
		if (study.state === 'answering') input.current?.focus();
		if (study.state === 'feedback') nextButton.current?.focus();
	}, [study.state, current?.id]);

	return <section className="page study" aria-labelledby="study-title">
		<div className="page-heading"><h1 id="study-title">Nauka słówek</h1><p className="hint" data-testid="study-remaining">W kolejce: {study.dueCount}</p></div>
		<div className="directions" role="group" aria-label="Kierunek tłumaczenia">
			<button aria-label="RU -> PL" aria-pressed={polish} disabled={study.locked} onClick={() => void study.setDirection('ru-pl')}>Rosyjski <span aria-hidden="true">→</span> Polski</button>
			<button aria-label="PL -> RU" aria-pressed={!polish} disabled={study.locked} onClick={() => void study.setDirection('pl-ru')}>Polski <span aria-hidden="true">→</span> Rosyjski</button>
		</div>
		{study.state === 'loading' && <p role="status">Wczytywanie fiszek…</p>}
		{current && <div className="study-prompt">
			<h2 className="study-term" data-testid="study-term" lang={polish ? 'ru' : 'pl'}>{polish ? current.ru : current.pl}</h2>
			<p className="study-example" lang={polish ? 'ru' : 'pl'}>{polish ? current.exampleRu : current.examplePl}</p>
		</div>}
		{study.state !== 'feedback' && (current || study.locked) && <form onSubmit={event => { event.preventDefault(); void study.check(); }}>
			<label htmlFor="study-answer">{polish ? 'Odpowiedź po polsku' : 'Odpowiedź po rosyjsku'}</label>
			<div className="dictation">
				<input ref={input} id="study-answer" lang={target} maxLength={500} autoComplete="off" value={study.answer} disabled={study.locked} onChange={event => study.setAnswer(event.target.value)} />
				<Dictation key={`${current?.id}:${current?.version}`} language={target} disabled={study.locked || study.state !== 'answering'} onText={text => { if (input.current) study.setAnswer(dictatedValue(input.current, text)); }} />
			</div>
			<div className="study-actions">
				<button className="primary" type="submit" disabled={study.locked || study.state !== 'answering' || !study.answer.trim()}>Sprawdź</button>
				<button type="button" disabled={study.locked || study.state !== 'answering'} onClick={() => void study.reveal()}>Pokaż odpowiedź</button>
			</div>
		</form>}
		{study.state === 'checking' && <p role="status">Sprawdzanie odpowiedzi…</p>}
		{study.feedback && <>
			<div className={`study-feedback ${study.feedback.grade}`} role="status" aria-atomic="true">
				<h2><span className="grade-icon" aria-hidden="true"><Icon name={study.feedback.grade} /></span>{grade}</h2>
				<p className="study-correction" data-testid="study-correction" lang={target}>{study.feedback.correction}</p>
				{current && <p className="study-example" lang={target}>{polish ? current.examplePl : current.exampleRu}</p>}
				<p>{study.feedback.explanation}</p>
			</div>
			<button ref={nextButton} className="primary" onClick={study.next}>Dalej</button>
		</>}
		{study.state === 'empty' && <div role="status">
			<p>{study.nextDueAt ? 'Na dziś wszystko gotowe.' : 'Dodaj słówko, aby zacząć.'}</p>
			{study.nextDueAt && <p className="hint">Następna powtórka: <time dateTime={new Date(study.nextDueAt).toISOString()}>{new Date(study.nextDueAt).toLocaleString('pl-PL')}</time></p>}
		</div>}
		{study.busy && study.state !== 'checking' && <p className="delayed" role="status">Zapisywanie kierunku…</p>}
		{study.retainedAnswer && <div className="study-recovery">
			<p className="hint">Fiszka lub wynik się zmieniły. Skopiuj zapisaną odpowiedź, jeśli jest potrzebna do nowej próby.</p>
			<label htmlFor="retained-answer">Zapisana odpowiedź</label>
			<textarea id="retained-answer" readOnly value={study.retainedAnswer} />
		</div>}
		{study.error && <div className="notice">
			<p className="error" role="alert">{study.error}</p>
			<button disabled={study.busy} onClick={() => void study.retry()}>Ponów</button>
		</div>}
	</section>;
}
