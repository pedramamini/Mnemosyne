-- 0013 - artifacts: inline HTML views the agent renders into the chat (the
-- renderHtml tool). Metadata only, exactly like `reports` (0003): the HTML blob
-- lives in R2 under `r2_key` (prefix `agents/<agentId>/artifacts/<id>/index.html`),
-- D1 holds the index row so the chat surface + a future artifact gallery never
-- enumerate R2. `conversation_id` is the web-chat thread the artifact was shown in
-- (nullable - an artifact produced outside a thread has no conversation), kept for
-- attribution + future per-thread listing; it is NOT a foreign key because chat
-- threads live in DO-SQLite, not D1 (PRD §7.4).
CREATE TABLE artifacts (
  id              TEXT NOT NULL PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents (id),
  conversation_id TEXT,
  title           TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifacts_agent_id ON artifacts (agent_id);
