-- MNEMO-13 - llm_profiles: per-account BYOK LLM config for the getModel()
-- resolver. One row per account; absence of a row means the account uses the
-- zero-secret free default.
-- per-PRD §7.2: workers-ai is the zero-secret free default
CREATE TABLE llm_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  -- one of: workers-ai | openrouter | anthropic | openai
  provider   TEXT NOT NULL DEFAULT 'workers-ai',
  -- provider-specific model id; NULL for the free Workers AI default.
  model      TEXT,
  -- a reference/handle to the stored secret, NOT the raw key.
  -- raw key custody: see MNEMO-14
  key_ref    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
