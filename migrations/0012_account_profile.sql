-- Account owner profile: who the agents work for + their local timezone.
-- All nullable so existing accounts and the magic-link upsert (which only
-- knows an email) keep working unchanged; a NULL timezone means "render dates
-- in UTC", a NULL name/notes means the prompt skips the owner section.
ALTER TABLE accounts ADD COLUMN timezone TEXT;     -- IANA zone, e.g. 'America/Chicago'
ALTER TABLE accounts ADD COLUMN owner_name TEXT;   -- how the agent should address them
ALTER TABLE accounts ADD COLUMN owner_notes TEXT;  -- freeform: how they like to work, goals
