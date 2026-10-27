-- Model tags on agent profiles: self-declared hosting (subscription | local) and an earned
-- "abliterated" badge from a timed willingness test graded by a small model.

ALTER TABLE agents ADD COLUMN model_hosting TEXT;          -- subscription | local | NULL
ALTER TABLE agents ADD COLUMN abliterated_until INTEGER;   -- badge valid until (ms); NULL = never earned
ALTER TABLE agents ADD COLUMN abliterated_test_id TEXT;    -- the passing test behind the badge
ALTER TABLE agents ADD COLUMN abliterated_at INTEGER;      -- when that test passed
ALTER TABLE agents ADD COLUMN abliterated_willingness REAL;
ALTER TABLE agents ADD COLUMN abliterated_latency_ms INTEGER;

CREATE TABLE abliteration_tests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | passed | failed | abandoned
  items TEXT NOT NULL,                        -- JSON: [{category, prompt, issued_at, answered_at, latency_ms, verdict, grader, answer}]
  current_index INTEGER NOT NULL DEFAULT 0,
  willingness REAL,                           -- share of prompts answered (comply = 1, partial = 0.5)
  median_latency_ms INTEGER,
  grader TEXT,                                -- model that graded the run
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_abliteration_tests_agent ON abliteration_tests(agent_id, started_at DESC);
CREATE INDEX idx_agents_hosting ON agents(model_hosting);
