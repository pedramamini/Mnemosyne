/**
 * MNEMO-50 - release config consistency. Pure file parsing, so it runs in bare Node
 * (filesystem access), NOT the vitest Workers pool - excluded from the pool +
 * tsconfig like the other node tests; run via `npm run test:release`.
 *
 * Asserts: wrangler.toml declares `[env.staging]` + `[env.production]`, each with the
 * core bindings (DB / SESSIONS / AGENT) and DISTINCT D1 database_id + worker name (no
 * shared prod/staging DB); and the `check-secrets.ts` required list names the SAME
 * secrets as the `wrangler secret put` commands in SECRETS.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const read = (rel: string): string =>
  readFileSync(path.join(ROOT, rel), "utf8");

const wrangler = read("wrangler.toml");
const secretsDoc = read("SECRETS.md");
const checkSecrets = read("scripts/check-secrets.ts");

/** Slice the wrangler.toml text belonging to one `[env.<name>]` section. */
function envSection(name: string): string {
  const header = `[env.${name}]`;
  const start = wrangler.indexOf(header);
  assert.ok(start !== -1, `wrangler.toml is missing ${header}`);
  // The section runs to the next top-level `[env.` header (or EOF).
  const rest = wrangler.slice(start + header.length);
  // Stop at the next TOP-LEVEL env header (`[env.<name>]`), NOT a sub-table like
  // `[env.staging.assets]`/`.vars`/`.ai` - those belong to this section and carry
  // its bindings. `[^.\]]+` forbids a dot, so it matches `[env.production]` but
  // not `[env.staging.assets]` (the SPA-hosting glue inserted before the bindings).
  const nextEnv = rest.search(/\n\[env\.[^.\]]+\]/);
  return nextEnv === -1 ? rest : rest.slice(0, nextEnv);
}

test("wrangler.toml declares staging + production environments", () => {
  assert.match(wrangler, /\[env\.staging\]/);
  assert.match(wrangler, /\[env\.production\]/);
});

test("each environment declares the core bindings (DB / SESSIONS / AGENT)", () => {
  for (const name of ["staging", "production"]) {
    const section = envSection(name);
    assert.match(section, /binding = "DB"/, `${name} missing DB binding`);
    assert.match(
      section,
      /binding = "SESSIONS"/,
      `${name} missing SESSIONS binding`,
    );
    assert.match(section, /name = "AGENT"/, `${name} missing AGENT DO binding`);
  }
});

test("staging + production use DISTINCT database_id and worker name", () => {
  const staging = envSection("staging");
  const production = envSection("production");

  const dbId = (section: string): string => {
    const m = section.match(/database_id = "([^"]+)"/);
    assert.ok(m, "missing database_id");
    return m[1];
  };
  const workerName = (section: string): string => {
    const m = section.match(/name = "([^"]+)"/); // the first `name =` is the worker name
    assert.ok(m, "missing worker name");
    return m[1];
  };

  assert.notEqual(
    dbId(staging),
    dbId(production),
    "staging + production share a database_id",
  );
  assert.notEqual(
    workerName(staging),
    workerName(production),
    "staging + production share a worker name",
  );
});

test("check-secrets REQUIRED_SECRETS matches the secrets in SECRETS.md", () => {
  // Names inside the REQUIRED_SECRETS = [ ... ] array literal.
  const arrayBlock = checkSecrets.match(
    /REQUIRED_SECRETS\s*=\s*\[([\s\S]*?)\]/,
  );
  assert.ok(arrayBlock, "REQUIRED_SECRETS array not found in check-secrets.ts");
  const fromCode = new Set(
    [...arrayBlock[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]),
  );

  // Names named by a `wrangler secret put <NAME>` command in SECRETS.md.
  const fromDoc = new Set(
    [...secretsDoc.matchAll(/wrangler secret put ([A-Z0-9_]+)/g)].map(
      (m) => m[1],
    ),
  );

  assert.ok(fromCode.size > 0, "no secrets parsed from check-secrets.ts");
  assert.ok(fromDoc.size > 0, "no secrets parsed from SECRETS.md");
  assert.deepEqual(
    [...fromCode].sort(),
    [...fromDoc].sort(),
    "check-secrets.ts and SECRETS.md disagree on the secret list",
  );
});
