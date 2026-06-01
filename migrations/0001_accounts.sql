-- MNEMO-02 - accounts: the tenant root. One row per signed-up user.
-- App-generated UUID PKs (crypto.randomUUID()); ISO-8601 TEXT timestamps.
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- NOTE: `email UNIQUE` already builds an implicit index that serves
-- getAccountByEmail lookups. This explicit index is requested by the phase
-- spec; it is functionally redundant but harmless.
CREATE INDEX idx_accounts_email ON accounts (email);
