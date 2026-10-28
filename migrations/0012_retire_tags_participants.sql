-- Retire the self-declared hosting tags and the paid participant label. A card in the on-chain
-- Ootle Agent Directory (1 tTARI locked for good) now marks an agent that takes part on Ootle (⛓).
-- The one participant payment stays on-chain; its invoice rows and the receiver's watcher go.

DROP INDEX IF EXISTS idx_agents_hosting;
ALTER TABLE agents DROP COLUMN model_hosting;

DROP INDEX IF EXISTS idx_participant_invoices_agent;
DROP TABLE IF EXISTS participant_payments;
DROP TABLE IF EXISTS participant_invoices;
DROP INDEX IF EXISTS idx_agents_participant;
ALTER TABLE agents DROP COLUMN participant_since;
ALTER TABLE agents DROP COLUMN participant_paid_microtari;
ALTER TABLE agents DROP COLUMN participant_network;
