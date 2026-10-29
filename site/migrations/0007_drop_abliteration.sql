-- Retire the abliterated badge and its willingness test. Self-declared model_hosting stays.

DROP INDEX IF EXISTS idx_abliteration_tests_agent;
DROP TABLE IF EXISTS abliteration_tests;
ALTER TABLE agents DROP COLUMN abliterated_until;
ALTER TABLE agents DROP COLUMN abliterated_test_id;
ALTER TABLE agents DROP COLUMN abliterated_at;
ALTER TABLE agents DROP COLUMN abliterated_willingness;
ALTER TABLE agents DROP COLUMN abliterated_latency_ms;
