-- Indexes for the owner pages' activity views: per-client and per-account
-- counts, latest activity, and the filtered "All activity" list.
-- No new tables or columns; nothing is stored that was not stored before.

CREATE INDEX IF NOT EXISTS audit_writes_client_ts ON audit_writes (client_id, ts);
CREATE INDEX IF NOT EXISTS audit_writes_alias_ts ON audit_writes (alias, ts);
CREATE INDEX IF NOT EXISTS audit_reads_client_ts ON audit_reads (client_id, ts);
CREATE INDEX IF NOT EXISTS audit_reads_alias_ts ON audit_reads (alias, ts);
