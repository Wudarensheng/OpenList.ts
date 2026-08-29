import { describe, it, expect } from 'vitest';
import { toPostgresSql } from './sqlite';

describe('toPostgresSql: ? placeholders', () => {
  it('converts ? to $n in order', () => {
    expect(toPostgresSql('SELECT * FROM files WHERE storage_id = ? AND path = ?')).toBe(
      'SELECT * FROM files WHERE storage_id = $1 AND path = $2'
    );
  });

  it('skips ? inside string literals', () => {
    // '? ' is part of a literal, not a placeholder
    const sql = "SELECT * FROM settings WHERE key = '?' AND value = ?";
    expect(toPostgresSql(sql)).toBe("SELECT * FROM settings WHERE key = '?' AND value = $1");
  });

  it('converts LIMIT/OFFSET and NOT IN placeholders', () => {
    expect(
      toPostgresSql(
        'SELECT parent_path, name FROM files WHERE is_folder = 0 AND (lower(name) LIKE ? OR lower(path) LIKE ?) ORDER BY is_folder DESC, name ASC LIMIT ? OFFSET ?'
      )
    ).toBe(
      'SELECT parent_path, name FROM files WHERE is_folder = 0 AND (lower(name) LIKE $1 OR lower(path) LIKE $2) ORDER BY is_folder DESC, name ASC LIMIT $3 OFFSET $4'
    );
    expect(toPostgresSql('DELETE FROM files WHERE storage_id = ? AND id NOT IN (?, ?, ?)')).toBe(
      'DELETE FROM files WHERE storage_id = $1 AND id NOT IN ($2, $3, $4)'
    );
  });
});

describe('toPostgresSql: INSERT OR REPLACE', () => {
  it('rewrites settings upsert with single-column pk', () => {
    const sql =
      'INSERT OR REPLACE INTO settings (key, value, help, type, options, group_id, flag, index_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    const out = toPostgresSql(sql);
    expect(out.startsWith('INSERT INTO settings (key, value, help, type, options, group_id, flag, index_num) VALUES (')).toBe(true);
    expect(out).toContain('ON CONFLICT (key) DO UPDATE SET');
    expect(out).toContain('value = EXCLUDED.value');
    expect(out).toContain('index_num = EXCLUDED.index_num');
    expect(out.endsWith(' RETURNING key')).toBe(true);
  });

  it('rewrites files upsert (text pk)', () => {
    const sql =
      'INSERT OR REPLACE INTO files (id, path, parent_path, name, size, modified, ctime, is_folder, hash_info, storage_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const out = toPostgresSql(sql);
    expect(out).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(out).toContain('parent_path = EXCLUDED.parent_path');
    expect(out).not.toContain('id = EXCLUDED.id');
    expect(out.endsWith(' RETURNING id')).toBe(true);
  });

  it('rewrites file_cache upsert with composite pk and parameterized datetime', () => {
    const sql =
      "INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at) VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))";
    const out = toPostgresSql(sql);
    expect(out).toContain('ON CONFLICT (path, storage_id) DO UPDATE SET expires_at = EXCLUDED.expires_at');
    expect(out).toContain("to_char((now() AT TIME ZONE 'UTC') + (('+' || $3 || ' minutes')::interval), 'YYYY-MM-DD HH24:MI:SS')");
    expect(out.endsWith(' RETURNING path')).toBe(true);
  });
});

describe('toPostgresSql: INSERT OR IGNORE', () => {
  it('rewrites to ON CONFLICT DO NOTHING', () => {
    const sql =
      "INSERT OR IGNORE INTO invalid_tokens (token_hash, expires_at) VALUES (?, datetime('now', '+1 day'))";
    const out = toPostgresSql(sql);
    expect(out.startsWith('INSERT INTO invalid_tokens (token_hash, expires_at) VALUES')).toBe(true);
    expect(out).toContain('ON CONFLICT DO NOTHING');
    expect(out).toContain("INTERVAL '+1 day'");
    expect(out.endsWith(' RETURNING token_hash')).toBe(true);
  });
});

describe('toPostgresSql: datetime / strftime', () => {
  it('converts plain datetime("now") forms (single and double quotes)', () => {
    expect(toPostgresSql("SELECT expires_at FROM file_cache WHERE expires_at > datetime('now')")).toBe(
      "SELECT expires_at FROM file_cache WHERE expires_at > to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')"
    );
    expect(toPostgresSql('UPDATE storages SET disabled = 0, modified = datetime("now") WHERE id = ?')).toBe(
      "UPDATE storages SET disabled = 0, modified = to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1"
    );
  });

  it('converts literal modifier forms', () => {
    expect(
      toPostgresSql("DELETE FROM sso_states WHERE created_at < datetime('now', '-10 minutes')")
    ).toContain("INTERVAL '-10 minutes'");
    expect(toPostgresSql("INSERT INTO sso_states (state, created_at) VALUES (?, datetime('now'))")).toContain(
      "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')"
    );
  });

  it('converts strftime to epoch extraction', () => {
    const out = toPostgresSql(
      "UPDATE users SET password = ?, salt = ?, pwd_ts = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?"
    );
    expect(out).toContain('pwd_ts = CAST(EXTRACT(EPOCH FROM now()) AS INTEGER)');
    expect(out).toContain('$3');
  });
});

describe('toPostgresSql: DDL', () => {
  it('converts AUTOINCREMENT to SERIAL', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )`;
    const out = toPostgresSql(ddl);
    expect(out).toContain('id SERIAL PRIMARY KEY');
    expect(out).toContain("DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))");
  });
});

describe('toPostgresSql: RETURNING appends', () => {
  it('appends RETURNING id for known integer-pk tables', () => {
    expect(
      toPostgresSql(
        'INSERT INTO tasks (type, name, state, status, progress, extra, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
    ).toContain('RETURNING id');
    expect(
      toPostgresSql(
        'INSERT INTO users (username, password, salt, role, disabled, base_path, permission, sso_id, allow_ldap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
    ).toContain('RETURNING id');
  });

  it('does not append RETURNING to non-INSERT statements', () => {
    expect(toPostgresSql('UPDATE tasks SET state = ? WHERE id = ?')).not.toContain('RETURNING');
    expect(toPostgresSql('SELECT * FROM users WHERE id = ?')).not.toContain('RETURNING');
  });
});

describe('toPostgresSql: native ON CONFLICT passthrough', () => {
  it('keeps ON CONFLICT(ip) DO UPDATE and rewrites embedded datetime + placeholders', () => {
    const sql =
      "INSERT INTO login_attempts (ip, count, expires_at) VALUES (?, 1, datetime('now', '+' || ? || ' seconds')) ON CONFLICT(ip) DO UPDATE SET count = count + 1, expires_at = datetime('now', '+' || ? || ' seconds')";
    const out = toPostgresSql(sql);
    expect(out).toContain('ON CONFLICT(ip) DO UPDATE SET count = count + 1');
    expect(out).toContain("(('+' || $2 || ' seconds')::interval)");
    expect(out).toContain("(('+' || $3 || ' seconds')::interval)");
    expect(out).toContain('VALUES ($1, 1, ');
  });
});
