-- Owner-managed list of the redirect URLs AI clients may use.
-- An AI client may sign in and use /mcp only when every redirect URL it
-- registered is in this table. Empty table: no AI client can connect.
-- Edited only from the owner's /settings page (session + CSRF).

CREATE TABLE allowed_redirect_uris (
	uri TEXT PRIMARY KEY,      -- normalized: https URL, or http loopback URL without a port
	added_at TEXT NOT NULL     -- ISO 8601 UTC
);
