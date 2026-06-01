---
type: reference
title: Release Runbook
created: 2026-05-25
tags:
  - ops
  - deploy
  - mnemo-50
related:
  - '[[PRD]]'
---

# Release Runbook (MNEMO-50)

How Mnemosyne ships. Two Wrangler environments with **no shared state** -
`staging` and `production` each own a distinct D1 database, KV namespaces, and R2
buckets (see `wrangler.toml` `[env.staging]` / `[env.production]`). The top-level
`wrangler.toml` config is the **local dev / test** target. Secrets are enumerated in
[`SECRETS.md`](../SECRETS.md) and verified by `npm run check:secrets`; **migrations
run BEFORE deploy** so new code never hits an un-migrated schema.

## 1. First-time environment setup (once per env)

Create the per-environment resources and paste the returned ids over the
placeholders in `wrangler.toml` (`[env.<name>.*]`). Substitute `staging` /
`production` (and the matching resource names) throughout:

```sh
# D1 database
wrangler d1 create mnemosyne-staging          # → database_id for [env.staging]
wrangler d1 create mnemosyne                   # → database_id for [env.production]

# KV namespaces (one each, per env)
wrangler kv namespace create SESSIONS    --env staging
wrangler kv namespace create SCHEDULE_KV --env staging
wrangler kv namespace create LIMITS      --env staging
#   …repeat with --env production

# R2 buckets (brain FS + report blobs, per env)
wrangler r2 bucket create mnemosyne-brains-staging
wrangler r2 bucket create mnemosyne-reports-staging
#   …and the production buckets (mnemosyne-brains / mnemosyne-reports)
```

Then set every secret for the environment (you are prompted for each value - never
committed, never echoed):

```sh
# Run each `wrangler secret put <NAME> --env <env>` from SECRETS.md, then verify:
npm run check:secrets -- --env staging
npm run check:secrets -- --env production
```

`check:secrets` exits non-zero and lists any missing names - it is the preflight gate
baked into `release:staging` / `release:prod`.

## 2. Normal release flow

The intended path is hands-off via CI (`.github/workflows/ci.yml`):

1. **Open a PR** → CI runs `typecheck` + `lint` + `test` (no deploy).
2. **Merge to the default branch** → CI runs the checks, then `release:staging`
   (migrate + deploy to staging).
3. **Publish a GitHub release (or push a `v*` tag)** → CI runs the checks, then
   `release:prod` (migrate + deploy to production).

Deploy auth is the `CLOUDFLARE_API_TOKEN` GitHub Actions secret. Production only
fires from a tagged release, so a bad merge can reach staging but never production.

## 3. Manual release (locally)

The same composite scripts CI runs, for an out-of-band deploy:

```sh
npm run release:staging   # typecheck → test → lint → check:secrets → migrate:staging → deploy:staging
npm run release:prod      # typecheck → test → lint → check:secrets → migrate:prod   → deploy:prod
```

Each is **fail-fast** and runs **migrations before deploy**. To run a step alone:
`npm run migrate:staging`, `npm run deploy:prod`, etc.

## 4. Post-deploy verification

After a deploy, confirm the environment is healthy:

```sh
# 1. Health endpoint responds.
curl -fsS https://<env-host>/health      # → {"status":"ok","service":"mnemosyne"}

# 2. Migrations are fully applied on the remote DB.
wrangler d1 migrations list mnemosyne --remote --env production   # → no pending

# 3. The platform cron is firing. Cron does NOT run under `wrangler dev` (PRD §8.5),
#    so this is the FIRST place the scheduled fan-out actually executes. Watch the
#    scheduled handler in the live tail (a `*/15` heartbeat should appear):
wrangler tail --env production --format pretty
```

Also smoke-test the auth round-trip end to end: `POST /auth/request` with a real
inbox, click the magic link, confirm `GET /api/me` returns the account. The dev-only
cron trigger routes (`POST /__dev/cron`) are 404 in production by design - confirm
they are NOT reachable.

## 5. Rollback

D1 migrations are **forward-only** - there is no down-migration. So rollback is
**code-only**:

```sh
git checkout <previous-tag>
npm run deploy:prod        # re-deploy the previous code against the current schema
```

This is a **release discipline, not just a procedure**: because a rollback re-runs
old code against the newer schema, **every migration must be backward-compatible**
with the previous release (additive columns/tables, no destructive renames/drops in
the same release that starts using them). Split a breaking schema change across two
releases (add-and-backfill, then cut over, then remove) so any single release can be
rolled back safely.
