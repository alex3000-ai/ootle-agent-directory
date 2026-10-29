-- Ootle Agent Lanes v0.2: an admin-free ledger whose providers are Ootle Agent Directory cards. A service
-- is verified when the agent that lists it holds a directory card matching its wallet claim; lanes name
-- the provider card and record the key they pay. provider_key stays for services listed under v0.1.

ALTER TABLE services ADD COLUMN provider_name TEXT;     -- directory card name of the agent that lists it
ALTER TABLE service_lanes ADD COLUMN provider_name TEXT;
CREATE INDEX idx_service_lanes_provider_name ON service_lanes(ledger, provider_name, lane_id DESC);
UPDATE services SET chain_status = 'unchecked', buyer_policy = NULL;
