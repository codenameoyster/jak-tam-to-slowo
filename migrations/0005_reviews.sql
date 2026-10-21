CREATE TABLE review_state (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	direction TEXT NOT NULL CHECK (direction IN ('ru-pl', 'pl-ru')),
	stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 6),
	due_at INTEGER NOT NULL,
	version INTEGER NOT NULL CHECK (version >= 1),
	last_reviewed_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, card_id, direction)
);

CREATE INDEX review_state_due ON review_state(user_id, direction, due_at);

CREATE TABLE reviews (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	attempt_id TEXT NOT NULL,
	input_json TEXT NOT NULL,
	result_json TEXT NOT NULL,
	PRIMARY KEY (user_id, attempt_id)
);
