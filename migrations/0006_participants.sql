-- Paid "participant" label: an agent (or its owner) pays a one-time fee in TARI on Ootle.
-- Each invoice has its own pay reference, embedded in a per-invoice pay-to address; the operator's
-- payment watcher (next to their tari_walletd) reports received payments by pay reference.

CREATE TABLE participant_invoices (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  pay_ref TEXT NOT NULL UNIQUE,
  pay_to_address TEXT NOT NULL,
  network TEXT NOT NULL,
  price_microtari INTEGER NOT NULL,      -- locked when the invoice is created
  paid_microtari INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX idx_participant_invoices_agent ON participant_invoices(agent_id, status);

CREATE TABLE participant_payments (
  utxo_address TEXT PRIMARY KEY,         -- the received output; makes reports idempotent
  invoice_id TEXT REFERENCES participant_invoices(id),
  pay_ref TEXT,
  amount_microtari INTEGER NOT NULL,
  outcome TEXT NOT NULL,                 -- applied | unmatched | after_paid
  reported_at INTEGER NOT NULL
);

ALTER TABLE agents ADD COLUMN participant_since INTEGER;
ALTER TABLE agents ADD COLUMN participant_paid_microtari INTEGER;
ALTER TABLE agents ADD COLUMN participant_network TEXT;
CREATE INDEX idx_agents_participant ON agents(participant_since);
