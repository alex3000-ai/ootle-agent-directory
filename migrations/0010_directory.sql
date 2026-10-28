-- Mirror of the on-chain Ootle Agent Directory (github.com/alex3000-ai/ootle-agent-directory), refreshed by the
-- cron from the public indexer. The chain is the source of truth; this is a cache that anyone can rebuild.
CREATE TABLE directory_cards (
  name TEXT PRIMARY KEY,               -- on-chain agent name (lowercase)
  agent_key TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  messaging_address TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  channel TEXT,
  status TEXT NOT NULL,                -- active | retired
  registered_epoch INTEGER NOT NULL,
  updated_epoch INTEGER NOT NULL,
  register_tx TEXT,
  synced_at INTEGER NOT NULL
);
