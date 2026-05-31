-- OpenList D1 Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role INTEGER DEFAULT 0, -- 0 = guest, 1 = user, 2 = admin
  disabled INTEGER DEFAULT 0,
  sso_id TEXT,
  otp_secret TEXT,
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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_storage_id ON files(storage_id);
CREATE INDEX IF NOT EXISTS idx_files_is_folder ON files(is_folder);
CREATE INDEX IF NOT EXISTS idx_file_cache_expires_at ON file_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_storages_mount_path ON storages(mount_path);
CREATE INDEX IF NOT EXISTS idx_storages_disabled ON storages(disabled);
