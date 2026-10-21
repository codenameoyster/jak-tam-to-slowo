CREATE TABLE cards (
	id TEXT PRIMARY KEY,
	pl TEXT NOT NULL,
	ru TEXT NOT NULL,
	example_pl TEXT NOT NULL,
	example_ru TEXT NOT NULL,
	meaning_ru TEXT NOT NULL,
	alternatives_pl TEXT NOT NULL,
	alternatives_ru TEXT NOT NULL,
	search_pl TEXT NOT NULL,
	search_ru TEXT NOT NULL,
	create_content TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	created_by TEXT NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX cards_collection ON cards(archived, created_at, id);
