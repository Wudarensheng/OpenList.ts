import { Env } from '../types';
import { getDriverInstance } from '../drivers/registry';

export async function handleRefreshRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/admin/storage/refresh - Refresh all storages file cache
  if (path === '/api/admin/storage/refresh' && request.method === 'POST') {
    return handleRefreshAll(env);
  }

  // POST /api/admin/storage/refresh?id=xxx - Refresh specific storage
  if (path === '/api/admin/storage/refresh_one' && request.method === 'POST') {
    const id = url.searchParams.get('id');
    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }
    return handleRefreshOne(id, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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
  
  // Clear old cache for this storage
  await env.DB.prepare('DELETE FROM files WHERE storage_id = ?').bind(storage.id).run();
  await env.DB.prepare('DELETE FROM file_cache WHERE storage_id = ?').bind(storage.id).run();

  // Recursively list all files
  const files = await listAllFiles(driver, '/', addition);
  
  // Insert files into cache
  let inserted = 0;
  for (const file of files) {
    const filePath = file.path;
    const fileId = `${storage.id}_${filePath}`;
    
    await env.DB.prepare(
      `INSERT OR REPLACE INTO files (id, path, name, size, modified, ctime, is_folder, hash_info, storage_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      fileId,
      filePath,
      file.name,
      file.size || 0,
      file.modified || new Date().toISOString(),
      file.created || file.modified || new Date().toISOString(),
      file.is_dir ? 1 : 0,
      file.hash_info || '',
      storage.id
    ).run();
    inserted++;
  }

  // Update cache timestamp
  await env.DB.prepare(
    'INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at) VALUES (?, ?, datetime("now", "+24 hours"))'
  ).bind('/', storage.id).run();

  return { files_count: inserted };
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
