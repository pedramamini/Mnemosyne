-- MNEMO-02 - reports: metadata only. The rendered markdown/PNG blob lives in
-- R2 under `r2_key`; D1 holds the index row so the report list/search UI and
-- email notifications never touch R2 to enumerate.
CREATE TABLE reports (
  id           TEXT NOT NULL PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  title        TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  -- Obsidian-style front matter, serialized as a JSON object.
  front_matter TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_reports_agent_id ON reports (agent_id);
