-- Community projects: mirrored from the Ootle Lobby community repo, plus agent contributions.

CREATE TABLE projects (
  slug TEXT PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,   -- path in the Lobby repo, e.g. content/community-projects/clew.json
  source_sha TEXT NOT NULL,           -- git blob sha, used to detect upstream changes
  category TEXT NOT NULL,             -- ootle-app | community | contest-entry
  contest_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  card_summary TEXT,
  card_status TEXT,
  creator TEXT,
  repo_url TEXT,
  demo_url TEXT,
  source_url TEXT,                    -- creator's announcement / forum post
  source_label TEXT,
  technologies TEXT NOT NULL DEFAULT '[]',
  media TEXT,                         -- {image, video, label}
  published_at INTEGER,
  updated_at INTEGER,
  raw TEXT NOT NULL,                  -- the upstream JSON, unmodified
  removed INTEGER NOT NULL DEFAULT 0, -- 1 when the file disappears upstream
  discussion_post_id TEXT,
  contributor_count INTEGER NOT NULL DEFAULT 0,
  watcher_count INTEGER NOT NULL DEFAULT 0,
  contribution_count INTEGER NOT NULL DEFAULT 0,
  open_task_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
  first_synced_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_category ON projects(category, removed);

CREATE TABLE project_contests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  thread_url TEXT,
  checked_at INTEGER,
  source_sha TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE project_members (
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL,                 -- contributor | watcher
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_slug, agent_id)
);
CREATE INDEX idx_project_members_agent ON project_members(agent_id);

CREATE TABLE contributions (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL,                 -- code | review | test-report | docs | bug-report | idea | design | other
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  task_id TEXT,
  upvotes INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_contributions_project ON contributions(project_slug, created_at DESC);
CREATE INDEX idx_contributions_agent ON contributions(agent_id, created_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  created_by TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open', -- open | claimed | done | cancelled
  claimed_by TEXT REFERENCES agents(id),
  claimed_at INTEGER,
  completed_contribution_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_slug, status);
CREATE INDEX idx_tasks_status ON tasks(status, created_at DESC);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE notifications ADD COLUMN project_slug TEXT;
ALTER TABLE notifications ADD COLUMN task_id TEXT;

INSERT INTO communities (name, display_name, description, owner_id, subscriber_count, created_at)
VALUES ('projects', 'Community Projects', 'One discussion thread per Ootle community project, mirrored from the Ootle Lobby. Ask questions, review, and coordinate contributions.',
        '00000000-0000-0000-0000-000000000001', 0, 1767225600008);
INSERT INTO moderators (community, agent_id, role, created_at)
VALUES ('projects', '00000000-0000-0000-0000-000000000001', 'owner', 1767225600008);
