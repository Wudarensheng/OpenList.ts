import { Env } from './types';
import { Obj as DriverFileObject, LinkResult } from './drivers/types';

// D1 stores timestamps via SQLite datetime('now'), which produces UTC strings
// like "2026-08-24 09:16:03" with no timezone marker. Parsing such a string
// with `new Date(...)` treats it as LOCAL time, which on non-UTC machines
// shifts the expiry (e.g. +8h on UTC+8 hosts) and makes every cache entry
// appear already expired. Parse it explicitly as UTC instead.
function parseD1Date(value: string): Date {
  // "2026-08-24 09:16:03" -> "2026-08-24T09:16:03Z"
  return new Date(value.replace(' ', 'T') + 'Z');
}

// Check if cache for a path is still valid
export async function isCacheValid(storageId: number, path: string, env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT expires_at FROM file_cache WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).first();

    if (!row) return false;

    const expiresAt = parseD1Date((row as any).expires_at);
    return expiresAt > new Date();
  } catch {
    return false;
  }
}

// Get cached files for a directory (direct children only)
export async function getCachedFiles(storageId: number, parentPath: string, env: Env): Promise<any[]> {
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM files
       WHERE storage_id = ? AND parent_path = ?
       ORDER BY is_folder DESC, name ASC`
    ).bind(storageId, parentPath).all();

    return Array.isArray(result.results) ? result.results : [];
  } catch {
    return [];
  }
}

// Get a single cached file by path
export async function getCachedFile(storageId: number, path: string, env: Env): Promise<any | null> {
  try {
    return await env.DB.prepare(
      'SELECT * FROM files WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).first();
  } catch {
    return null;
  }
}

// Store file list in cache (batch insert)
export async function cacheFiles(
  storageId: number,
  parentPath: string,
  files: DriverFileObject[],
  expirationMinutes: number,
  env: Env
): Promise<void> {
  try {
    // Delete old cache for this exact parent_path only
    await env.DB.prepare(
      'DELETE FROM files WHERE storage_id = ? AND parent_path = ?'
    ).bind(storageId, parentPath).run();

    // Build batch INSERT statements
    const stmts: D1PreparedStatement[] = [];
    if (files.length > 0) {
      for (const file of files) {
        const filePath = parentPath === '/' ? `/${file.name}` : `${parentPath}/${file.name}`;
        stmts.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO files (id, path, parent_path, name, size, modified, ctime, is_folder, hash_info, storage_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            `${storageId}_${filePath}`,
            filePath,
            parentPath,
            file.name,
            file.size || 0,
            file.modified || new Date().toISOString(),
            file.created || file.modified || new Date().toISOString(),
            file.is_dir ? 1 : 0,
            file.hash_info || '',
            storageId
          )
        );
      }
    }

    // Execute in batches of 100 (D1 limit)
    for (let i = 0; i < stmts.length; i += 100) {
      await env.DB.batch(stmts.slice(i, i + 100));
    }

    // Update cache expiration timestamp
    await env.DB.prepare(
      `INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at)
       VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))`
    ).bind(parentPath, storageId, expirationMinutes).run();
  } catch (error) {
    console.error('Cache files error:', error);
  }
}

// Get cached download link
export async function getCachedLink(storageId: number, path: string, env: Env): Promise<LinkResult | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT * FROM file_links WHERE storage_id = ? AND path = ? AND expires_at > datetime(\'now\')'
    ).bind(storageId, path).first();

    if (!row) return null;

    const headers = JSON.parse((row as any).headers || '{}');
    return {
      url: (row as any).url,
      header: Object.keys(headers).length > 0 ? headers : undefined,
    };
  } catch {
    return null;
  }
}

// Store download link in cache
export async function cacheLink(
  storageId: number,
  path: string,
  link: LinkResult,
  expiresInSeconds: number,
  env: Env
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO file_links (storage_id, path, url, headers, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))`
    ).bind(
      storageId,
      path,
      link.url,
      JSON.stringify(link.header || {}),
      expiresInSeconds
    ).run();
  } catch (error) {
    console.error('Cache link error:', error);
  }
}

// Invalidate cache for a specific path (precise)
export async function invalidateCache(storageId: number, path: string, env: Env): Promise<void> {
  try {
    // Delete file entries where this path is the parent (children)
    await env.DB.prepare(
      'DELETE FROM files WHERE storage_id = ? AND parent_path = ?'
    ).bind(storageId, path).run();

    // Delete the file entry itself
    await env.DB.prepare(
      'DELETE FROM files WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).run();

    // Delete cache expiration entry
    await env.DB.prepare(
      'DELETE FROM file_cache WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).run();

    // Delete cached link
    await env.DB.prepare(
      'DELETE FROM file_links WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).run();

    // Also invalidate parent directory cache so it re-lists
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    if (parentPath !== path) {
      await env.DB.prepare(
        'DELETE FROM file_cache WHERE storage_id = ? AND path = ?'
      ).bind(storageId, parentPath).run();
    }
  } catch (error) {
    console.error('Invalidate cache error:', error);
  }
}

// Invalidate link cache for a specific file
export async function invalidateLinkCache(storageId: number, path: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      'DELETE FROM file_links WHERE storage_id = ? AND path = ?'
    ).bind(storageId, path).run();
  } catch (error) {
    console.error('Invalidate link cache error:', error);
  }
}

// Invalidate cache for a subtree (directory and all children)
export async function invalidateSubtree(storageId: number, path: string, env: Env): Promise<void> {
  try {
    // Delete file entries for this path and all children
    await env.DB.prepare(
      'DELETE FROM files WHERE storage_id = ? AND (path = ? OR path LIKE ?)'
    ).bind(storageId, path, path + '/%').run();

    // Delete cache entries for this path and all children
    await env.DB.prepare(
      'DELETE FROM file_cache WHERE storage_id = ? AND (path = ? OR path LIKE ?)'
    ).bind(storageId, path, path + '/%').run();

    // Delete link cache for this path and all children
    await env.DB.prepare(
      'DELETE FROM file_links WHERE storage_id = ? AND (path = ? OR path LIKE ?)'
    ).bind(storageId, path, path + '/%').run();

    // Also invalidate parent directory cache
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    if (parentPath !== path) {
      await env.DB.prepare(
        'DELETE FROM file_cache WHERE storage_id = ? AND path = ?'
      ).bind(storageId, parentPath).run();
    }
  } catch (error) {
    console.error('Invalidate subtree error:', error);
  }
}

// Singleflight: acquire a request lock (returns true if lock acquired, false if already locked)
export async function acquireLock(key: string, timeoutSeconds: number, env: Env): Promise<boolean> {
  try {
    // Clean expired locks first
    await env.DB.prepare(
      'DELETE FROM request_locks WHERE expires_at < datetime(\'now\')'
    ).run();

    // Try to insert a new lock
    await env.DB.prepare(
      `INSERT INTO request_locks (key, started_at, expires_at)
       VALUES (?, datetime('now'), datetime('now', '+' || ? || ' seconds'))`
    ).bind(key, timeoutSeconds).run();

    return true;
  } catch {
    // Lock already exists (primary key conflict)
    return false;
  }
}

// Singleflight: release a request lock
export async function releaseLock(key: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM request_locks WHERE key = ?').bind(key).run();
  } catch (error) {
    console.error('Release lock error:', error);
  }
}

// Singleflight: check if a request is in progress
export async function isLocked(key: string, env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT key FROM request_locks WHERE key = ? AND expires_at > datetime(\'now\')'
    ).bind(key).first();
    return !!row;
  } catch {
    return false;
  }
}
