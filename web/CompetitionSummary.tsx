import type { Competition } from '../shared/types';
import { CompetitionLadder } from './CompetitionLadder';

const plurals = new Intl.PluralRules('pl');

export function competitionStatus(round: Competition): string {
	if (round.status === 'waiting') return 'Oczekiwanie na przyjęcie wyzwania';
	if (round.status === 'finished') return `Wygrywa ${round.participants.find(person => person.id === round.winnerId)?.displayName}!`;
	if (round.status === 'cancelled') return 'Wyzwanie anulowane';
	const [a, b] = round.participants;
	const difference = Math.abs(a.score - b.score);
	if (!difference) return 'Remis.';
	const form = plurals.select(difference);
	const unit = form === 'one' ? 'punkt' : form === 'few' ? 'punkty' : 'punktów';
	return `${a.score > b.score ? a.displayName : b.displayName} prowadzi o ${difference} ${unit}.`;
}

export function CompetitionSummary({ userId, round, stale, busy, onOpen }: {
	userId: string; round: Competition; stale: boolean; busy: boolean; onOpen(): void;
}): React.JSX.Element {
	return <button className="competition-summary" data-testid="competition-summary" disabled={busy} onClick={onOpen}>
		<CompetitionLadder round={round} compact />
		<span className="competition-summary-copy" role="status" aria-atomic="true">
			<span className="competition-title">{round.status === 'active' ? <><span>Wyścig do {round.target}</span><span className="competition-summary-status">{competitionStatus(round)}</span></> : competitionStatus(round)}</span>
			<span className="competition-score-row">{round.participants.map(person => <span key={person.id}>{person.displayName}{person.id === userId && ' (Ty)'}: <b>{person.score} / {round.target}</b></span>)}</span>
			{stale && <span className="hint">Wynik może być nieaktualny</span>}
		</span>
		<span className="competition-chevron" aria-hidden="true" />
	</button>;
}
