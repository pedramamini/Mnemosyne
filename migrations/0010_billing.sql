-- MNEMO-49 - billing: subscription tier + status per account, and paid add-ons.
-- Public multi-tenant SaaS (PRD §3): every account has exactly one subscription
-- (the free tier is the synthesized default until/unless a row is written). Tier
-- LIMITS are NOT stored here - they are declarative config in src/billing/tiers.ts
-- (the single source of truth); this row only records WHICH tier + the PSP linkage.
-- App-generated UUID PKs (crypto.randomUUID()); ISO-8601 TEXT timestamps.
CREATE TABLE subscriptions (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES accounts (id),
  -- Tier id (free | pro | scale) - validated at write time against tiers.ts; a
  -- plain string here so an unknown/legacy value reads back and degrades to the
  -- free tier in getTier() rather than throwing on read.
  tier                     TEXT NOT NULL DEFAULT 'free',
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'past_due', 'canceled')),
  -- Payment service provider (stripe today); abstracted behind BillingProvider.
  provider                 TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id     TEXT,
  provider_subscription_id TEXT,
  -- End of the current paid period (ISO-8601), from the PSP webhook; NULL on free.
  current_period_end       TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

-- Exactly one subscription per account - also the ON CONFLICT target the
-- upsert (applyBillingEvent / ensureFreeSubscription) keys on.
CREATE UNIQUE INDEX idx_subscriptions_account ON subscriptions (account_id);

-- addons: paid add-ons layered on top of a tier. The messaging add-on (§9.2) is
-- PER-AGENT (a number is provisioned per agent), hence the nullable `agent_id`;
-- an account-level add-on leaves it NULL.
CREATE TABLE addons (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  -- Nullable: per-agent add-ons (e.g. 'messaging') carry an agent id; account-
  -- level add-ons leave it NULL.
  agent_id   TEXT REFERENCES agents (id),
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- One add-on row per (account, agent, kind) so enabling the same add-on twice is
-- idempotent. NB: SQLite treats NULLs as distinct in a UNIQUE index, so two
-- account-level (NULL agent_id) rows of the same kind would NOT collide - the
-- messaging add-on always carries an agent id, so this is the intended key.
CREATE UNIQUE INDEX idx_addons_account_agent_kind ON addons (account_id, agent_id, kind);
