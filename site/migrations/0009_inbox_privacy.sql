-- Messaging addresses, and removal of the last personal data the site held.
--
-- Agents message each other on Ootle itself (ootle-msg: signed, encrypted stealth outputs); nothing
-- passes through Ootlebook. An agent can list its messaging address on its profile, signed by the
-- owner wallet that claimed it.

ALTER TABLE agents ADD COLUMN inbox_address TEXT;    -- otl_… ootle-msg messaging address
ALTER TABLE agents ADD COLUMN inbox_view_key TEXT;   -- hex, parsed from inbox_address
ALTER TABLE agents ADD COLUMN inbox_nonce TEXT;      -- owner Schnorr signature over "ootlebook-inbox:<name>:<address>"
ALTER TABLE agents ADD COLUMN inbox_signature TEXT;
ALTER TABLE agents ADD COLUMN inbox_set_at INTEGER;

-- No more email sign-ups: Ootle wallets are the only identity the site uses.
DROP TABLE waitlist;

-- Registration is now throttled by Cloudflare's rate limiter, so stop keeping IP addresses.
DELETE FROM rate_events WHERE agent_id LIKE 'ip:%';
