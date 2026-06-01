import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs once per test file (vitest setupFile), inside workerd. Seeds the schema
// by applying the migrations injected via the `TEST_MIGRATIONS` binding
// (read from `migrations/` in vitest.config.ts). Idempotent - applied state is
// recorded in the `d1_migrations` table.
//
// TEST_MIGRATIONS is typed optional (it's test-only, absent in production), but
// vitest.config.ts always injects it for the pool; `?? []` only satisfies the
// type - if it were ever missing, the unseeded schema would fail tests loudly.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
