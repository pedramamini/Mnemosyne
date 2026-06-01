-- MNEMO-47 - A2P 10DLC registration state (PRD §9.1/§9.2).
--
-- US application-to-person SMS requires carrier registration: a one-time BRAND
-- registration and a CAMPAIGN registration. CRUCIALLY these are SHARED, org-level
-- resources - one brand + one campaign cover MANY agent numbers. They are NOT
-- per-number: a provisioned number ATTACHES to the active campaign (the attach is
-- app/Twilio-side, MNEMO-47 a2p.ts; not modeled by a column here). Onboarding is
-- asynchronous and DAYS-NOT-MINUTES, so `status` tracks where each registration is
-- in Twilio's review pipeline rather than assuming instant approval.
--
-- NB: filename is 0007 (not the spec's 0006) because 0006_llm_spend.sql (MNEMO-14)
-- already claimed 0006 - migrations are sequential.

-- a2p_brand: the shared brand registration. `twilio_brand_sid` is null until the
-- brand is created in Twilio; `status` walks pending → submitted → approved/failed.
-- `kind` distinguishes a low-friction sole-proprietor brand from a vetted standard
-- brand (§9.2 cost: ~$4.50 sole-prop vs ~$46 standard).
CREATE TABLE a2p_brand (
  id               TEXT PRIMARY KEY,
  twilio_brand_sid TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'submitted', 'approved', 'failed')),
  kind             TEXT NOT NULL DEFAULT 'sole_prop'
                     CHECK (kind IN ('sole_prop', 'standard')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- a2p_campaign: the shared campaign under an approved brand. A number attaches to
-- this campaign once it (and its brand) are far enough through review. `use_case`
-- is the registered messaging use case (Twilio campaign use-case string).
CREATE TABLE a2p_campaign (
  id                  TEXT PRIMARY KEY,
  brand_id            TEXT NOT NULL REFERENCES a2p_brand (id),
  twilio_campaign_sid TEXT,
  use_case            TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'approved', 'failed')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Find an agent's campaign(s) by brand (the campaign read path resolves the active
-- campaign under the shared brand).
CREATE INDEX idx_a2p_campaign_brand_id ON a2p_campaign (brand_id);

-- Provisioning needs to remember the Twilio IncomingPhoneNumber SID per number so
-- the messaging-disable flow can RELEASE it (DELETE IncomingPhoneNumbers/{sid}.json,
-- MNEMO-47 provisioning.ts). The MNEMO-02 agent_numbers table predates provisioning
-- and had no column for it; add it here (nullable - a number seeded by a test/import
-- may not carry a SID). This is the only foundation-table change this phase makes.
ALTER TABLE agent_numbers ADD COLUMN twilio_sid TEXT;
