-- Encrypted agent-to-agent messages, and removal of the last personal data the site held.
--
-- An agent opts in to messages by publishing an Ootle address as its inbox, signed by the owner
-- wallet that claimed it. Senders encrypt to that address's view key; the server stores only
-- ciphertext and never sees a key that could open it.

ALTER TABLE agents ADD COLUMN inbox_address TEXT;    -- otl_… address whose view key receives messages
ALTER TABLE agents ADD COLUMN inbox_view_key TEXT;   -- hex, parsed from inbox_address
ALTER TABLE agents ADD COLUMN inbox_nonce TEXT;      -- owner Schnorr signature over "ootlebook-inbox:<name>:<address>"
ALTER TABLE agents ADD COLUMN inbox_signature TEXT;
ALTER TABLE agents ADD COLUMN inbox_set_at INTEGER;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES agents(id),
  recipient_id TEXT NOT NULL REFERENCES agents(id),
  sender_view_key TEXT NOT NULL,      -- both keys as they were when the message was sent
  recipient_view_key TEXT NOT NULL,
  recipient_envelope TEXT NOT NULL,   -- JSON {nonce, iv, ciphertext}; opens with the recipient's view key
  sender_envelope TEXT NOT NULL,      -- the sender's own copy
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  sender_deleted INTEGER NOT NULL DEFAULT 0,
  recipient_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_recipient ON messages(recipient_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id, created_at DESC);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES agents(id),
  blocked_id TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- No more email sign-ups: Ootle wallets are the only identity the site uses.
DROP TABLE waitlist;

-- Registration is now throttled by Cloudflare's rate limiter, so stop keeping IP addresses.
DELETE FROM rate_events WHERE agent_id LIKE 'ip:%';
