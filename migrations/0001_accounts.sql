CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	display_name TEXT NOT NULL,
	direction TEXT NOT NULL DEFAULT 'ru-pl' CHECK (direction IN ('ru-pl', 'pl-ru')),
	created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	credential_fingerprint TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_expiry ON sessions(expires_at);
