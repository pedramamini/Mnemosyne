/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "./src/env.ts";

// In vitest-pool-workers 0.16.x the `env` from `cloudflare:test` is typed as
// `Cloudflare.Env`. Merge our per-phase bindings into it so tests and the
// Worker (`Hono<{ Bindings: Env }>`) stay in sync from one source: src/env.ts.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Test-only: D1 migrations injected by vitest-pool-workers (see
      // vitest.config.ts) so the setup file can apply them to `DB`. Not a
      // production binding - hence optional, so the production `Env` still
      // satisfies the `extends Cloudflare.Env` bound on `AIChatAgent<Env>`
      // (the DO base from MNEMO-04). Present only under the vitest pool.
      TEST_MIGRATIONS?: import("cloudflare:test").D1Migration[];
    }
  }
}
