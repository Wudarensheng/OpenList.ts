import { Env } from '../types';

export async function initializeDatabase(env: Env): Promise<void> {
  try {
    // Create tables one by one
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        salt TEXT,
        role INTEGER DEFAULT 0,
        disabled INTEGER DEFAULT 0,
        sso_id TEXT,
        allow_ldap INTEGER DEFAULT 0,
        otp_secret TEXT,
        base_path TEXT DEFAULT '/',
        permission INTEGER DEFAULT 0,
        pwd_ts INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    // Migration: existing databases created before allow_ldap existed.
    try {
      await env.DB.prepare('ALTER TABLE users ADD COLUMN allow_ldap INTEGER DEFAULT 0').run();
    } catch {
      // column already exists
    }

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

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        files TEXT NOT NULL DEFAULT '[]',
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
      )
    `).run();

    // Login rate-limit tracking
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        expires_at TEXT
      )
    `).run();

    // Logged-out token blacklist
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS invalid_tokens (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      )
    `).run();

    // Long-running tasks (offline download, transfer, archive, index, ...)
    await env.DB.prepare(`
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
      )
    `).run();

    // Per-path metadata (readme/header/password/hide/access control)
    await env.DB.prepare(`
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
      )
    `).run();

    // SSO login state (CSRF) store
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sso_states (
        state TEXT PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    // Migration: add parent_path column to existing files table if missing
    try {
      await env.DB.prepare(`ALTER TABLE files ADD COLUMN parent_path TEXT NOT NULL DEFAULT ''`).run();
    } catch {
      // Column already exists, ignore
    }

    // Migrations: add salt / pwd_ts columns to existing users table if missing
    try {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN salt TEXT`).run();
    } catch {
      // Column already exists, ignore
    }
    try {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN pwd_ts INTEGER DEFAULT 0`).run();
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
      const salt = crypto.getRandomValues(new Uint8Array(16)).join('').replace(/\D/g, '');
      const saltHex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
      // Hash "admin" with the OpenList scheme (two-level sha256).
      const staticHash = await sha256Hex(`admin-https://github.com/alist-org/alist`);
      const pwdHash = await sha256Hex(`${staticHash}-${saltHex}`);
      await env.DB.prepare(
        'INSERT INTO users (username, password, salt, role, permission) VALUES (?, ?, ?, ?, ?)'
      ).bind('admin', `${saltHex}:${pwdHash}`, saltHex, 2, 0xFFFFFFFF).run();
    }

    // Insert the guest account as a real user row, disabled by default.
    // Administrators can enable/disable anonymous browsing by toggling this
    // user's disabled flag in the user list.
    const guestUser = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ?'
    ).bind('guest').first();

    if (!guestUser) {
      await env.DB.prepare(
        'INSERT INTO users (username, password, role, disabled, permission) VALUES (?, ?, ?, ?, ?)'
      ).bind('guest', '', 1, 1, 0).run();
    }

    // Migration: ensure the admin account carries admin permissions.
    await env.DB.prepare(
      'UPDATE users SET permission = ? WHERE username = ? AND role = 2 AND permission = 0'
    ).bind(0xFFFFFFFF, 'admin').run();

    // Insert default settings if not exist
    // iframe_previews: extra in-app preview tabs (Office/PDF) rendered as
    // <iframe>. Mirrors the upstream OpenList default. Supported placeholders
    // in a viewer URL: $url (raw_url), $e_url (encodeURIComponent(raw_url)).
    const defaultIframePreviews = JSON.stringify({
      'doc,docx,xls,xlsx,ppt,pptx': {
        Microsoft: 'https://view.officeapps.live.com/op/view.aspx?src=$e_url',
        Google: 'https://docs.google.com/gview?url=$e_url&embedded=true',
      },
      pdf: {
        'PDF.js': 'https://res.oplist.org.cn/pdf.js/web/viewer.html?file=$e_url',
        Browser: '$url',
      },
    }, null, 2);

    const defaultSettings = [
      // SITE
      { key: 'site_title', value: 'OpenList', help: 'Site title', type: 'string', group: 1 },
      { key: 'site_description', value: 'A file list program', help: 'Site description', type: 'string', group: 1 },
      { key: 'logo', value: '/images/logo.svg', help: 'Logo (supports dark/light via one URL per line)', type: 'string', group: 1 },
      { key: 'favicon', value: '/images/logo.png', help: 'Favicon', type: 'string', group: 1 },
      { key: 'max_connections', value: '0', help: 'Max connections (0 = unlimited)', type: 'number', group: 1 },
      { key: 'cache_expiration', value: '30', help: 'Default cache expiration (minutes)', type: 'number', group: 1 },
      { key: 'announcement', value: '', help: 'Announcement (markdown)', type: 'text', group: 1 },
      { key: 'pagination_type', value: 'all', help: 'Pagination type', type: 'select', group: 1, options: 'all,pagination,load_more,auto_load_more' },
      { key: 'default_page_size', value: '30', help: 'Default page size', type: 'number', group: 1 },
      { key: 'allow_indexed', value: 'false', help: 'Allow indexed', type: 'bool', group: 1 },
      { key: 'allow_mounted', value: 'true', help: 'Allow mounted', type: 'bool', group: 1 },
      { key: 'robots_txt', value: 'User-agent: *\nAllow: /', help: 'robots.txt content', type: 'text', group: 1 },
      // STYLE
      { key: 'main_color', value: '#1890ff', help: 'Main color', type: 'string', group: 2 },
      { key: 'home_icon', value: '🏠', help: 'Home icon', type: 'string', group: 2 },
      // PREVIEW
      { key: 'text_types', value: '.txt,.md,.json,.log,.yaml,.yml,.xml,.html,.htm,.csv,.ini,.conf,.sh,.js,.ts,.css,.sql', help: 'Text file types', type: 'text', group: 3 },
      { key: 'audio_types', value: '.mp3,.wav,.flac,.aac,.ogg,.wma,.m4a', help: 'Audio file types', type: 'text', group: 3 },
      { key: 'video_types', value: '.mp4,.avi,.mov,.wmv,.flv,.mkv,.webm,.m3u8', help: 'Video file types', type: 'text', group: 3 },
      { key: 'image_types', value: '.jpg,.jpeg,.png,.gif,.bmp,.webp,.svg,.ico', help: 'Image file types', type: 'text', group: 3 },
      { key: 'proxy_types', value: '', help: 'File types to force proxy', type: 'text', group: 3 },
      { key: 'audio_autoplay', value: 'false', help: 'Audio autoplay', type: 'bool', group: 3 },
      { key: 'video_autoplay', value: 'false', help: 'Video autoplay', type: 'bool', group: 3 },
      { key: 'preview_download_by_default', value: 'false', help: 'Preview download by default', type: 'bool', group: 3 },
      { key: 'preview_archives_by_default', value: 'false', help: 'Preview archives by default', type: 'bool', group: 3 },
      { key: 'non_efs_zip_encoding', value: 'GB18030', help: 'Charset for zip entry names without the UTF-8 flag (e.g. GB18030)', type: 'string', group: 3 },
      { key: 'iframe_previews', value: defaultIframePreviews, help: 'Extra iframe previews (JSON: ext or /regex/ -> {name: url with $url/$e_url})', type: 'text', group: 3 },
      { key: 'external_previews', value: '{}', help: 'External previews (JSON, same shape as iframe_previews)', type: 'text', group: 3 },
      { key: 'readme_autorender', value: 'true', help: 'Auto-render README', type: 'bool', group: 3 },
      // GLOBAL
      { key: 'hide_files', value: '', help: 'Hide files matching regex (one per line)', type: 'text', group: 4 },
      { key: 'customize_head', value: '', help: 'Customize head HTML', type: 'text', group: 4 },
      { key: 'customize_body', value: '', help: 'Customize body HTML', type: 'text', group: 4 },
      { key: 'link_expiration', value: '0', help: 'Signed link expiration (hours, 0 = never)', type: 'number', group: 4 },
      { key: 'sign_all', value: 'false', help: 'Sign all download links', type: 'bool', group: 4 },
      { key: 'ignore_system_files', value: 'true', help: 'Ignore system files (.DS_Store, Thumbs.db, ...)', type: 'bool', group: 4 },
      // OFFLINE DOWNLOAD
      { key: 'aria2_uri', value: '', help: 'Aria2 RPC URI', type: 'string', group: 5, flag: 1 },
      { key: 'aria2_secret', value: '', help: 'Aria2 RPC secret', type: 'string', group: 5, flag: 1 },
      { key: 'qbittorrent_url', value: '', help: 'qBittorrent Web API URL', type: 'string', group: 5, flag: 1 },
      { key: 'qbittorrent_seedtime', value: '0', help: 'qBittorrent seedtime (hours, 0 = keep forever)', type: 'number', group: 5, flag: 1 },
      { key: 'transmission_uri', value: '', help: 'Transmission RPC URI', type: 'string', group: 5, flag: 1 },
      { key: 'transmission_seedtime', value: '0', help: 'Transmission seedtime (hours, 0 = keep forever)', type: 'number', group: 5, flag: 1 },
      // SSO
      { key: 'sso_login_enabled', value: 'false', help: 'Enable SSO login', type: 'bool', group: 7 },
      { key: 'sso_login_platform', value: '', help: 'SSO platform (Casdoor, Github, Microsoft, Google, Dingtalk, OIDC)', type: 'select', group: 7, options: 'Casdoor,Github,Microsoft,Google,Dingtalk,OIDC' },
      { key: 'sso_client_id', value: '', help: 'SSO OAuth client ID', type: 'string', group: 7, flag: 1 },
      { key: 'sso_client_secret', value: '', help: 'SSO OAuth client secret', type: 'string', group: 7, flag: 1 },
      { key: 'sso_oidc_username_key', value: 'name', help: 'OIDC username claim key', type: 'string', group: 7, flag: 1 },
      { key: 'sso_organization_name', value: '', help: 'Casdoor organization name', type: 'string', group: 7, flag: 1 },
      { key: 'sso_application_name', value: '', help: 'Casdoor application name', type: 'string', group: 7, flag: 1 },
      { key: 'sso_endpoint_name', value: '', help: 'OIDC issuer / Casdoor endpoint', type: 'string', group: 7, flag: 1 },
      { key: 'sso_jwt_public_key', value: '', help: 'OIDC JWT public key', type: 'string', group: 7, flag: 1 },
      { key: 'sso_extra_scopes', value: '', help: 'Extra OIDC scopes (space separated)', type: 'string', group: 7, flag: 1 },
      { key: 'sso_auto_register', value: 'false', help: 'Auto-register users on first SSO login', type: 'bool', group: 7, flag: 1 },
      { key: 'sso_default_permission', value: '0', help: 'Default permission for auto-registered users', type: 'number', group: 7, flag: 1 },
      { key: 'sso_default_dir', value: '/', help: 'Default base path for auto-registered users', type: 'string', group: 7, flag: 1 },
      { key: 'sso_compatibility_mode', value: 'false', help: 'SSO compatibility mode', type: 'bool', group: 7 },
    ];

    for (const setting of defaultSettings) {
      const existing = await env.DB.prepare(
        'SELECT key FROM settings WHERE key = ?'
      ).bind(setting.key).first();

      if (!existing) {
        await env.DB.prepare(
          'INSERT INTO settings (key, value, help, type, options, group_id, flag) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(setting.key, setting.value, setting.help, setting.type, setting.options || '', setting.group, setting.flag || 0).run();
      }
    }

    // Migration: SSO settings belong to group 7 (SSO), not group 6 (INDEX).
    // Databases initialized before this fix stored them under group_id=6,
    // which made the frontend render them on the @manage/indexes page.
    try {
      await env.DB.prepare(
        "UPDATE settings SET group_id = 7 WHERE key LIKE 'sso_%'"
      ).run();
    } catch {
      // ignore
    }

    // Migration: add missing SSO settings (Casdoor / Dingtalk support) and
    // align visibility flags with the official OpenList (secrets stay private).
    const ssoExtra: Array<[string, string, string, string, number]> = [
      ['sso_organization_name', '', 'Casdoor organization name', 'string', 1],
      ['sso_application_name', '', 'Casdoor application name', 'string', 1],
      ['sso_jwt_public_key', '', 'OIDC JWT public key', 'string', 1],
    ];
    for (const [key, value, help, type, flag] of ssoExtra) {
      try {
        const existing = await env.DB.prepare('SELECT key FROM settings WHERE key = ?').bind(key).first();
        if (!existing) {
          await env.DB.prepare(
            'INSERT INTO settings (key, value, help, type, options, group_id, flag) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(key, value, help, type, '', 7, flag).run();
        }
      } catch {
        // ignore
      }
    }
    try {
      await env.DB.prepare(
        "UPDATE settings SET flag = 1 WHERE key IN ('sso_client_id','sso_client_secret','sso_oidc_username_key','sso_organization_name','sso_application_name','sso_endpoint_name','sso_jwt_public_key','sso_extra_scopes','sso_auto_register','sso_default_dir','sso_default_permission')"
      ).run();
      await env.DB.prepare(
        "UPDATE settings SET options = 'Casdoor,Github,Microsoft,Google,Dingtalk,OIDC' WHERE key = 'sso_login_platform'"
      ).run();
    } catch {
      // ignore
    }

    // Insert the private `token` setting (secret for token/sign HMAC).
    const tokenSetting = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('token').first();
    if (!tokenSetting || !(tokenSetting as any).value) {
      const token = randomToken(32);
      if (tokenSetting) {
        await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(token, 'token').run();
      } else {
        await env.DB.prepare(
          'INSERT INTO settings (key, value, help, type, group_id, flag) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind('token', token, 'Sign/Token secret (do not expose)', 'string', 4, 1).run();
      }
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of arr) s += chars[b % chars.length];
  return s;
}
