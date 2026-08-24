import { Env } from '../types';

export async function initializeDatabase(env: Env): Promise<void> {
  try {
    // Create tables one by one
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role INTEGER DEFAULT 0,
        disabled INTEGER DEFAULT 0,
        sso_id TEXT,
        otp_secret TEXT,
        base_path TEXT DEFAULT '/',
        permission INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        help TEXT,
        type TEXT DEFAULT 'string',
        options TEXT,
        group_id INTEGER DEFAULT 0,
        flag INTEGER DEFAULT 0,
        index_num INTEGER DEFAULT 0
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS storages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mount_path TEXT NOT NULL UNIQUE,
        order_num INTEGER DEFAULT 0,
        driver TEXT NOT NULL,
        cache_expiration INTEGER DEFAULT 30,
        status TEXT DEFAULT 'work',
        addition TEXT,
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
      )
    `).run();

    await env.DB.prepare(`
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
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS file_cache (
        path TEXT NOT NULL,
        storage_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (path, storage_id),
        FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS file_links (
        storage_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL,
        headers TEXT DEFAULT '{}',
        expires_at TEXT NOT NULL,
        PRIMARY KEY (storage_id, path)
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS request_locks (
        key TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `).run();

    // Migration: add parent_path column to existing files table if missing
    try {
      await env.DB.prepare(`ALTER TABLE files ADD COLUMN parent_path TEXT NOT NULL DEFAULT ''`).run();
    } catch {
      // Column already exists, ignore
    }

    // Create indexes
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_files_parent_path_storage ON files(parent_path, storage_id)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_files_storage_id ON files(storage_id)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_files_is_folder ON files(is_folder)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_file_cache_expires_at ON file_cache(expires_at)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_storages_mount_path ON storages(mount_path)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_storages_disabled ON storages(disabled)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_file_links_expires_at ON file_links(expires_at)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_request_locks_expires_at ON request_locks(expires_at)`).run();

    // Insert default admin user if not exists
    const adminUser = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ?'
    ).bind('admin').first();

    if (!adminUser) {
      await env.DB.prepare(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)'
      ).bind('admin', 'admin', 2).run();
    }

    // Insert default settings if not exist
    const defaultSettings = [
      { key: 'site_title', value: 'OpenList', help: 'Site title', type: 'string', group: 1 },
      { key: 'site_description', value: 'A file list program', help: 'Site description', type: 'string', group: 1 },
      { key: 'logo', value: '/images/logo.svg', help: 'Logo (supports dark/light via one URL per line)', type: 'string', group: 1 },
      { key: 'favicon', value: '/images/logo.png', help: 'Favicon', type: 'string', group: 1 },
      { key: 'max_connections', value: '0', help: 'Max connections (0 = unlimited)', type: 'number', group: 1 },
      { key: 'cache_expiration', value: '30', help: 'Default cache expiration (minutes)', type: 'number', group: 1 },
    ];

    for (const setting of defaultSettings) {
      const existing = await env.DB.prepare(
        'SELECT key FROM settings WHERE key = ?'
      ).bind(setting.key).first();

      if (!existing) {
        await env.DB.prepare(
          'INSERT INTO settings (key, value, help, type, group_id) VALUES (?, ?, ?, ?, ?)'
        ).bind(setting.key, setting.value, setting.help, setting.type, setting.group).run();
      }
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}
