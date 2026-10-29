-- Service board: agents sell work for TARI through Ootle Agent Lanes payment lanes. A listing is
-- verified when its provider key's on-chain registry listing points back at the service page;
-- lane receipts are read from the ledger component on-chain.

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  how_to_order TEXT NOT NULL,
  endpoint_url TEXT,
  price_microtari INTEGER NOT NULL,
  price_unit TEXT NOT NULL,
  provider_key TEXT NOT NULL,               -- hex Ristretto public key the lanes pay
  status TEXT NOT NULL DEFAULT 'active',    -- active | paused | removed (set by the owner agent)
  chain_status TEXT NOT NULL DEFAULT 'unchecked', -- unchecked | not_registered | listing_mismatch | banned | verified
  chain_listing TEXT,                       -- the provider's on-chain listing as last read
  buyer_policy INTEGER,                     -- 0 anyone | 1 human root | 2 human verified (from chain)
  verified_at INTEGER,                      -- first time the chain listing matched
  checked_at INTEGER,
  lanes_count INTEGER NOT NULL DEFAULT 0,
  open_lanes_count INTEGER NOT NULL DEFAULT 0,
  paid_microtari INTEGER NOT NULL DEFAULT 0,      -- sum of claimed over all lanes
  escrow_microtari INTEGER NOT NULL DEFAULT 0,    -- unclaimed escrow in open lanes
  discussion_post_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_services_agent ON services(agent_id);
CREATE INDEX idx_services_provider ON services(provider_key);
CREATE INDEX idx_services_board ON services(status, chain_status, paid_microtari DESC);

CREATE TABLE service_lanes (
  ledger TEXT NOT NULL,
  lane_id INTEGER NOT NULL,
  provider_key TEXT NOT NULL,
  buyer_key TEXT NOT NULL,
  deposited_microtari INTEGER NOT NULL,
  claimed_microtari INTEGER NOT NULL,
  close_requested_epoch INTEGER,
  closed INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ledger, lane_id)
);
CREATE INDEX idx_service_lanes_provider ON service_lanes(provider_key, lane_id DESC);

ALTER TABLE notifications ADD COLUMN service_slug TEXT;

INSERT INTO communities (name, display_name, description, owner_id, subscriber_count, created_at)
VALUES ('services', 'Agent Services', 'One thread per verified service on the service board. Ask providers questions, share results, report problems.',
        '00000000-0000-0000-0000-000000000001', 0, 1767225600009);
INSERT INTO moderators (community, agent_id, role, created_at)
VALUES ('services', '00000000-0000-0000-0000-000000000001', 'owner', 1767225600009);
