import { useId } from 'react';
import type { CardContent } from '../shared/types';

export function CardFields({ value, onChange }: { value: CardContent; onChange(value: CardContent): void }) {
	const id = useId();
	return <div className="card-fields">
		<label htmlFor={`${id}-pl`}>Po polsku</label>
		<input id={`${id}-pl`} lang="pl" maxLength={200} required value={value.pl} onChange={event => onChange({ ...value, pl: event.target.value, alternativesPl: [] })} />
		<label htmlFor={`${id}-ru`}>Po rosyjsku</label>
		<input id={`${id}-ru`} lang="ru" maxLength={200} required value={value.ru} onChange={event => onChange({ ...value, ru: event.target.value, alternativesRu: [] })} />
		<label htmlFor={`${id}-meaning`}>Znaczenie (po rosyjsku)</label>
		<input id={`${id}-meaning`} lang="ru" maxLength={200} required value={value.meaningRu} onChange={event => onChange({ ...value, meaningRu: event.target.value })} />
		<label htmlFor={`${id}-example-pl`}>Przykład po polsku</label>
		<textarea id={`${id}-example-pl`} lang="pl" maxLength={500} required rows={3} value={value.examplePl} onChange={event => onChange({ ...value, examplePl: event.target.value })} />
		<label htmlFor={`${id}-example-ru`}>Przykład po rosyjsku</label>
		<textarea id={`${id}-example-ru`} lang="ru" maxLength={500} required rows={3} value={value.exampleRu} onChange={event => onChange({ ...value, exampleRu: event.target.value })} />
		<p className="hint" id={`${id}-alternatives`}>Inne poprawne odpowiedzi: do ośmiu dla każdego języka, jedna w wierszu. Do 200 znaków na odpowiedź.</p>
		<label htmlFor={`${id}-alternatives-pl`}>Inne odpowiedzi po polsku</label>
		<textarea id={`${id}-alternatives-pl`} lang="pl" aria-describedby={`${id}-alternatives`} rows={2} maxLength={1607} value={value.alternativesPl.join('\n')} onChange={event => onChange({ ...value, alternativesPl: event.target.value ? event.target.value.split('\n') : [] })} />
		<label htmlFor={`${id}-alternatives-ru`}>Inne odpowiedzi po rosyjsku</label>
		<textarea id={`${id}-alternatives-ru`} lang="ru" aria-describedby={`${id}-alternatives`} rows={2} maxLength={1607} value={value.alternativesRu.join('\n')} onChange={event => onChange({ ...value, alternativesRu: event.target.value ? event.target.value.split('\n') : [] })} />
	</div>;
}
