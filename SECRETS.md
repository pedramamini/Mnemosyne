# Secrets - Mnemosyne (MNEMO-50)

The **single source of truth for what must be set before a deploy succeeds.** Every
secret below is a **Wrangler secret** (encrypted, never in source / `wrangler.toml`);
provision it **per environment** with the exact command shown. The matching binding
is declared on `Env` in [`src/env.ts`](src/env.ts), and the preflight gate
[`scripts/check-secrets.ts`](scripts/check-secrets.ts) (run via `npm run check:secrets`)
verifies the full list is present before `release:staging` / `release:prod`.

> **Secrets vs. vars.** Plain config (`ENVIRONMENT`, `APP_BASE_URL`,
> `AI_GATEWAY_*`, `WEB_SEARCH_PROVIDER`/`ENDPOINT`, `TWILIO_API_BASE`,
> `MESSAGING_SMS_GROUPS`) lives in `[env.<name>.vars]` in `wrangler.toml`, NOT here -
> it is not sensitive. This file is **secrets only** (the things `wrangler secret put`
> manages). `check-secrets.ts` only checks secrets, so vars never appear in its list.

## Required secrets

| Secret | Purpose | Phase |
| --- | --- | --- |
| `RESEND_API_KEY` | Resend API key - magic-link auth email + report-ready notifications. | MNEMO-03 |
| `KEY_ENCRYPTION_SECRET` | AES-GCM master key for BYOK secret custody - encrypts every stored provider key at rest; the only thing that can decrypt them in-process. | MNEMO-14 |
| `WEB_SEARCH_API_KEY` | API key for the web-search backend (paired with the `WEB_SEARCH_PROVIDER`/`ENDPOINT` vars). | MNEMO-17 |
| `TWILIO_ACCOUNT_SID` | Twilio account SID - HTTP Basic auth username for outbound SMS + the `Messages.json` path segment. | MNEMO-44 |
| `TWILIO_AUTH_TOKEN` | Twilio auth token - Basic auth password for outbound SMS + the HMAC key validating the inbound `X-Twilio-Signature`. | MNEMO-44 |
| `STRIPE_SECRET_KEY` | Stripe secret API key - its presence selects the live billing provider over the deterministic fake. | MNEMO-49 |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret - verifies `Stripe-Signature` on the public `POST /billing/webhook`. | MNEMO-49 |

> **Feature-gated secrets.** `WEB_SEARCH_API_KEY`, `TWILIO_*`, and `STRIPE_*` gate
> optional features (web search, the messaging add-on, live billing). They are in the
> required list so the preflight is strict-by-default - set a throwaway/placeholder if
> you are deploying without that feature, or trim both this list and `REQUIRED_SECRETS`
> in `check-secrets.ts` together (the `release-config` test asserts the two sets match).

## Provisioning

Run once per environment (you are prompted for the value - it is never echoed):

```sh
# ─── staging ───────────────────────────────────────────────────────────────
wrangler secret put RESEND_API_KEY --env staging
wrangler secret put KEY_ENCRYPTION_SECRET --env staging
wrangler secret put WEB_SEARCH_API_KEY --env staging
wrangler secret put TWILIO_ACCOUNT_SID --env staging
wrangler secret put TWILIO_AUTH_TOKEN --env staging
wrangler secret put STRIPE_SECRET_KEY --env staging
wrangler secret put STRIPE_WEBHOOK_SECRET --env staging

# ─── production ──────────────────────────────────────────────────────────────
wrangler secret put RESEND_API_KEY --env production
wrangler secret put KEY_ENCRYPTION_SECRET --env production
wrangler secret put WEB_SEARCH_API_KEY --env production
wrangler secret put TWILIO_ACCOUNT_SID --env production
wrangler secret put TWILIO_AUTH_TOKEN --env production
wrangler secret put STRIPE_SECRET_KEY --env production
wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

Verify before a deploy:

```sh
npm run check:secrets -- --env staging
npm run check:secrets -- --env production
```

`check:secrets` exits non-zero and lists any missing names - it is the preflight gate
inside `release:staging` / `release:prod` (see [`docs/RELEASE.md`](docs/RELEASE.md)).
