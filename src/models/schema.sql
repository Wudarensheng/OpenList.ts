-- OpenList D1 Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  salt TEXT,
  role INTEGER DEFAULT 0, -- 0 = guest, 1 = user, 2 = admin
  disabled INTEGER DEFAULT 0,
  sso_id TEXT,
  allow_ldap INTEGER DEFAULT 0,
  otp_secret TEXT,
  base_path TEXT DEFAULT '/',
  permission INTEGER DEFAULT 0,
  pwd_ts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  help TEXT,
  type TEXT DEFAULT 'string', -- string, number, bool, select
  options TEXT,
  group_id INTEGER DEFAULT 0,
  flag INTEGER DEFAULT 0, -- 0 = public, 1 = private, 2 = readonly, 3 = deprecated
  index_num INTEGER DEFAULT 0
);

-- Storages table
CREATE TABLE IF NOT EXISTS storages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mount_path TEXT NOT NULL UNIQUE,
  order_num INTEGER DEFAULT 0,
  driver TEXT NOT NULL,
  cache_expiration INTEGER DEFAULT 30,
  status TEXT DEFAULT 'work',
  addition TEXT, -- JSON configuration for the driver
  remark TEXT,
  modified TEXT DEFAULT (datetime('now')),
  disabled INTEGER DEFAULT 0,
  disable_index INTEGER DEFAULT 0,
  enable_sign INTEGER DEFAULT 0,
  order_by TEXT DEFAULT 'name',
  order_direction TEXT DEFAULT 'asc',
  extract_folder TEXT DEFAULT 'front',
  web_proxy INTEGER DEFAULT 0,
  webdav_policy TEXT DEFAULT '302_redirect',
  proxy_range INTEGER DEFAULT 0,
  down_proxy_url TEXT,
  disable_proxy_sign INTEGER DEFAULT 0
);

-- Files table (cached file metadata)
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  modified TEXT,
  ctime TEXT,
  is_folder INTEGER DEFAULT 0,
  hash_info TEXT,
  storage_id INTEGER NOT NULL,
  FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);

-- File cache expiration tracking
CREATE TABLE IF NOT EXISTS file_cache (
  path TEXT NOT NULL,
  storage_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (path, storage_id),
  FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);

-- File download link cache
CREATE TABLE IF NOT EXISTS file_links (
  storage_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT DEFAULT '{}',
  expires_at TEXT NOT NULL,
  PRIMARY KEY (storage_id, path)
);

-- Request locks for singleflight dedup
CREATE TABLE IF NOT EXISTS request_locks (
  key TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- File shares
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  files TEXT NOT NULL DEFAULT '[]',      -- JSON array of shared paths
  expires TEXT,
  pwd TEXT DEFAULT '',
  accessed INTEGER DEFAULT 0,
  max_accessed INTEGER DEFAULT 0,
  creator_id INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  readme TEXT DEFAULT '',
  header TEXT DEFAULT '',
  order_by TEXT DEFAULT 'name',
  order_direction TEXT DEFAULT 'asc',
  extract_folder TEXT DEFAULT 'front',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Login rate-limit tracking
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  expires_at TEXT
);

-- Logged-out token blacklist
CREATE TABLE IF NOT EXISTS invalid_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

-- Long-running tasks (offline download, transfer, archive, index, ...)
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  state INTEGER DEFAULT 0,
  status TEXT DEFAULT '',
  progress REAL DEFAULT 0,
  error TEXT DEFAULT '',
  extra TEXT DEFAULT '{}',
  creator_id INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Per-path metadata (readme/header/password/hide/access control)
CREATE TABLE IF NOT EXISTS metas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  read_users TEXT DEFAULT '[]',
  read_users_sub INTEGER DEFAULT 0,
  write_users TEXT DEFAULT '[]',
  write_users_sub INTEGER DEFAULT 0,
  password TEXT DEFAULT '',
  p_sub INTEGER DEFAULT 0,
  write INTEGER DEFAULT 0,
  w_sub INTEGER DEFAULT 0,
  hide TEXT DEFAULT '',
  h_sub INTEGER DEFAULT 0,
  readme TEXT DEFAULT '',
  r_sub INTEGER DEFAULT 0,
  header TEXT DEFAULT '',
  header_sub INTEGER DEFAULT 0
);

-- SSO login state (CSRF) store
CREATE TABLE IF NOT EXISTS sso_states (
  state TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_parent_path_storage ON files(parent_path, storage_id);
CREATE INDEX IF NOT EXISTS idx_files_storage_id ON files(storage_id);
CREATE INDEX IF NOT EXISTS idx_files_is_folder ON files(is_folder);
CREATE INDEX IF NOT EXISTS idx_file_cache_expires_at ON file_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_storages_mount_path ON storages(mount_path);
CREATE INDEX IF NOT EXISTS idx_storages_disabled ON storages(disabled);
CREATE INDEX IF NOT EXISTS idx_file_links_expires_at ON file_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_request_locks_expires_at ON request_locks(expires_at);
