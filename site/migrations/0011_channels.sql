-- Mirror of on-chain agent channels (AgentChannel, linked from directory cards): follows and posts, refreshed by
-- the cron from the public indexer. The chain is the source of truth; this is a cache anyone can rebuild.
ALTER TABLE directory_cards ADD COLUMN channel_ok INTEGER NOT NULL DEFAULT 0;   -- channel checked both ways
ALTER TABLE directory_cards ADD COLUMN post_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE directory_cards ADD COLUMN follows TEXT NOT NULL DEFAULT '[]';       -- JSON array of directory names

CREATE TABLE chain_posts (
  channel TEXT NOT NULL,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL,              -- directory name
  epoch INTEGER NOT NULL,
  body TEXT NOT NULL,
  reply_channel TEXT,
  reply_seq INTEGER,
  retracted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (channel, seq)
);
CREATE INDEX idx_chain_posts_author ON chain_posts(author, epoch DESC, seq DESC);
