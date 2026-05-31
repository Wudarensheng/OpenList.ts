import { Env } from '../types';
import { getDriverInstance } from '../drivers/registry';

export async function handleFsRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Verify auth token
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  let userId = 0;
  let userRole = 0;
  
  if (token) {
    try {
      const payload = JSON.parse(atob(token));
      if (payload.exp >= Date.now()) {
        userId = payload.userId;
        const user = await env.DB.prepare(
          'SELECT role FROM users WHERE id = ? AND disabled = 0'
        ).bind(userId).first();
        if (user) {
          userRole = (user as any).role;
        }
      }
    } catch (e) {
      // Ignore invalid token for guest access
    }
  }

  // POST /api/fs/list
  if (path === '/api/fs/list') {
    return handleListFiles(request, env, userId, userRole);
  }

  // POST /api/fs/get
  if (path === '/api/fs/get') {
    return handleGetFile(request, env);
  }

  // POST /api/fs/dirs
  if (path === '/api/fs/dirs') {
    return handleListDirs(request, env);
  }

  // POST /api/fs/mkdir
  if (path === '/api/fs/mkdir') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleMkdir(request, env);
  }

  // POST /api/fs/rename
  if (path === '/api/fs/rename') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleRename(request, env);
  }

  // POST /api/fs/remove
  if (path === '/api/fs/remove') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleRemove(request, env);
  }

  // POST /api/fs/move
  if (path === '/api/fs/move') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleMove(request, env);
  }

  // POST /api/fs/copy
  if (path === '/api/fs/copy') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleCopy(request, env);
  }

  // PUT /api/fs/put
  if (path === '/api/fs/put') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleUpload(request, env);
  }

  // PUT /api/fs/form
  if (path === '/api/fs/form') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    return handleFormUpload(request, env);
  }

  // POST /api/fs/search
  if (path === '/api/fs/search') {
    return jsonResponse({ code: 200, message: 'success', data: { content: [], total: 0 } });
  }

  // POST /api/fs/other
  if (path === '/api/fs/other') {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Get storage that matches the given path
async function getStorageForPath(path: string, env: Env): Promise<any> {
  const storages = await env.DB.prepare(
    'SELECT * FROM storages WHERE disabled = 0 ORDER BY mount_path DESC'
  ).all();

  for (const storage of storages.results) {
    const mountPath = (storage as any).mount_path;
    if (path.startsWith(mountPath) || mountPath === '/') {
      return storage;
    }
  }

  return null;
}

// Get all storages
async function getAllStorages(env: Env): Promise<any[]> {
  const storages = await env.DB.prepare(
    'SELECT * FROM storages WHERE disabled = 0 ORDER BY order_num ASC'
  ).all();
  return storages.results as any[];
}

// Get the relative path within a storage
function getRelativePath(path: string, mountPath: string): string {
  if (mountPath === '/') return path;
  return path.substring(mountPath.length) || '/';
}

// Get driver instance for a storage
async function getDriver(storage: any): Promise<any> {
  const addition = JSON.parse(storage.addition);
  return getDriverInstance(storage.driver, addition);
}

async function handleListFiles(request: Request, env: Env, userId: number, userRole: number): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path || '/';
    const page = body.page || 1;
    const perPage = body.per_page || 100;
    const refresh = body.refresh || false;

    // Get storage for this path
    const storage = await getStorageForPath(path, env);
    if (!storage) {
      // If path is root, list all storages as folders
      if (path === '/') {
        const storages = await getAllStorages(env);
        const content = storages.map(s => ({
          name: s.mount_path.replace(/^\//, '') || s.driver,
          size: 0,
          is_dir: true,
          modified: s.modified || new Date().toISOString(),
          created: s.modified || new Date().toISOString(),
          sign: '',
          thumb: '',
          type: 0,
          hashinfo: '',
          hash_info: {}
        }));

        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            content,
            total: content.length,
            readme: '',
            header: '',
            write: userRole >= 1,
            provider: 'local'
          }
        });
      }

      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          content: [],
          total: 0,
          readme: '',
          header: '',
          write: userRole >= 1,
          provider: 'unknown'
        }
      });
    }

    // Try cache first (from D1)
    if (!refresh) {
      const cachedFiles = await getCachedFiles(path, storage.id, env);
      if (cachedFiles && cachedFiles.length > 0) {
        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            content: cachedFiles.map((f: any) => ({
              name: f.name,
              size: f.size,
              is_dir: f.is_folder === 1,
              modified: f.modified,
              created: f.ctime || f.modified,
              sign: '',
              thumb: '',
              type: f.is_folder ? 0 : getFileType(f.name),
              hashinfo: f.hash_info || '',
              hash_info: {}
            })),
            total: cachedFiles.length,
            readme: '',
            header: '',
            write: true,
            provider: storage.driver
          }
        });
      }
    }

    // Fetch from driver
    const driver = await getDriver(storage);
    const relativePath = getRelativePath(path, storage.mount_path);
    const result = await driver.list(relativePath, JSON.parse(storage.addition));

    // Cache the results in D1
    await cacheFiles(path, storage.id, result.content, env);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        content: result.content.map((f: any) => ({
          name: f.name,
          size: f.size,
          is_dir: f.is_dir,
          modified: f.modified,
          created: f.created || f.modified,
          sign: '',
          thumb: f.thumb || '',
          type: f.is_dir ? 0 : getFileType(f.name),
          hashinfo: f.hash_info || '',
          hash_info: {}
        })),
        total: result.total,
        readme: '',
        header: '',
        write: true,
        provider: storage.driver
      }
    });
  } catch (error: any) {
    console.error('List files error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleGetFile(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;

    if (!path) {
      return jsonResponse({ code: 400, message: 'Path is required' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    // Try cache first
    const cachedFile = await getCachedFile(path, storage.id, env);
    if (cachedFile) {
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          name: cachedFile.name,
          size: cachedFile.size,
          is_dir: cachedFile.is_folder === 1,
          modified: cachedFile.modified,
          created: cachedFile.ctime || cachedFile.modified,
          sign: '',
          thumb: '',
          type: cachedFile.is_folder ? 0 : getFileType(cachedFile.name),
          hashinfo: cachedFile.hash_info || '',
          hash_info: {},
          raw_url: '',
          readme: '',
          header: '',
          provider: storage.driver,
          related: []
        }
      });
    }

    // Fetch from driver
    const driver = await getDriver(storage);
    const relativePath = getRelativePath(path, storage.mount_path);
    const file = await driver.get(relativePath, JSON.parse(storage.addition));
    
    let linkUrl = '';
    try {
      const link = await driver.link(relativePath, JSON.parse(storage.addition));
      linkUrl = link.url;
    } catch (e) {
      // Ignore link errors
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        name: file.name,
        size: file.size,
        is_dir: file.is_dir,
        modified: file.modified,
        created: file.created || file.modified,
        sign: '',
        thumb: file.thumb || '',
        type: file.is_dir ? 0 : getFileType(file.name),
        hashinfo: file.hash_info || '',
        hash_info: {},
        raw_url: linkUrl,
        readme: '',
        header: '',
        provider: storage.driver,
        related: []
      }
    });
  } catch (error: any) {
    console.error('Get file error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleListDirs(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path || '/';

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 200, message: 'success', data: [] });
    }

    // Try cache first
    const cachedDirs = await getCachedDirs(path, storage.id, env);
    if (cachedDirs && cachedDirs.length > 0) {
      return jsonResponse({
        code: 200,
        message: 'success',
        data: cachedDirs.map((f: any) => ({
          name: f.name,
          modified: f.modified
        }))
      });
    }

    // Fetch from driver
    const driver = await getDriver(storage);
    const relativePath = getRelativePath(path, storage.mount_path);
    const result = await driver.list(relativePath, JSON.parse(storage.addition));

    const dirs = result.content
      .filter((f: any) => f.is_dir)
      .map((f: any) => ({
        name: f.name,
        modified: f.modified
      }));

    return jsonResponse({ code: 200, message: 'success', data: dirs });
  } catch (error: any) {
    console.error('List dirs error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleMkdir(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;
    const name = body.name;

    if (!path || !name) {
      return jsonResponse({ code: 400, message: 'Path and name are required' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;
    const relativePath = getRelativePath(fullPath, storage.mount_path);
    await driver.mkdir(relativePath, JSON.parse(storage.addition));

    // Invalidate cache
    await invalidateCache(path, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Mkdir error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleRename(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;
    const name = body.name;

    if (!path || !name) {
      return jsonResponse({ code: 400, message: 'Path and name are required' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const relativePath = getRelativePath(path, storage.mount_path);
    await driver.rename(relativePath, name, JSON.parse(storage.addition));

    // Invalidate cache
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    await invalidateCache(parentPath, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Rename error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleRemove(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const dir = body.dir;
    const names = body.names;

    if (!dir || !names || !Array.isArray(names)) {
      return jsonResponse({ code: 400, message: 'Dir and names array are required' }, 400);
    }

    const storage = await getStorageForPath(dir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    for (const name of names) {
      const fullPath = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const relativePath = getRelativePath(fullPath, storage.mount_path);
      await driver.remove(relativePath, addition);
    }

    // Invalidate cache
    await invalidateCache(dir, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Remove error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleMove(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir;
    const dstDir = body.dst_dir;
    const names = body.names;

    if (!srcDir || !dstDir || !names) {
      return jsonResponse({ code: 400, message: 'src_dir, dst_dir and names are required' }, 400);
    }

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    for (const name of names) {
      const srcPath = srcDir === '/' ? `/${name}` : `${srcDir}/${name}`;
      const dstPath = dstDir === '/' ? `/${name}` : `${dstDir}/${name}`;
      await driver.move(getRelativePath(srcPath, storage.mount_path), getRelativePath(dstPath, storage.mount_path), addition);
    }

    // Invalidate cache
    await invalidateCache(srcDir, storage.id, env);
    await invalidateCache(dstDir, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Move error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleCopy(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir;
    const dstDir = body.dst_dir;
    const names = body.names;

    if (!srcDir || !dstDir || !names) {
      return jsonResponse({ code: 400, message: 'src_dir, dst_dir and names are required' }, 400);
    }

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    for (const name of names) {
      const srcPath = srcDir === '/' ? `/${name}` : `${srcDir}/${name}`;
      const dstPath = dstDir === '/' ? `/${name}` : `${dstDir}/${name}`;
      await driver.copy(getRelativePath(srcPath, storage.mount_path), getRelativePath(dstPath, storage.mount_path), addition);
    }

    // Invalidate cache
    await invalidateCache(dstDir, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Copy error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '/';
    const name = url.searchParams.get('name') || 'file';

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;
    const relativePath = getRelativePath(fullPath, storage.mount_path);
    const fileBuffer = await request.arrayBuffer();
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

    await driver.put(relativePath, fileBuffer, contentType, JSON.parse(storage.addition));

    // Invalidate cache
    await invalidateCache(path, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Upload error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleFormUpload(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const path = formData.get('path') as string || '/';

    if (!file) {
      return jsonResponse({ code: 400, message: 'File is required' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const fullPath = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
    const relativePath = getRelativePath(fullPath, storage.mount_path);
    const fileBuffer = await file.arrayBuffer();

    await driver.put(relativePath, fileBuffer, file.type || 'application/octet-stream', JSON.parse(storage.addition));

    // Invalidate cache
    await invalidateCache(path, storage.id, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Form upload error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// Cache helper functions
async function getCachedFiles(path: string, storageId: number, env: Env): Promise<any[]> {
  try {
    // Get files that are direct children of this path
    const files = await env.DB.prepare(
      `SELECT * FROM files 
       WHERE storage_id = ? 
       AND (
         (path = ? AND is_folder = 1) OR 
         (path LIKE ? AND path NOT LIKE ? AND is_folder = 0)
       )
       ORDER BY is_folder DESC, name ASC`
    ).bind(storageId, path, `${path}/%`, `${path}/%/%`).all();

    return files.results;
  } catch {
    return [];
  }
}

async function getCachedFile(path: string, storageId: number, env: Env): Promise<any> {
  try {
    const file = await env.DB.prepare(
      'SELECT * FROM files WHERE path = ? AND storage_id = ?'
    ).bind(path, storageId).first();

    return file;
  } catch {
    return null;
  }
}

async function getCachedDirs(path: string, storageId: number, env: Env): Promise<any[]> {
  try {
    const dirs = await env.DB.prepare(
      `SELECT * FROM files 
       WHERE path LIKE ? AND storage_id = ? AND is_folder = 1 
       AND path NOT LIKE ?
       ORDER BY name ASC`
    ).bind(`${path}%`, storageId, `${path}%/%`).all();

    return dirs.results;
  } catch {
    return [];
  }
}

async function cacheFiles(path: string, storageId: number, files: any[], env: Env): Promise<void> {
  try {
    // Clear old cache for this path
    await env.DB.prepare(
      'DELETE FROM files WHERE path LIKE ? AND storage_id = ?'
    ).bind(`${path}%`, storageId).run();

    // Insert new files
    for (const file of files) {
      const filePath = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO files (id, path, name, size, modified, ctime, is_folder, hash_info, storage_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `${storageId}_${filePath}`,
        filePath,
        file.name,
        file.size || 0,
        file.modified || new Date().toISOString(),
        file.created || file.modified || new Date().toISOString(),
        file.is_dir ? 1 : 0,
        file.hash_info || '',
        storageId
      ).run();
    }

    // Update cache timestamp
    await env.DB.prepare(
      'INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at) VALUES (?, ?, datetime("now", "+1 hour"))'
    ).bind(path, storageId).run();
  } catch (error) {
    console.error('Cache files error:', error);
  }
}

async function invalidateCache(path: string, storageId: number, env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      'DELETE FROM file_cache WHERE path = ? AND storage_id = ?'
    ).bind(path, storageId).run();

    await env.DB.prepare(
      'DELETE FROM files WHERE path LIKE ? AND storage_id = ?'
    ).bind(`${path}%`, storageId).run();
  } catch (error) {
    console.error('Invalidate cache error:', error);
  }
}

function getFileType(name: string): number {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
  const videoExts = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
  const docExts = ['doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md'];
  
  if (imageExts.includes(ext)) return 1;
  if (videoExts.includes(ext)) return 2;
  if (audioExts.includes(ext)) return 3;
  if (docExts.includes(ext)) return 4;
  return 0;
}
