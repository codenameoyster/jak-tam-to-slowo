CREATE TABLE card_progress (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	correct INTEGER NOT NULL CHECK (correct >= 0),
	incorrect INTEGER NOT NULL CHECK (incorrect >= 0),
	last_correct_at INTEGER,
	last_incorrect_at INTEGER,
	version INTEGER NOT NULL CHECK (version >= 1),
	PRIMARY KEY (user_id, card_id)
);

-- Both directions count for one card. "Prawie dobrze", "Powtórz" and "Pokaż odpowiedź" count as incorrect.
INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, last_incorrect_at, version)
SELECT user_id, card_id, sum(grade = 'correct'), sum(grade <> 'correct'),
	max(CASE WHEN grade = 'correct' THEN at END), max(CASE WHEN grade <> 'correct' THEN at END), count(*)
FROM (SELECT user_id, json_extract(input_json, '$.cardId') AS card_id, json_extract(result_json, '$.grade') AS grade,
	json_extract(result_json, '$.progress.lastReviewedAt') AS at FROM reviews)
WHERE card_id IN (SELECT id FROM cards)
GROUP BY user_id, card_id;
