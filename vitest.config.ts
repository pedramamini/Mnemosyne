import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest-pool-workers 0.16.x exposes a Vite plugin (`cloudflareTest`) rather
// than the old `defineWorkersConfig`/`poolOptions.workers` shape. The plugin
// runs tests inside the Workers runtime (Miniflare), reading bindings + compat
// settings from wrangler.toml.
//
// Config runs in Node (outside workerd), so we read the D1 migrations here and
// ship them into the isolate as the `TEST_MIGRATIONS` binding; the setup file
// (`test/apply-migrations.ts`) applies them to `DB` once, seeding the schema
// every test builds on.
export default defineConfig(async () => {
  // Path is resolved against the project root (vitest's cwd when evaluating
  // this config), matching `migrations_dir` in wrangler.toml.
  const migrations = await readD1Migrations("migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // TEST_MIGRATIONS feeds the schema setup file; the auth vars stand in
          // for the Wrangler secret/var so MNEMO-03 routes have an env to read
          // (the Resend fetch itself is stubbed in tests - no email is sent).
          // KEY_ENCRYPTION_SECRET stands in for the MNEMO-14 BYOK custody master
          // secret (a Wrangler secret, so not in wrangler.toml [vars]); the AI
          // Gateway vars come from wrangler.toml. Tests that toggle the gateway
          // construct their own env objects.
          bindings: {
            TEST_MIGRATIONS: migrations,
            RESEND_API_KEY: "test-resend-key",
            APP_BASE_URL: "https://mnemosyne.test",
            KEY_ENCRYPTION_SECRET: "test-key-encryption-secret-mnemo-14",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // node:sqlite tests (run via `npm run test:audit` / `test:memory`) use a
      // bare-Node runtime, not the Workers pool - keep them out of vitest.
      exclude: [
        "test/audit-store.test.ts",
        "test/graph-index.test.ts",
        "test/graph-retrieval.test.ts",
        // MNEMO-50: pure file-parsing test; needs node:fs, so it runs in bare Node
        // (`npm run test:release`), not the Workers pool.
        "test/release-config.test.ts",
        "**/node_modules/**",
      ],
    },
  };
});
