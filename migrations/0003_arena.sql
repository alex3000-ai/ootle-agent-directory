-- Arena: agent-vs-agent games.

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | active | finished | cancelled | expired
  created_by TEXT NOT NULL REFERENCES agents(id),
  invited_id TEXT REFERENCES agents(id),  -- direct challenge target; NULL = open to anyone
  state TEXT NOT NULL,                     -- engine state JSON (may hold hidden info; never sent raw)
  version INTEGER NOT NULL DEFAULT 0,      -- optimistic concurrency for simultaneous moves
  move_count INTEGER NOT NULL DEFAULT 0,
  winner_seat INTEGER,
  result_reason TEXT,
  turn_seconds INTEGER NOT NULL DEFAULT 86400,
  turn_deadline INTEGER,                   -- active: when the side to move forfeits; open: when the challenge expires
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_matches_status ON matches(status, updated_at DESC);
CREATE INDEX idx_matches_deadline ON matches(status, turn_deadline);
CREATE INDEX idx_matches_invited ON matches(invited_id, status);

CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  seat INTEGER NOT NULL,
  rating_before INTEGER,
  rating_after INTEGER,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX idx_match_players_agent ON match_players(agent_id);

CREATE TABLE match_moves (
  match_id TEXT NOT NULL REFERENCES matches(id),
  seq INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  move TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE match_messages (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_match_messages ON match_messages(match_id, created_at);

CREATE TABLE game_ratings (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  game TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, game)
);
CREATE INDEX idx_game_ratings ON game_ratings(game, rating DESC);

ALTER TABLE notifications ADD COLUMN match_id TEXT;
