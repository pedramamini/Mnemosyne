/**
 * Preflight secret gate (MNEMO-50).
 *
 * The check that runs BEFORE a production deploy (inside `release:staging` /
 * `release:prod`): it lists the secrets actually set on a Wrangler environment and
 * exits non-zero with a clear list of any that are MISSING. Run:
 *
 *   npm run check:secrets -- --env staging
 *   npm run check:secrets -- --env production
 *
 * Dependency-light: it shells out to `wrangler secret list` and parses the result -
 * no SDK. Runs under Node's native TypeScript type-stripping (the same way
 * `test:audit` / `test:memory` run their `.ts` files); `tsx scripts/check-secrets.ts`
 * works identically.
 *
 * REQUIRED_SECRETS is the SINGLE source of truth, kept in lockstep with `SECRETS.md`
 * and `Env` (src/env.ts). `test/release-config.test.ts` asserts this list and the
 * `wrangler secret put` commands in `SECRETS.md` name the SAME set - edit them
 * together.
 */
import { spawnSync } from "node:child_process";

/** Every Wrangler SECRET the platform can use. Keep in sync with SECRETS.md / Env. */
const REQUIRED_SECRETS = [
  "RESEND_API_KEY",
  "KEY_ENCRYPTION_SECRET",
  "WEB_SEARCH_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

/** Pull `--env <name>` out of argv (optional; omitted ⇒ the top-level config). */
function parseEnv(argv: string[]): string | undefined {
  const i = argv.indexOf("--env");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return undefined;
}

/** Ask Wrangler which secrets are set; return the set of names. Throws on failure. */
function listSecretNames(env: string | undefined): Set<string> {
  const args = ["wrangler", "secret", "list"];
  if (env) args.push("--env", env);
  const result = spawnSync("npx", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `\`wrangler secret list\` failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  // `wrangler secret list` prints a JSON array of { name, type }. Parse it; fall
  // back to a forgiving substring scan if the output shape ever changes.
  const out = result.stdout ?? "";
  try {
    const parsed: Array<{ name?: string }> = JSON.parse(out);
    return new Set(parsed.map((s) => s.name).filter((n): n is string => !!n));
  } catch {
    return new Set(REQUIRED_SECRETS.filter((name) => out.includes(name)));
  }
}

function main(): void {
  const env = parseEnv(process.argv.slice(2));
  const label = env ?? "(top-level)";
  let present: Set<string>;
  try {
    present = listSecretNames(env);
  } catch (err) {
    console.error(
      `check:secrets - could not list secrets for ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  const missing = REQUIRED_SECRETS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    console.error(`check:secrets - MISSING ${missing.length} secret(s) for ${label}:`);
    for (const name of missing) {
      console.error(`  - ${name}   (wrangler secret put ${name}${env ? ` --env ${env}` : ""})`);
    }
    console.error("See SECRETS.md for what each secret is for.");
    process.exit(1);
    return;
  }

  console.log(`check:secrets - all ${REQUIRED_SECRETS.length} required secrets set for ${label}. ✓`);
}

main();
