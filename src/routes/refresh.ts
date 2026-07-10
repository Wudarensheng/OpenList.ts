import { Env } from '../types';
import { getDriverInstance } from '../drivers/registry';
// Cache invalidation is now done surgically (delete stale rows only)
import { jsonResponse } from '../utils/response';

export async function handleRefreshRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/admin/storage/refresh - Refresh all storages file cache
  if (path === '/api/admin/storage/refresh' && request.method === 'POST') {
    return handleRefreshAll(env);
  }

  // POST /api/admin/storage/refresh_one?id=xxx - Refresh specific storage
  if (path === '/api/admin/storage/refresh_one' && request.method === 'POST') {
    const id = url.searchParams.get('id');
    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }
    return handleRefreshOne(id, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



async function handleRefreshAll(env: Env): Promise<Response> {
  try {
    const storages = await env.DB.prepare(
      'SELECT * FROM storages WHERE disabled = 0'
    ).all();

    const results: any[] = [];
    for (const storage of storages.results) {
      try {
        const result = await refreshStorage(storage as any, env);
        results.push({ id: (storage as any).id, mount_path: (storage as any).mount_path, ...result });
      } catch (error: any) {
        results.push({ id: (storage as any).id, mount_path: (storage as any).mount_path, error: error.message });
      }
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: results
    });
  } catch (error: any) {
    console.error('Refresh all error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleRefreshOne(id: string, env: Env): Promise<Response> {
  try {
    const storage = await env.DB.prepare(
      'SELECT * FROM storages WHERE id = ? AND disabled = 0'
    ).bind(id).first();

    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const result = await refreshStorage(storage as any, env);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: result
    });
  } catch (error: any) {
    console.error('Refresh one error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function refreshStorage(storage: any, env: Env): Promise<any> {
  const addition = JSON.parse(storage.addition);
  const driver = await getDriverInstance(storage.driver, addition);
  const cacheExpiration = storage.cache_expiration || 30;

  // Recursively list all files first (before clearing cache)
  const files = await listAllFiles(driver, '/', addition);

  // Collect fresh file IDs for stale cleanup
  const freshFileIds: string[] = [];

  // Build batch insert statements with parent_path
  const stmts: D1PreparedStatement[] = [];
  for (const file of files) {
    const filePath = file.path;
    const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    const fileId = `${storage.id}_${filePath}`;
    freshFileIds.push(fileId);

    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO files (id, path, parent_path, name, size, modified, ctime, is_folder, hash_info, storage_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        fileId,
        filePath,
        parentPath,
        file.name,
        file.size || 0,
        file.modified || new Date().toISOString(),
        file.created || file.modified || new Date().toISOString(),
        file.is_dir ? 1 : 0,
        file.hash_info || '',
        storage.id
      )
    );
  }

  // Execute batch inserts FIRST (no cache gap)
  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }

  // Update cache timestamps for all listed directories
  const listedPaths = new Set<string>();
  listedPaths.add('/');
  for (const file of files) {
    const parentPath = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
    listedPaths.add(parentPath);
  }

  const cacheStmts = Array.from(listedPaths).map(p =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at)
       VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))`
    ).bind(p, storage.id, cacheExpiration)
  );

  for (let i = 0; i < cacheStmts.length; i += 100) {
    await env.DB.batch(cacheStmts.slice(i, i + 100));
  }

  // Delete stale files that weren't in the fresh listing
  if (freshFileIds.length > 0) {
    // Build placeholders for NOT IN clause
    const placeholders = freshFileIds.map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM files WHERE storage_id = ? AND id NOT IN (${placeholders})`
    ).bind(storage.id, ...freshFileIds).run();
  } else {
    // No files found, delete all for this storage
    await env.DB.prepare('DELETE FROM files WHERE storage_id = ?').bind(storage.id).run();
  }

  // Delete stale cache entries for directories that no longer exist
  const listedPathsArr = Array.from(listedPaths);
  if (listedPathsArr.length > 0) {
    const placeholders = listedPathsArr.map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM file_cache WHERE storage_id = ? AND path NOT IN (${placeholders})`
    ).bind(storage.id, ...listedPathsArr).run();
  }

  // Delete stale link cache entries
  await env.DB.prepare(
    'DELETE FROM file_links WHERE storage_id = ? AND path NOT IN (SELECT path FROM files WHERE storage_id = ?)'
  ).bind(storage.id, storage.id).run();

  return { files_count: files.length };
}

async function listAllFiles(driver: any, path: string, config: any): Promise<any[]> {
  const files: any[] = [];

  try {
    const result = await driver.list(path, config);

    for (const item of result.content) {
      const itemPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`;
      files.push({
        ...item,
        path: itemPath,
      });

      // Recursively list subdirectories
      if (item.is_dir) {
        try {
          const subFiles = await listAllFiles(driver, itemPath, config);
          files.push(...subFiles);
        } catch (e) {
          console.error(`Error listing ${itemPath}:`, e);
        }
      }
    }
  } catch (e) {
    console.error(`Error listing ${path}:`, e);
  }

  return files;
}
