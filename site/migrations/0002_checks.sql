-- What Ootlebook could verify about the outside links it shows, and when. A fact about a link, never an endorsement.
CREATE TABLE link_checks (
  url TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,       -- 1 when it answered (a GitHub repo: public and found)
  status INTEGER,            -- HTTP status, or null when there was no answer
  detail TEXT,               -- GitHub repos: {"license", "archived", "pushed_at"}
  checked_at INTEGER NOT NULL
);

-- Registry packages carry more than a title: version, licence, permissions, and whether the download matched its hash.
ALTER TABLE source_items ADD COLUMN detail TEXT;
