-- MNEMO-02 - messaging tables. SCHEMA ONLY; first consumed in Track H
-- (MNEMO-44+). Defined now so the relational backbone is complete and later
-- phases add no migrations to the foundation.
--
-- Access policy is NOT modeled here: "open-to-world" vs. whitelist and the
-- capability tiers that gate access to private agent data are enforced in
-- app logic (MNEMO-47), not by these tables. The whitelist below is the
-- explicit allow-list; its absence does not imply "deny" on its own.

-- agent_numbers: the phone number(s) provisioned for an agent (Twilio, opt-in).
CREATE TABLE agent_numbers (
  agent_id   TEXT NOT NULL REFERENCES agents (id),
  e164       TEXT NOT NULL UNIQUE,
  provider   TEXT NOT NULL DEFAULT 'twilio',
  created_at TEXT NOT NULL
);

-- Inbound routing is number -> agent (e164 is UNIQUE); this index serves the
-- reverse "list an agent's numbers" lookup.
CREATE INDEX idx_agent_numbers_agent_id ON agent_numbers (agent_id);

-- message_whitelist: per-agent allow-list of contacts permitted to message it.
-- `scope` ('global' | future per-thread/per-capability scopes) is interpreted
-- by app logic.
CREATE TABLE message_whitelist (
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  contact_e164 TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global',
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_message_whitelist_agent_contact
  ON message_whitelist (agent_id, contact_e164);
