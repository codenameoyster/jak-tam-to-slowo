import { COMPETITION_TARGET, type Competition, type User } from '../shared/types';
import type { Env } from './index';
import { competitionAccounts } from './auth';
import { HttpError, methods, object, readJson, uuidPattern } from './http';

type CompetitionRow = Omit<Competition, 'participants'> & { idA: string; nameA: string; scoreA: number; idB: string; nameB: string; scoreB: number };

const select = `SELECT c.id, c.created_by AS createdBy, c.target, c.status, c.winner_id AS winnerId,
	c.created_at AS createdAt, c.started_at AS startedAt, c.finished_at AS finishedAt, c.version,
	c.participant_a_id AS idA, a.display_name AS nameA, c.score_a AS scoreA,
	c.participant_b_id AS idB, b.display_name AS nameB, c.score_b AS scoreB
	FROM competitions c JOIN users a ON a.id = c.participant_a_id JOIN users b ON b.id = c.participant_b_id`;

function fromRow(row: CompetitionRow): Competition {
	const { idA, nameA, scoreA, idB, nameB, scoreB, ...round } = row;
	return { ...round, participants: [{ id: idA, displayName: nameA, score: scoreA }, { id: idB, displayName: nameB, score: scoreB }] };
}

export async function handleCompetitions(request: Request, env: Env, user: User): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (pathname === '/api/competitions/current') {
		methods(request, ['GET']);
		const [open, finished] = await env.DB.batch<CompetitionRow>([
			env.DB.prepare(`${select} WHERE ? IN (c.participant_a_id, c.participant_b_id) AND c.status IN ('waiting', 'active')`).bind(user.id),
			env.DB.prepare(`${select} WHERE ? IN (c.participant_a_id, c.participant_b_id) AND c.status = 'finished'
				ORDER BY c.finished_at DESC, c.id DESC LIMIT 1`).bind(user.id),
		]);
		const row = open.results[0] ?? finished.results[0];
		return Response.json(row ? fromRow(row) : null);
	}
	if (pathname === '/api/competitions') {
		methods(request, ['POST']);
		const { id } = object(await readJson(request), ['id']);
		if (typeof id !== 'string' || !uuidPattern.test(id)) throw new HttpError(400, 'invalid_input', 'Nieprawidłowy identyfikator wyzwania.');
		const accounts = competitionAccounts(env).sort((a, b) => a.id.localeCompare(b.id));
		if (accounts.length !== 2) throw new HttpError(503, 'competition_unavailable', 'Wyzwanie wymaga dwóch skonfigurowanych kont.');
		const [a, b] = accounts;
		const registered = await env.DB.prepare('SELECT count(*) AS count FROM users WHERE id IN (?, ?)').bind(a.id, b.id).first<number>('count');
		if (registered !== 2) throw new HttpError(409, 'opponent_not_ready', 'Druga osoba musi najpierw zalogować się do aplikacji.');
		const [, saved] = await env.DB.batch<CompetitionRow>([
			env.DB.prepare(`INSERT INTO competitions (id, participant_a_id, participant_b_id, target, created_by, created_at)
				VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(id, a.id, b.id, COMPETITION_TARGET, user.id, Date.now()),
			env.DB.prepare(`${select} WHERE ?2 IN (c.participant_a_id, c.participant_b_id) AND (c.id = ?1 OR c.status IN ('waiting', 'active'))
				ORDER BY (c.id = ?1) DESC LIMIT 1`).bind(id, user.id),
		]);
		const row = saved.results[0];
		if (!row) throw new HttpError(404, 'not_found', 'Nie znaleziono wyzwania.');
		return Response.json(fromRow(row));
	}
	const match = /^\/api\/competitions\/([^/]+)\/(accept|cancel)$/.exec(pathname);
	if (!match) return null;
	methods(request, ['POST']);
	const [, id, action] = match;
	if (!uuidPattern.test(id)) throw new HttpError(400, 'invalid_input', 'Nieprawidłowy identyfikator wyzwania.');
	if (request.body !== null) object(await readJson(request), []);
	const update = action === 'accept'
		? env.DB.prepare(`UPDATE competitions SET status = 'active', started_at = ?1, version = version + 1
			WHERE id = ?2 AND status = 'waiting' AND ?3 IN (participant_a_id, participant_b_id) AND created_by <> ?3`).bind(Date.now(), id, user.id)
		: env.DB.prepare(`UPDATE competitions SET status = 'cancelled', finished_at = ?1, version = version + 1
			WHERE id = ?2 AND status = 'waiting' AND ?3 IN (participant_a_id, participant_b_id)`).bind(Date.now(), id, user.id);
	const [, saved] = await env.DB.batch<CompetitionRow>([
		update,
		env.DB.prepare(`${select} WHERE c.id = ? AND ? IN (c.participant_a_id, c.participant_b_id)`).bind(id, user.id),
	]);
	const row = saved.results[0];
	if (!row) throw new HttpError(404, 'not_found', 'Nie znaleziono wyzwania.');
	if (action === 'accept' && row.createdBy === user.id) throw new HttpError(403, 'forbidden', 'Tylko zaproszona osoba może przyjąć wyzwanie.');
	if (action === 'accept' ? row.status !== 'active' && row.status !== 'finished' : row.status !== 'cancelled') {
		throw new HttpError(409, 'competition_conflict', 'Stan wyzwania już się zmienił. Odśwież wyzwanie.');
	}
	return Response.json(fromRow(row));
}
