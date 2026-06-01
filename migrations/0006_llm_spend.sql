-- MNEMO-14 - llm_spend: per-account usage accounting for BYOK provider calls
-- routed through the Cloudflare AI Gateway. One row per (account, billing
-- window); the app accumulates usage here AFTER each turn (recordUsage) and
-- pre-flight gates new calls against it (assertUnderCap).
-- per-PRD §7.2: per-user spend caps enforced in app logic over AI Gateway usage
CREATE TABLE llm_spend (
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  -- billing window, e.g. 'YYYY-MM' (UTC) - see currentPeriod() in recordUsage.ts
  period         TEXT NOT NULL,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  -- cost in milli-USD ($0.001 units) to keep accounting in integers
  cost_usd_milli INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- One spend row per account per window - also the ON CONFLICT target the
-- upsert-accumulate (addSpend) keys on.
CREATE UNIQUE INDEX idx_llm_spend_account_period ON llm_spend (account_id, period);

-- Per-account monthly cap in milli-USD; NULL = use the platform default
-- (DEFAULT_SPEND_CAP_USD_MILLI in src/db/index.ts).
ALTER TABLE llm_profiles ADD COLUMN spend_cap_usd_milli INTEGER;
