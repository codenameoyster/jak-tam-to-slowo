import type { Competition } from '../shared/types';
import { Icon } from './Icon';

export function competitionStatus(round: Competition): string {
	if (round.status === 'waiting') return 'Oczekiwanie na przyjęcie wyzwania';
	if (round.status === 'finished') return `Wygrywa ${round.participants.find(person => person.id === round.winnerId)?.displayName}!`;
	if (round.status === 'cancelled') return 'Wyzwanie anulowane';
	return 'Wyścig trwa';
}

export function CompetitionSummary({ userId, round, stale, busy, onOpen }: {
	userId: string; round: Competition; stale: boolean; busy: boolean; onOpen(): void;
}): React.JSX.Element {
	return <button className="competition-summary" data-testid="competition-summary" disabled={busy} onClick={onOpen}>
		<span className="competition-title"><Icon name="trophy" />Wyścig do {round.target}</span>
		<span role="status" aria-atomic="true">
			<span className="competition-score-row">{round.participants.map(person => <span key={person.id}>{person.displayName}{person.id === userId && ' (Ty)'}: {person.score}</span>)}</span>
			<span className="hint">{competitionStatus(round)}</span>
		</span>
		{stale && <span className="hint">Wynik może być nieaktualny</span>}
	</button>;
}
