import { Env } from '../types';
import { getDriverInstance } from '../drivers/registry';
import { jsonResponse } from '../utils/response';
import {
  isCacheValid,
  getCachedFiles as getCachedFilesFromDB,
  getCachedFile as getCachedFileFromDB,
  cacheFiles as cacheFilesToDB,
  getCachedLink,
  cacheLink,
  invalidateCache as invalidateCacheInDB,
  invalidateLinkCache,
  invalidateSubtree,
  acquireLock,
  releaseLock,
} from '../cache';

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
    return handleGetFile(request, env, userId, userRole);
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



// Get storage that matches the given path
export async function getStorageForPath(path: string, env: Env): Promise<any> {
  try {
    const storages = await env.DB.prepare(
      'SELECT * FROM storages WHERE disabled = 0 ORDER BY mount_path DESC'
    ).all();

    const results = Array.isArray(storages.results) ? storages.results : [];
    for (const storage of results) {
      const mountPath = (storage as any).mount_path;
      if (path.startsWith(mountPath) || mountPath === '/') {
        return storage;
      }
    }
  } catch (e) {
    console.error('getStorageForPath error:', e);
  }

  return null;
}

// Get all storages
async function getAllStorages(env: Env): Promise<any[]> {
  try {
    const storages = await env.DB.prepare(
      'SELECT * FROM storages WHERE disabled = 0 ORDER BY order_num ASC'
    ).all();
    return Array.isArray(storages.results) ? storages.results : [];
  } catch {
    return [];
  }
}

