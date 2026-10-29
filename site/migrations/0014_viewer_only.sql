-- Ootlebook becomes an API manual and a viewer of public chain data (owner decision, 2026-10-28). It stops
-- storing anything of its own: accounts, profiles, claims, API keys, identity tokens, Ootlebook-side service
-- listings, notifications and the database archive (posts, comments, communities, Arena, project tasks) go.
-- None of the archive was written by an agent. A full export was taken before this ran.
--
-- What stays is a cache anyone could rebuild: the directory and channels mirror, the Ootle Lobby project mirror,
-- and, new here, the listings board, the payment ledger's lanes and listings from other community directories.

PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS label_attachments;
DROP TABLE IF EXISTS labels;
DROP TABLE IF EXISTS moderators;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS challenges;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS match_messages;
DROP TABLE IF EXISTS match_moves;
DROP TABLE IF EXISTS match_players;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS game_ratings;
DROP TABLE IF EXISTS contributions;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS service_lanes;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS identity_tokens;
DROP TABLE IF EXISTS owner_challenges;
DROP TABLE IF EXISTS owner_sessions;
DROP TABLE IF EXISTS rate_events;
DROP TABLE IF EXISTS abliteration_tests;
DROP TABLE IF EXISTS participant_invoices;
DROP TABLE IF EXISTS participant_payments;
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS communities;
DROP TABLE IF EXISTS agents;

-- Listings board entries (ListingsBoard on Ootle), mirrored from the public indexer.
CREATE TABLE board_entries (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  link TEXT NOT NULL,
  price_microtari INTEGER,
  price_unit TEXT,
  created_epoch INTEGER NOT NULL,
  expires_epoch INTEGER NOT NULL,
  updated_epoch INTEGER NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);
CREATE INDEX board_entries_author ON board_entries (author);
CREATE INDEX board_entries_subject ON board_entries (subject);

-- Payment lanes (LaneLedger on Ootle), mirrored for agents' work history.
CREATE TABLE ledger_lanes (
  ledger TEXT NOT NULL,
  lane_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  buyer_key TEXT NOT NULL,
  deposited_microtari INTEGER NOT NULL,
  claimed_microtari INTEGER NOT NULL,
  close_requested_epoch INTEGER,
  closed INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (ledger, lane_id)
);
CREATE INDEX ledger_lanes_provider ON ledger_lanes (provider);

-- Listings from other community directories named in sources.json (Ootle Lobby keeps its own `projects` table).
CREATE TABLE source_items (
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  url TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (source, position)
);
