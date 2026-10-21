CREATE TABLE ai_connections (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	client_id TEXT NOT NULL,
	host_id TEXT NOT NULL,
	issuer TEXT NOT NULL,
	subject TEXT NOT NULL,
	account_label TEXT NOT NULL,
	access_token TEXT,
	refresh_token TEXT,
	id_token TEXT,
	scopes TEXT,
	expires_at INTEGER,
	refresh_after INTEGER,
	model TEXT,
	models TEXT NOT NULL DEFAULT '[]',
	version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_attempts (
	state TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
	nonce TEXT NOT NULL,
	verifier TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	client_id TEXT,
	subject TEXT,
	connection_version INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);

CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires_at);
CREATE INDEX oauth_attempts_user ON oauth_attempts(user_id);