// Get the relative path within a storage
export function getRelativePath(path: string, mountPath: string): string {
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
    const perPage = body.per_page || 0; // 0 = no pagination
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

    const cacheExpiration = storage.cache_expiration || 30;

    // Try cache first (from D1) - check expiration
    if (!refresh) {
      const cacheValid = await isCacheValid(storage.id, path, env);
      if (cacheValid) {
        const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
        if (cachedFiles && cachedFiles.length > 0) {
          let content = cachedFiles.map((f: any) => ({
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
          }));

          // Apply pagination
          const total = content.length;
          if (perPage > 0) {
            const start = (page - 1) * perPage;
            content = content.slice(start, start + perPage);
          }

          return jsonResponse({
            code: 200,
            message: 'success',
            data: {
              content,
              total,
              readme: '',
              header: '',
              write: userRole >= 1,
              provider: storage.driver
            }
          });
        }
      }
    }

    // Singleflight: try to acquire lock for this path
    const lockKey = `list:${storage.id}:${path}`;
    const lockAcquired = await acquireLock(lockKey, 30, env);

    if (!lockAcquired) {
      // Another request is already fetching this path, wait and retry from cache
      await new Promise(resolve => setTimeout(resolve, 500));
      const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
      if (cachedFiles && cachedFiles.length > 0) {
        let content = cachedFiles.map((f: any) => ({
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
        }));

        const total = content.length;
        if (perPage > 0) {
          const start = (page - 1) * perPage;
          content = content.slice(start, start + perPage);
        }

        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            content,
            total,
            readme: '',
            header: '',
            write: userRole >= 1,
            provider: storage.driver
          }
        });
      }
    }

    try {
      // Fetch from driver
      const driver = await getDriver(storage);
      const relativePath = getRelativePath(path, storage.mount_path);
      const result = await driver.list(relativePath, JSON.parse(storage.addition));
      const files = Array.isArray(result.content) ? result.content : [];

      // Cache the results in D1
      await cacheFilesToDB(storage.id, path, files, cacheExpiration, env);

      let content = files.map((f: any) => ({
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
      }));

      // Apply pagination
      const total = content.length;
      if (perPage > 0) {
        const start = (page - 1) * perPage;
        content = content.slice(start, start + perPage);
      }

      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          content,
          total,
          readme: '',
          header: '',
          write: userRole >= 1,
          provider: storage.driver
        }
      });
    } finally {
      // Release lock
      await releaseLock(lockKey, env);
    }
  } catch (error: any) {
    console.error('List files error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleGetFile(request: Request, env: Env, userId: number, userRole: number): Promise<Response> {
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

    const cacheExpiration = storage.cache_expiration || 30;

    // Try cache first
    const cachedFile = await getCachedFileFromDB(storage.id, path, env);
    if (cachedFile) {
      // Try cached link first
      let linkUrl = '';
      const cachedLinkResult = await getCachedLink(storage.id, path, env);
      if (cachedLinkResult) {
        linkUrl = cachedLinkResult.url;
      } else {
        // Fetch link from driver with singleflight
        const linkLockKey = `link:${storage.id}:${path}`;
        const linkLockAcquired = await acquireLock(linkLockKey, 30, env);

        if (!linkLockAcquired) {
          // Wait for other request to populate link cache
          await new Promise(resolve => setTimeout(resolve, 500));
          const retryLink = await getCachedLink(storage.id, path, env);
          if (retryLink) linkUrl = retryLink.url;
        } else {
          try {
            const driver = await getDriver(storage);
            const relativePath = getRelativePath(path, storage.mount_path);
            const link = await driver.link(relativePath, JSON.parse(storage.addition));
            linkUrl = link.url;
            await cacheLink(storage.id, path, link, cacheExpiration * 60, env);
          } catch (e) {
            // Ignore link errors for directories or unsupported drivers
          } finally {
            await releaseLock(linkLockKey, env);
          }
        }
      }

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
          raw_url: linkUrl,
          readme: '',
          header: '',
          provider: storage.driver,
          related: []
        }
      });
    }

    // Singleflight: try to acquire lock for fetching file info
    const lockKey = `get:${storage.id}:${path}`;
    const lockAcquired = await acquireLock(lockKey, 30, env);

    if (!lockAcquired) {
      // Wait for other request to populate cache
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryFile = await getCachedFileFromDB(storage.id, path, env);
      if (retryFile) {
        let linkUrl = '';
        const cachedLinkResult = await getCachedLink(storage.id, path, env);
        if (cachedLinkResult) linkUrl = cachedLinkResult.url;

        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            name: retryFile.name,
            size: retryFile.size,
            is_dir: retryFile.is_folder === 1,
            modified: retryFile.modified,
            created: retryFile.ctime || retryFile.modified,
            sign: '',
            thumb: '',
            type: retryFile.is_folder ? 0 : getFileType(retryFile.name),
            hashinfo: retryFile.hash_info || '',
            hash_info: {},
            raw_url: linkUrl,
            readme: '',
            header: '',
            provider: storage.driver,
            related: []
          }
        });
      }
    }

    try {
      // Fetch from driver
      const driver = await getDriver(storage);
      const relativePath = getRelativePath(path, storage.mount_path);
      const file = await driver.get(relativePath, JSON.parse(storage.addition));

      let linkUrl = '';
      try {
        const link = await driver.link(relativePath, JSON.parse(storage.addition));
        linkUrl = link.url;
        await cacheLink(storage.id, path, link, cacheExpiration * 60, env);
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
    } finally {
      await releaseLock(lockKey, env);
    }
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
    const cacheValid = await isCacheValid(storage.id, path, env);
    if (cacheValid) {
      const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
      const dirs = cachedFiles
        .filter((f: any) => f.is_folder === 1)
        .map((f: any) => ({
          name: f.name,
          modified: f.modified
        }));

      if (dirs.length > 0) {
        return jsonResponse({ code: 200, message: 'success', data: dirs });
      }
    }

    // Fetch from driver
    const driver = await getDriver(storage);
    const relativePath = getRelativePath(path, storage.mount_path);
    const result = await driver.list(relativePath, JSON.parse(storage.addition));
    const files = Array.isArray(result.content) ? result.content : [];

    // Cache results
    const cacheExpiration = storage.cache_expiration || 30;
    await cacheFilesToDB(storage.id, path, files, cacheExpiration, env);

    const dirs = files
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

    // Invalidate parent directory cache
    await invalidateCacheInDB(storage.id, path, env);

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

    // Invalidate the item and its parent
    await invalidateCacheInDB(storage.id, path, env);

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

      // Invalidate subtree for each removed item (handles both files and directories)
      await invalidateSubtree(storage.id, fullPath, env);
    }

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

      // Invalidate source subtree and destination parent
      await invalidateSubtree(storage.id, srcPath, env);
      await invalidateCacheInDB(storage.id, dstDir, env);
    }

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

    // Invalidate destination cache
    await invalidateCacheInDB(storage.id, dstDir, env);

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

    // Invalidate parent directory cache and specific file link cache
    await invalidateCacheInDB(storage.id, path, env);
    await invalidateLinkCache(storage.id, fullPath, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Upload error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleFormUpload(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as unknown as File;
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

    // Invalidate parent directory cache and specific file link cache
    await invalidateCacheInDB(storage.id, path, env);
    await invalidateLinkCache(storage.id, fullPath, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Form upload error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
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
