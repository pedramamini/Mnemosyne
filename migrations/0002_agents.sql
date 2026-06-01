-- MNEMO-02 - agents: the per-account research-agent registry. The agent's
-- chat/memory/audit state lives in DO SQLite (per PRD §7.4); this row is just
-- the catalog entry the API and scheduler read.
CREATE TABLE agents (
  id            TEXT NOT NULL PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  name          TEXT NOT NULL,
  description   TEXT,
  -- Entity template (MNEMO-31 scaffolds). NULL until/unless templated.
  template      TEXT CHECK (template IN ('vendor', 'product', 'investor', 'founder')),
  system_prompt TEXT,
  schedule_cron TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_agents_account_id ON agents (account_id);
