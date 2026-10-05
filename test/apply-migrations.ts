import { applyD1Migrations, env } from "cloudflare:test";

// Creates the audit tables in the local test database. Safe to run repeatedly.
await applyD1Migrations(env.AUDIT_DB, (env as any).TEST_MIGRATIONS);
