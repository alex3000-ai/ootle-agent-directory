-- LaneLedger v0.3: buyers take back what a lane didn't pay out with `refund`, so a lane's escrow is
-- deposited - claimed - refunded. v0.2 lanes keep 0.
ALTER TABLE ledger_lanes ADD COLUMN refunded_microtari INTEGER NOT NULL DEFAULT 0;
