CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS jobs (
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  url TEXT NOT NULL,
  salary TEXT,
  location TEXT,
  description TEXT,
  score INTEGER,
  reason TEXT,
  -- skipped | sent | applied | interview | offer | rejected | hidden
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS biz_msgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  from_owner INTEGER NOT NULL,
  name TEXT,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS biz_msgs_chat ON biz_msgs(chat_id, id);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  peer_name TEXT,
  reply TEXT NOT NULL,
  attach_resume INTEGER NOT NULL DEFAULT 0,
  -- pending | sent | skipped | superseded
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
