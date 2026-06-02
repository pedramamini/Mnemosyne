-- DOCS-01 - agent_documents: the metadata index for user-uploaded documents that
-- are parsed to Markdown (env.AI.toMarkdown) and ingested into an agent's brain as
-- linked neurons. Like `artifacts` (0013) / `reports` (0003), this is METADATA
-- ONLY over R2 blobs: the original upload lives in DOCUMENTS_BUCKET under `r2_key`
-- (`agents/<agentId>/documents/<id>/<filename>`) and the converted markdown under
-- a sibling key, so the upload list never enumerates R2.
--
-- `discovery_id` is set while the doc is attached to an in-progress Discovery
-- (uploaded BEFORE Build) and NULL once the markdown has been seeded into a live
-- brain - it marks the "seed me at Build time" set the build() pass drains.
-- `convert_method` is always 'tomarkdown' in v1 (the column is kept for a future
-- sandbox/LibreOffice fallback, DOCS-03). `source_slug` is the parent source-index
-- neuron's path slug once seeded, so a delete can optionally drop the derived
-- neurons. `created_at` is epoch-ms (INTEGER), distinct from the ISO `created_at`
-- the older tables use.
CREATE TABLE agent_documents (
  id             TEXT NOT NULL PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents (id),
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  -- Set when uploaded before Build (attached to Discovery); NULL once seeded live.
  discovery_id   TEXT,
  filename       TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     INTEGER,
  -- R2 key of the ORIGINAL uploaded blob (DOCUMENTS_BUCKET).
  r2_key         TEXT NOT NULL,
  status         TEXT NOT NULL
                   CHECK (status IN ('pending', 'converted', 'seeded', 'failed')),
  -- Always 'tomarkdown' in v1; kept for a future conversion fallback (DOCS-03).
  convert_method TEXT,
  markdown_chars INTEGER,
  neuron_count   INTEGER,
  -- The parent source-index neuron's path slug once seeded (NULL until then).
  source_slug    TEXT,
  error          TEXT,
  -- Epoch-ms (INTEGER), per the DOCS-01 spec - NOT the ISO text the older tables use.
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_agent_documents_agent_id ON agent_documents (agent_id);
