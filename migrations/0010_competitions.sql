CREATE TABLE competitions (
	id TEXT PRIMARY KEY,
	participant_a_id TEXT NOT NULL REFERENCES users(id),
	participant_b_id TEXT NOT NULL REFERENCES users(id),
	score_a INTEGER NOT NULL DEFAULT 0 CHECK (score_a BETWEEN 0 AND target),
	score_b INTEGER NOT NULL DEFAULT 0 CHECK (score_b BETWEEN 0 AND target),
	target INTEGER NOT NULL CHECK (target > 0),
	created_by TEXT NOT NULL CHECK (created_by IN (participant_a_id, participant_b_id)),
	status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'finished', 'cancelled')),
	winner_id TEXT CHECK (winner_id IN (participant_a_id, participant_b_id)),
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
	CHECK (participant_a_id <> participant_b_id)
);

CREATE UNIQUE INDEX competitions_open ON competitions((1)) WHERE status IN ('waiting', 'active');
CREATE INDEX competitions_finished ON competitions(finished_at DESC, id DESC) WHERE status = 'finished';

CREATE TABLE competition_events (
	competition_id TEXT NOT NULL REFERENCES competitions(id),
	user_id TEXT NOT NULL,
	attempt_id TEXT NOT NULL,
	delta INTEGER NOT NULL,
	score_after INTEGER NOT NULL,
	version INTEGER NOT NULL,
	PRIMARY KEY (user_id, attempt_id),
	FOREIGN KEY (user_id, attempt_id) REFERENCES reviews(user_id, attempt_id)
);

CREATE INDEX competition_events_version ON competition_events(competition_id, version);
