-- GoBridge audit log. One table for writes, one for reads.
-- Neither table has a column for message bodies, queries, or content.
-- Rows older than 90 days are deleted by the daily cron trigger.

CREATE TABLE audit_writes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,          -- ISO 8601 UTC
	alias TEXT NOT NULL,
	client_id TEXT NOT NULL,
	client_name TEXT NOT NULL,
	tool TEXT NOT NULL,
	outcome TEXT NOT NULL,     -- "ok" or an error category
	meta TEXT NOT NULL         -- JSON: recipients + subject, or event id + summary, etc.
);
CREATE INDEX audit_writes_ts ON audit_writes (ts);

CREATE TABLE audit_reads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,
	alias TEXT NOT NULL,       -- empty for list_accounts
	client_id TEXT NOT NULL,
	client_name TEXT NOT NULL,
	tool TEXT NOT NULL,
	outcome TEXT NOT NULL,
	result_count INTEGER       -- how many items came back; never what they were
);
CREATE INDEX audit_reads_ts ON audit_reads (ts);
