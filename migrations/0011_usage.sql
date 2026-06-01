-- MNEMO-49 - usage_events: the APPEND-ONLY metering ledger. The single source of
-- truth for per-period consumption that the cost-cap gate reads (PRD §8.4 - the
-- per-agent container is the top cost risk, so caps + concurrency are the guard).
-- One row per metered event; rows are NEVER updated or deleted (an append-only
-- ledger is auditable + reconcilable). Cost is normalized to an estimated
-- `cost_cents` at write time from src/billing/meter.ts's UNIT_COSTS table, so the
-- gate sums one column instead of re-pricing on read.
CREATE TABLE usage_events (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  -- Nullable: account-level events (rare) leave it NULL; most events attribute to
  -- the agent that incurred them (sandbox run / LLM turn / SMS / report).
  agent_id    TEXT REFERENCES agents (id),
  kind        TEXT NOT NULL
                CHECK (kind IN ('sandbox_sec', 'llm_tokens', 'sms_segment', 'report')),
  -- Raw metered amount in the natural `unit` (seconds, tokens, segments, reports).
  quantity    REAL NOT NULL,
  unit        TEXT NOT NULL,
  -- Normalized estimated cost in CENTS (REAL - sub-cent events accumulate exactly).
  cost_cents  REAL NOT NULL,
  -- Billing window 'YYYY-MM' (UTC) - matches the LLM-spend period (MNEMO-14).
  period      TEXT NOT NULL,
  -- Correlates an event back to the research run that produced it (MNEMO-21).
  session_id  TEXT,
  created_at  TEXT NOT NULL
);

-- The cost-cap gate sums an account's spend for the current period.
CREATE INDEX idx_usage_account_period ON usage_events (account_id, period);
-- Per-agent rollups (the UI usage bar can break spend down by agent).
CREATE INDEX idx_usage_agent_period ON usage_events (agent_id, period);
-- Per-kind rollups within a period (the `byKind` breakdown in getUsageSummary).
CREATE INDEX idx_usage_account_kind_period ON usage_events (account_id, kind, period);
