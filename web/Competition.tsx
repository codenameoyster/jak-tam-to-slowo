import { COMPETITION_TARGET, type User } from '../shared/types';
import type { CompetitionState } from './useCompetition';
import { competitionStatus } from './CompetitionSummary';

export function Competition({ user, competition, onStudy }: {
	user: User; competition: CompetitionState; onStudy(): void;
}): React.JSX.Element {
	const { round, loading, readError, actionError, busy } = competition;
	return <section className="page competition" aria-labelledby="competition-title">
		<h1 id="competition-title">Wyścig do {round?.target ?? COMPETITION_TARGET}</h1>
		<p className="intro">Dobra odpowiedź: +1. Błąd lub pokazanie odpowiedzi: -1. Wynik nie spada poniżej zera.</p>
		{!round && loading && <p role="status">Wczytywanie wyzwania…</p>}
		{round && <div className="competition-scores" data-testid="competition-scores" role="status" aria-atomic="true">
			<p>{competitionStatus(round)}</p>
			<div className="competition-score-row">{round.participants.map(person => <p key={person.id}>{person.displayName}{person.id === user.id && ' (Ty)'}: <strong>{person.score}</strong></p>)}</div>
		</div>}
		<div className="competition-actions">
			{!round && !loading && !readError && !actionError && <button className="primary" disabled={busy} onClick={competition.invite}>Zaproś do wyścigu</button>}
			{round?.status === 'waiting' && <>
				{round.createdBy !== user.id && <button className="primary" disabled={busy} onClick={competition.accept}>Przyjmij wyzwanie</button>}
				<button disabled={busy} onClick={competition.cancel}>Anuluj wyzwanie</button>
			</>}
			{round?.status === 'active' && <button className="primary" disabled={busy} onClick={onStudy}>Przejdź do nauki</button>}
			{round?.status === 'finished' && !actionError && <button className="primary" disabled={busy} onClick={competition.invite}>Rewanż</button>}
		</div>
		{busy && <p className="delayed" role="status">Zapisywanie wyzwania…</p>}
		{actionError && <div className="notice"><p className="error" role="alert">{actionError}</p>
			{(!round || round.status === 'finished') && <button disabled={busy} onClick={competition.invite}>Ponów zaproszenie</button>}
		</div>}
		{readError && <div className="notice">
			{round && <p>Wynik może być nieaktualny</p>}
			<p className="error" role="alert">{readError}</p>
			<button disabled={busy || loading} onClick={competition.refresh}>Ponów</button>
		</div>}
		<details className="competition-rules"><summary>Zasady wyścigu</summary>
			<p>Wyścig zaczyna się po przyjęciu zaproszenia. Wygrywa osoba, która pierwsza zdobędzie {round?.target ?? COMPETITION_TARGET} punktów.</p>
			<p>Wynik zmienia się po zapisaniu odpowiedzi w Nauce. „Prawie dobrze”, „Powtórz” i „Pokaż odpowiedź” odejmują punkt. Przy zerze wynik pozostaje bez zmian.</p>
			<p>Oba kierunki tłumaczenia liczą się do tego samego wyniku. Po zakończeniu możecie rozpocząć rewanż od zera.</p>
		</details>
	</section>;
}
