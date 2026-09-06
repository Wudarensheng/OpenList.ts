import { Env } from '../types';
import { getDriverInstance } from '../drivers/registry';
import { jsonResponse } from '../utils/response';
import { isAnonymousEnabled, getGuestUserFromDB } from './api';
import { getAuthUser, can, PERM, parseBearer } from '../utils/auth';
import { signData, getSignExpire, isSignAll } from '../utils/sign';
import { handleOfflineDownloadAdd } from '../utils/offline';
import { parseSharePath, listShare, getShareFile, shareExists } from './share';
import { getNearestMeta, canAccess, getReadme, getHeader, isMetaEncrypt, filterMetaHide } from '../utils/meta';
import { parseArchive, extractArchiveEntry, buildArchiveTree, isArchiveFile, ArchiveEntry } from '../utils/archive';
import {
  isCacheValid,
  getCachedFiles as getCachedFilesFromDB,
  getCachedFile as getCachedFileFromDB,
  cacheFiles as cacheFilesToDB,
  getCachedLink,
  invalidateCache as invalidateCacheInDB,
  invalidateLinkCache,
  invalidateSubtree,
  acquireLock,
  releaseLock,
} from '../cache';

// Office/PDF documents are rendered in-app by browser viewers (docx-preview,
// ExcelJS, pptxjs, pdf.js / native <iframe>) that fetch the raw bytes. Those
// fetches must not hit a cross-origin provider URL (no CORS), so such files:
//   - are NOT classified as TEXT (avoids the broken text/markdown tabs), and
//   - get a same-origin proxied `raw_url`.
const DOC_PREVIEW_EXTS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf']);

function isDocPreviewName(name: string): boolean {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  return DOC_PREVIEW_EXTS.has(ext);
}

export async function handleFsRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Verify auth token. Fall back to the guest user when anonymous access is
  // enabled; otherwise reject.
  const token = parseBearer(request);
  let user: any = null;
  if (token) {
    user = await getAuthUser(request, env);
  }
  if (!user) {
    const anon = await isAnonymousEnabled(env);
    if (!anon) {
      return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    }
    user = await getGuestUserFromDB(env);
  }
  const userId = user.id;
  const userRole = user.role;
  const permission = user.permission ?? 0;

  // POST /api/fs/list
  if (path === '/api/fs/list') {
    const body = await request.json().catch(() => null) as any;
    const shareHit = await tryShareList(request, body, env);
    if (shareHit) return shareHit;
    return handleListFiles(request, env, user, body);
  }

  // POST /api/fs/get
  if (path === '/api/fs/get') {
    const body = await request.json().catch(() => null) as any;
    const shareHit = await tryShareGet(request, body, env);
    if (shareHit) return shareHit;
    return handleGetFile(request, env, user, body);
  }

  // POST /api/fs/dirs
  if (path === '/api/fs/dirs') {
    return handleListDirs(request, env, user);
  }

  // POST /api/fs/mkdir
  if (path === '/api/fs/mkdir') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.WRITE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleMkdir(request, env);
  }

  // POST /api/fs/rename
  if (path === '/api/fs/rename') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.RENAME)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleRename(request, env);
  }

  // POST /api/fs/batch_rename
  if (path === '/api/fs/batch_rename') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.RENAME)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleBatchRename(request, env);
  }

  // POST /api/fs/regex_rename
  if (path === '/api/fs/regex_rename') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.RENAME)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleRegexRename(request, env);
  }

  // POST /api/fs/remove
  if (path === '/api/fs/remove') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.REMOVE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleRemove(request, env);
  }

  // POST /api/fs/remove_empty_directory
  if (path === '/api/fs/remove_empty_directory') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.REMOVE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleRemoveEmptyDirectory(request, env);
  }

  // POST /api/fs/move
  if (path === '/api/fs/move') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.MOVE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleMove(request, env);
  }

  // POST /api/fs/recursive_move
  if (path === '/api/fs/recursive_move') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.MOVE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleRecursiveMove(request, env);
  }

  // POST /api/fs/copy
  if (path === '/api/fs/copy') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.COPY)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleCopy(request, env);
  }

  // PUT /api/fs/put
  if (path === '/api/fs/put') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.WRITE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleUpload(request, env);
  }

  // PUT /api/fs/form
  if (path === '/api/fs/form') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.WRITE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleFormUpload(request, env);
  }

  // POST /api/fs/search
  if (path === '/api/fs/search') {
    return handleSearch(request, env, user);
  }

  // POST /api/fs/other
  if (path === '/api/fs/other') {
    return handleOther(request, env, user);
  }

  // POST /api/fs/link (admin only - returns the direct provider link)
  if (path === '/api/fs/link') {
    if (userRole < 2) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleLink(request, env);
  }

  // POST /api/fs/add_offline_download
  if (path === '/api/fs/add_offline_download') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.ADD_OFFLINE_DOWNLOAD)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleOfflineDownloadAdd(request, env, user);
  }

  // POST /api/fs/get_direct_upload_info
  if (path === '/api/fs/get_direct_upload_info') {
    if (!userId) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    if (!can(user, PERM.WRITE)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleGetDirectUploadInfo(request, env);
  }

  // POST /api/fs/archive/meta
  if (path === '/api/fs/archive/meta') {
    return handleArchiveMeta(request, env, user);
  }

  // POST /api/fs/archive/list
  if (path === '/api/fs/archive/list') {
    return handleArchiveList(request, env, user);
  }

  // POST /api/fs/archive/decompress
  if (path === '/api/fs/archive/decompress') {
    if (!can(user, PERM.DECOMPRESS)) return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    return handleArchiveDecompress(request, env, user);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

// If the requested path points into a share (/<sid>/...), serve it via the
// share logic. Returns a Response when handled, null otherwise.
async function tryShareList(request: Request, body: any, env: Env): Promise<Response | null> {
  const path = body?.path || '/';
  const parsed = parseSharePath(path);
  if (!parsed) return null;

  // The path is share-shaped. If the share id exists but the share is invalid
  // (wrong password, disabled, expired), report a proper error instead of
  // falling through to normal storage resolution.
  if (await shareExists(env, parsed.sid)) {
    const pwd = body?.password;
    const result = await listShare(env, parsed.sid, parsed.sharePath, pwd);
    if (!result) {
      return jsonResponse({ code: 403, message: 'Share is invalid or password is required' }, 403);
    }
    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        content: result.content,
        total: result.content.length,
        readme: result.readme,
        header: result.header,
        write: false,
        provider: 'unknown',
      }
    });
  }

  return null;
}

async function tryShareGet(request: Request, body: any, env: Env): Promise<Response | null> {
  const path = body?.path || '/';
  const parsed = parseSharePath(path);
  if (!parsed) return null;

  if (await shareExists(env, parsed.sid)) {
    const pwd = body?.password;
    const file = await getShareFile(env, parsed.sid, parsed.sharePath, pwd);
    if (!file) {
      return jsonResponse({ code: 403, message: 'Share is invalid or password is required' }, 403);
    }
    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        ...file,
        related: [],
      }
    });
  }

  return null;
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

// ---------------------------------------------------------------------------
// sign + hidden-file helpers
// ---------------------------------------------------------------------------

// Apply the hide_files regex setting to a list of items.
function filterHidden(items: any[], hideRegexes: RegExp[]): any[] {
  if (!hideRegexes.length) return items;
  return items.filter(it => !hideRegexes.some(re => re.test(it.name)));
}

async function loadHideRegexes(env: Env): Promise<RegExp[]> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('hide_files').first();
    const raw = (row as any)?.value || '';
    const regexes: RegExp[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        regexes.push(new RegExp(t));
      } catch {
        // ignore invalid regex
      }
    }
    return regexes;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleListFiles(request: Request, env: Env, user: any, preBody?: any): Promise<Response> {
  try {
    const body = preBody || await request.json() as any;
    const path = body.path || '/';
    const page = body.page || 1;
    const perPage = body.per_page || 0; // 0 = no pagination
    const refresh = body.refresh || false;
    const userRole = user.role;
    const hideRegexes = await loadHideRegexes(env);
    const signExpire = await getSignExpire(env);
    const signAll = await isSignAll(env);

    // Meta access control (folder password, read restrictions, hide, readme/header)
    const meta = await getNearestMeta(path, env);
    if (!canAccess(user, meta, path, body.password)) {
      return jsonResponse({ code: 403, message: '密码错误或无访问权限' }, 403);
    }
    const metaReadme = getReadme(meta, path);
    const metaHeader = getHeader(meta, path);
    const metaEncrypt = isMetaEncrypt(meta, path);

    // Get storage for this path
    const storage = await getStorageForPath(path, env);
    if (!storage) {
      // If path is root, list all storages as folders
      if (path === '/') {
        const storages = await getAllStorages(env);
        let content = storages.map(s => ({
          name: s.mount_path.replace(/^\//, '') || s.driver,
          size: 0,
          is_dir: true,
          modified: s.modified || new Date().toISOString(),
          created: s.modified || new Date().toISOString(),
          sign: '',
          thumb: '',
          type: 1, // FOLDER
          hashinfo: '',
          hash_info: {}
        }));
        content = filterMetaHide(filterHidden(content, hideRegexes), meta, path);

        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            content,
            total: content.length,
            readme: metaReadme,
            header: metaHeader,
            write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
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
          readme: metaReadme,
          header: metaHeader,
          write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
          provider: 'unknown'
        }
      });
    }

    const cacheExpiration = storage.cache_expiration || 30;
    const signEnabled = !!(storage.enable_sign || signAll || metaEncrypt);

    const mapCached = async (cachedFiles: any[]) => {
      const mapped: any[] = [];
      for (const f of cachedFiles) {
        const isDir = f.is_folder === 1;
        mapped.push({
          name: f.name,
          size: f.size,
          is_dir: isDir,
          modified: f.modified,
          created: f.ctime || f.modified,
          sign: signEnabled && !isDir ? await signData(
            path === '/' ? `/${f.name}` : `${path}/${f.name}`,
            signExpire, env) : '',
          thumb: '',
          type: isDir ? 1 : getFileType(f.name),
          hashinfo: f.hash_info || '',
          hash_info: {}
        });
      }
      return mapped;
    };

    // Try cache first (from D1) - check expiration
    if (!refresh) {
      const cacheValid = await isCacheValid(storage.id, path, env);
      if (cacheValid) {
        const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
        let content = await mapCached(cachedFiles);
        content = filterMetaHide(filterHidden(content, hideRegexes), meta, path);
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
            readme: metaReadme,
            header: metaHeader,
            write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
            provider: storage.driver
          }
        });
      }
    }

    // Only admins (role 2) trigger a provider fetch to populate the D1 file
    // tree. Guest / normal users always read from the cached tree.
    if (userRole < 2) {
      const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
      let content = await mapCached(cachedFiles);
      content = filterMetaHide(filterHidden(content, hideRegexes), meta, path);
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
          readme: metaReadme,
          header: metaHeader,
          write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
          provider: storage.driver
        }
      });
    }

    // Singleflight: try to acquire lock for this path
    const lockKey = `list:${storage.id}:${path}`;
    const lockAcquired = await acquireLock(lockKey, 30, env);

    if (!lockAcquired) {
      // Another request is already fetching this path, wait and retry from cache
      await new Promise(resolve => setTimeout(resolve, 500));
      const cacheValidNow = await isCacheValid(storage.id, path, env);
      const cachedFiles = await getCachedFilesFromDB(storage.id, path, env);
      if (cacheValidNow) {
        let content = await mapCached(cachedFiles);
        content = filterMetaHide(filterHidden(content, hideRegexes), meta, path);
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
            readme: metaReadme,
            header: metaHeader,
            write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
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

      let content: any[] = [];
      for (const f of files) {
        const fullPath = path === '/' ? `/${f.name}` : `${path}/${f.name}`;
        const isDir = !!f.is_dir;
        content.push({
          name: f.name,
          size: f.size,
          is_dir: isDir,
          modified: f.modified,
          created: f.created || f.modified,
          sign: signEnabled && !isDir ? await signData(fullPath, signExpire, env) : '',
          thumb: f.thumb || '',
          type: isDir ? 1 : getFileType(f.name),
          hashinfo: f.hash_info || '',
          hash_info: {}
        });
      }
      content = filterMetaHide(filterHidden(content, hideRegexes), meta, path);

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
          readme: metaReadme,
          header: metaHeader,
          write: can(user, PERM.WRITE),
          write_content_bypass: can(user, PERM.WRITE),
          direct_upload_tools: can(user, PERM.WRITE) ? ['curl', 'aria2'] : [],
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

async function handleGetFile(request: Request, env: Env, user: any, preBody?: any): Promise<Response> {
  try {
    const body = preBody || await request.json() as any;
    const path = body.path;
    const userRole = user.role;
    const signExpire = await getSignExpire(env);
    const signAll = await isSignAll(env);

    if (!path) {
      return jsonResponse({ code: 400, message: 'Path is required' }, 400);
    }

    // Meta access control
    const meta = await getNearestMeta(path, env);
    if (!canAccess(user, meta, path, body.password)) {
      return jsonResponse({ code: 403, message: '密码错误或无访问权限' }, 403);
    }
    const metaReadme = getReadme(meta, path);
    const metaHeader = getHeader(meta, path);
    const metaEncrypt = isMetaEncrypt(meta, path);

    // The root path always exists as a directory.
    if (path === '/') {
      const rootStorage = await getStorageForPath('/', env);
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          name: '/',
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          created: new Date().toISOString(),
          sign: '',
          thumb: '',
          type: 1, // FOLDER
          hashinfo: '',
          hash_info: {},
          raw_url: '',
          readme: metaReadme,
          header: metaHeader,
          provider: rootStorage ? rootStorage.driver : 'local',
          related: []
        }
      });
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const mountPath = (storage as any).mount_path;
    if (mountPath && mountPath !== '/' && path === mountPath) {
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          name: mountPath.split('/').pop() || mountPath,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          created: new Date().toISOString(),
          sign: '',
          thumb: '',
          type: 1, // FOLDER
          hashinfo: '',
          hash_info: {},
          raw_url: '',
          readme: metaReadme,
          header: metaHeader,
          provider: storage.driver,
          related: []
        }
      });
    }

    const signEnabled = !!(storage.enable_sign || signAll || metaEncrypt);

    // Try cache first.
    const cachedFile = await getCachedFileFromDB(storage.id, path, env);
    if (cachedFile) {
      let linkUrl = '';
      const isDir = cachedFile.is_folder === 1;
      if (!isDir) {
        // Office/PDF files are fetched by in-app viewers -> they need a
        // same-origin proxied URL (a provider link would be cross-origin and
        // fail CORS). Everything else may use the cached direct link.
        if (isDocPreviewName(cachedFile.name)) {
          linkUrl = await buildRawUrl(path, storage, env);
        } else {
          const cachedLinkResult = await getCachedLink(storage.id, path, env);
          if (cachedLinkResult) linkUrl = cachedLinkResult.url;
          else linkUrl = await buildRawUrl(path, storage, env);
        }
      }

      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          name: cachedFile.name,
          size: cachedFile.size,
          is_dir: isDir,
          modified: cachedFile.modified,
          created: cachedFile.ctime || cachedFile.modified,
          sign: signEnabled && !isDir ? await signData(path, signExpire, env) : '',
          thumb: '',
          type: isDir ? 1 : getFileType(cachedFile.name),
          hashinfo: cachedFile.hash_info || '',
          hash_info: {},
          raw_url: linkUrl,
          readme: metaReadme,
          header: metaHeader,
          provider: storage.driver,
          related: []
        }
      });
    }

    // Not in the cache. If the parent directory was cached recently, the file
    // genuinely does not exist in the cached tree.
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parentCached = await isCacheValid(storage.id, parentPath, env);
    if (parentCached) {
      return jsonResponse({ code: 404, message: 'File not found' }, 404);
    }

    // Non-admins only read from the cached tree.
    if (userRole < 2) {
      return jsonResponse({ code: 404, message: 'File not found' }, 404);
    }

    // Cold path: fall back to the driver.
    const cacheExpiration = storage.cache_expiration || 30;
    const lockKey = `get:${storage.id}:${path}`;
    const lockAcquired = await acquireLock(lockKey, 30, env);

    if (!lockAcquired) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryFile = await getCachedFileFromDB(storage.id, path, env);
      if (retryFile) {
        let linkUrl = '';
        const isDir = retryFile.is_folder === 1;
        if (!isDir) {
          if (isDocPreviewName(retryFile.name)) {
            linkUrl = await buildRawUrl(path, storage, env);
          } else {
            const cachedLinkResult = await getCachedLink(storage.id, path, env);
            if (cachedLinkResult) linkUrl = cachedLinkResult.url;
            else linkUrl = await buildRawUrl(path, storage, env);
          }
        }

        return jsonResponse({
          code: 200,
          message: 'success',
          data: {
            name: retryFile.name,
            size: retryFile.size,
            is_dir: isDir,
            modified: retryFile.modified,
            created: retryFile.ctime || retryFile.modified,
            sign: signEnabled && !isDir ? await signData(path, signExpire, env) : '',
            thumb: '',
            type: isDir ? 1 : getFileType(retryFile.name),
            hashinfo: retryFile.hash_info || '',
            hash_info: {},
            raw_url: linkUrl,
            readme: metaReadme,
            header: metaHeader,
            provider: storage.driver,
            related: []
          }
        });
      }
    }

    try {
      const driver = await getDriver(storage);
      const relativePath = getRelativePath(path, storage.mount_path);
      const file = await driver.get(relativePath, JSON.parse(storage.addition));

      // Persist the fetched entry.
      try {
        await cacheFilesToDB(storage.id, parentPath, [{
          name: file.name,
          size: file.size,
          is_dir: file.is_dir,
          modified: file.modified,
          created: file.created,
          hash_info: file.hash_info,
        }], cacheExpiration, env);
      } catch (e) {
        // Cache write failure should not fail the request
      }

      const isDir = !!file.is_dir;
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          name: file.name,
          size: file.size,
          is_dir: isDir,
          modified: file.modified,
          created: file.created || file.modified,
          sign: signEnabled && !isDir ? await signData(path, signExpire, env) : '',
          thumb: file.thumb || '',
          type: isDir ? 1 : getFileType(file.name),
          hashinfo: file.hash_info || '',
          hash_info: {},
          raw_url: isDir ? '' : await buildRawUrl(path, storage, env),
          readme: metaReadme,
          header: metaHeader,
          provider: storage.driver,
          related: []
        }
      });
    } finally {
      await releaseLock(lockKey, env);
    }
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.includes('Not found') || msg.includes('head failed: 404')) {
      return jsonResponse({ code: 404, message: 'File not found' }, 404);
    }
    console.error('Get file error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleListDirs(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path || '/';

    // Meta access control
    const meta = await getNearestMeta(path, env);
    if (!canAccess(user, meta, path, body.password)) {
      return jsonResponse({ code: 403, message: '密码错误或无访问权限' }, 403);
    }

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

      return jsonResponse({ code: 200, message: 'success', data: dirs });
    }

    // Non-admins only read from the cached tree.
    if (user.role < 2) {
      return jsonResponse({ code: 200, message: 'success', data: [] });
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

// ---------------------------------------------------------------------------
// write operations
// ---------------------------------------------------------------------------

async function handleMkdir(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;
    const name = body.name;

    // The frontend sends `{path: '<full new path>'}`; API clients may send
    // `{path: '<parent>', name: '<dir>'}`.
    let parentPath = path;
    let dirName = name;
    if (!dirName && path) {
      const trimmed = path.replace(/\/+$/, '');
      const idx = trimmed.lastIndexOf('/');
      parentPath = idx <= 0 ? '/' : trimmed.substring(0, idx);
      dirName = trimmed.substring(idx + 1);
    }

    if (!path || !dirName) {
      return jsonResponse({ code: 400, message: 'Path and name are required' }, 400);
    }
    if (!isSafeName(dirName)) {
      return jsonResponse({ code: 400, message: 'Invalid name' }, 400);
    }

    const storage = await getStorageForPath(parentPath, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const fullPath = parentPath === '/' ? `/${dirName}` : `${parentPath}/${dirName}`;
    const relativePath = getRelativePath(fullPath, storage.mount_path);
    await driver.mkdir(relativePath, JSON.parse(storage.addition));

    // Invalidate parent directory cache
    await invalidateCacheInDB(storage.id, parentPath, env);

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
    if (!isSafeName(name)) {
      return jsonResponse({ code: 400, message: 'Invalid name' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    // Refuse to overwrite an existing item unless explicitly requested
    if (!body.overwrite) {
      const dstPath = `${path.substring(0, path.lastIndexOf('/')) || ''}/${name}`;
      const existing = await getCachedFileFromDB(storage.id, dstPath, env);
      if (existing && existing.path !== path) {
        return jsonResponse({ code: 403, message: `file [${name}] exists` }, 403);
      }
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

async function handleBatchRename(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir;
    const renameObjects = Array.isArray(body.rename_objects) ? body.rename_objects : [];

    if (!srcDir) {
      return jsonResponse({ code: 400, message: 'src_dir is required' }, 400);
    }

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    for (const item of renameObjects) {
      const srcName = item.src_name;
      const newName = item.new_name;
      if (!srcName || !newName || !isSafeName(srcName) || !isSafeName(newName)) continue;
      const srcPath = srcDir === '/' ? `/${srcName}` : `${srcDir}/${srcName}`;
      await driver.rename(getRelativePath(srcPath, storage.mount_path), newName, addition);
      await invalidateCacheInDB(storage.id, srcPath, env);
    }

    // Refresh parent listing cache
    await invalidateCacheInDB(storage.id, srcDir, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Batch rename error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleRegexRename(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir;
    const srcRegex = body.src_name_regex;
    const newRegex = body.new_name_regex;

    if (!srcDir || !srcRegex) {
      return jsonResponse({ code: 400, message: 'src_dir and src_name_regex are required' }, 400);
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(srcRegex);
    } catch {
      return jsonResponse({ code: 400, message: 'Invalid regex' }, 400);
    }

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    // List from cache if valid, else from driver (admin refreshes provider).
    const cacheValid = await isCacheValid(storage.id, srcDir, env);
    let files: any[] = [];
    if (cacheValid) {
      files = await getCachedFilesFromDB(storage.id, srcDir, env);
    } else {
      const result = await driver.list(getRelativePath(srcDir, storage.mount_path), addition);
      files = Array.isArray(result.content) ? result.content : [];
    }

    for (const file of files) {
      const oldName = file.name;
      if (!pattern.test(oldName)) continue;
      const newName = oldName.replace(pattern, newRegex || '');
      if (!newName || !isSafeName(newName)) continue;
      const srcPath = srcDir === '/' ? `/${oldName}` : `${srcDir}/${oldName}`;
      await driver.rename(getRelativePath(srcPath, storage.mount_path), newName, addition);
      await invalidateCacheInDB(storage.id, srcPath, env);
    }

    await invalidateCacheInDB(storage.id, srcDir, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Regex rename error:', error);
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

      // Invalidate subtree for each removed item
      await invalidateSubtree(storage.id, fullPath, env);
    }

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Remove error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleRemoveEmptyDirectory(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir || '/';

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    // BFS over the cached file tree (admin refreshes from provider when cold).
    const removed: string[] = [];
    const queue: string[] = [srcDir];
    while (queue.length) {
      const dir = queue.shift()!;
      let files: any[];
      const cacheValid = await isCacheValid(storage.id, dir, env);
      if (cacheValid) {
        files = await getCachedFilesFromDB(storage.id, dir, env);
      } else {
        const result = await driver.list(getRelativePath(dir, storage.mount_path), addition);
        files = Array.isArray(result.content) ? result.content : [];
        await cacheFilesToDB(storage.id, dir, files, storage.cache_expiration || 30, env);
      }

      const subDirs = files.filter((f: any) => f.is_dir === 1 || f.is_folder === true);
      for (const sub of subDirs) {
        queue.push(dir === '/' ? `/${sub.name}` : `${dir}/${sub.name}`);
      }

      // If empty (and not the requested root), remove it
      if (files.length === 0 && dir !== srcDir) {
        try {
          await driver.remove(getRelativePath(dir, storage.mount_path), addition);
          await invalidateSubtree(storage.id, dir, env);
          removed.push(dir);
        } catch {
          // ignore
        }
      }
    }

    await invalidateCacheInDB(storage.id, srcDir, env);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { removed }
    });
  } catch (error: any) {
    console.error('Remove empty directory error:', error);
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

async function handleRecursiveMove(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const srcDir = body.src_dir || '/';
    const dstDir = body.dst_dir || '/';
    const conflictPolicy = body.conflict_policy || 'overwrite'; // overwrite | skip | cancel

    const storage = await getStorageForPath(srcDir, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);

    // Recursively walk the source directory and move each file, preserving
    // the relative directory structure.
    const walk = async (from: string, to: string): Promise<number> => {
      let moved = 0;
      const cacheValid = await isCacheValid(storage.id, from, env);
      let files: any[];
      if (cacheValid) {
        files = await getCachedFilesFromDB(storage.id, from, env);
      } else {
        const result = await driver.list(getRelativePath(from, storage.mount_path), addition);
        files = Array.isArray(result.content) ? result.content : [];
        await cacheFilesToDB(storage.id, from, files, storage.cache_expiration || 30, env);
      }

      for (const file of files) {
        const srcPath = from === '/' ? `/${file.name}` : `${from}/${file.name}`;
        const dstPath = to === '/' ? `/${file.name}` : `${to}/${file.name}`;
        const isDir = file.is_dir === 1 || file.is_dir === true;

        if (isDir) {
          // Create destination dir, then recurse
          try {
            await driver.mkdir(getRelativePath(dstPath, storage.mount_path), addition);
          } catch {
            // dir may already exist
          }
          moved += await walk(srcPath, dstPath);
          // Try to remove the now-empty source dir
          try {
            await driver.remove(getRelativePath(srcPath, storage.mount_path), addition);
            await invalidateSubtree(storage.id, srcPath, env);
          } catch {
            // not empty or failed - leave it
          }
        } else {
          // Check conflict
          const existing = await getCachedFileFromDB(storage.id, dstPath, env);
          if (existing) {
            if (conflictPolicy === 'skip') continue;
            if (conflictPolicy === 'cancel') {
              throw new Error(`file [${file.name}] exists`);
            }
          }
          await driver.move(getRelativePath(srcPath, storage.mount_path), getRelativePath(dstPath, storage.mount_path), addition);
          await invalidateSubtree(storage.id, srcPath, env);
          await invalidateCacheInDB(storage.id, to, env);
          moved++;
        }
      }
      return moved;
    };

    const count = await walk(srcDir, dstDir);
    await invalidateCacheInDB(storage.id, srcDir, env);
    await invalidateCacheInDB(storage.id, dstDir, env);

    return jsonResponse({
      code: 200,
      message: `Successfully moved ${count} ${count === 1 ? 'file' : 'files'}`
    });
  } catch (error: any) {
    console.error('Recursive move error:', error);
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
    let path: string;
    let name: string;
    const filePathHeader = request.headers.get('File-Path');
    if (filePathHeader) {
      const full = decodeURIComponent(filePathHeader);
      const idx = full.lastIndexOf('/');
      path = idx <= 0 ? '/' : full.slice(0, idx);
      name = full.slice(idx + 1) || 'file';
    } else {
      path = url.searchParams.get('path') || '/';
      name = url.searchParams.get('name') || 'file';
    }

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
    let path: string;
    let fileName: string;
    const filePathHeader = request.headers.get('File-Path');
    if (filePathHeader) {
      const full = decodeURIComponent(filePathHeader);
      const idx = full.lastIndexOf('/');
      path = idx <= 0 ? '/' : full.slice(0, idx);
      fileName = full.slice(idx + 1) || (file?.name || 'file');
    } else {
      path = formData.get('path') as string || '/';
      fileName = file?.name || 'file';
    }

    if (!file) {
      return jsonResponse({ code: 400, message: 'File is required' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const fullPath = path === '/' ? `/${fileName}` : `${path}/${fileName}`;
    const relativePath = getRelativePath(fullPath, storage.mount_path);
    const fileBuffer = await file.arrayBuffer();

    await driver.put(relativePath, fileBuffer, file.type || 'application/octet-stream', JSON.parse(storage.addition));

    await invalidateCacheInDB(storage.id, path, env);
    await invalidateLinkCache(storage.id, fullPath, env);

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Form upload error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// search / link / other / direct upload
// ---------------------------------------------------------------------------

// POST /api/fs/search - search the cached file tree in D1.
async function handleSearch(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const parent = body.parent || '/';
    const keywords = (body.keywords || '').trim();
    const scope = body.scope ?? 0; // 0 all, 1 dir, 2 file
    const page = Math.max(1, body.page || 1);
    const perPage = Math.max(1, body.per_page || 30);

    if (!keywords) {
      return jsonResponse({ code: 200, message: 'success', data: { content: [], total: 0 } });
    }

    // Search within the cached files table. Restrict to the subtree under
    // `parent` and to the user's base_path.
    const basePath = (user.base_path || '/').replace(/\/+$/, '') || '/';
    const parentPath = parent === '/' ? '/' : parent.replace(/\/+$/, '');

    const clauses: string[] = [];
    const params: any[] = [];
    const like = `%${keywords.toLowerCase()}%`;

    if (parentPath !== '/' && parentPath !== '') {
      clauses.push('(path = ? OR path LIKE ?)');
      params.push(parentPath, parentPath + '/%');
    }
    if (basePath !== '/' && basePath !== '') {
      clauses.push('(path = ? OR path LIKE ?)');
      params.push(basePath, basePath + '/%');
    }
    if (scope === 1) {
      clauses.push('is_folder = 1');
    } else if (scope === 2) {
      clauses.push('is_folder = 0');
    }

    clauses.push('(lower(name) LIKE ? OR lower(path) LIKE ?)');
    params.push(like, like);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM files ${where}`
    ).bind(...params).first();
    const total = (countRow as any)?.total || 0;

    const offset = (page - 1) * perPage;
    const rows = await env.DB.prepare(
      `SELECT parent_path, name, is_folder, size FROM files ${where}
       ORDER BY is_folder DESC, name ASC LIMIT ? OFFSET ?`
    ).bind(...params, perPage, offset).all();

    const content = (rows.results || []).map((r: any) => ({
      parent: r.parent_path || '/',
      name: r.name,
      is_dir: r.is_folder === 1,
      size: r.size || 0,
      type: r.is_folder === 1 ? 1 : getFileType(r.name),
    }));

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { content, total }
    });
  } catch (error: any) {
    console.error('Search error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/fs/other - driver-specific info (presigned upload URL for S3, etc.)
async function handleOther(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path || '/';
    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 200, message: 'success', data: {} });
    }

    const driver = await getDriver(storage);
    if (typeof driver.other === 'function') {
      const addition = JSON.parse(storage.addition);
      const data = await driver.other(getRelativePath(path, storage.mount_path), addition);
      return jsonResponse({ code: 200, message: 'success', data: data || {} });
    }
    return jsonResponse({ code: 200, message: 'success', data: {} });
  } catch (error: any) {
    console.error('Other error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/fs/link (admin only) - return the real provider download link.
async function handleLink(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path || '/';

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);
    const relativePath = getRelativePath(path, storage.mount_path);
    const link = await driver.link(relativePath, addition);

    // For drivers that require proxying, return a signed proxy URL.
    if (storage.web_proxy || (link.header && Object.keys(link.header).length > 0)) {
      const sign = await signData(path, await getSignExpire(env), env);
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          url: `/p${encodePath(path)}?d&sign=${sign}`,
          header: link.header,
        }
      });
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { url: link.url, header: link.header }
    });
  } catch (error: any) {
    console.error('Link error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/fs/get_direct_upload_info - presigned direct upload for drivers
// that support it (S3 with enable_direct_upload).
async function handleGetDirectUploadInfo(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = (body.path || '/').replace(/\/+$/, '') || '/';
    const fileName = body.file_name || body.fileName;
    if (!fileName || !isSafeName(fileName)) {
      return jsonResponse({ code: 400, message: 'Invalid file name' }, 400);
    }

    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    const driver = await getDriver(storage);
    if (typeof driver.getDirectUploadInfo !== 'function') {
      return jsonResponse({ code: 400, message: 'This driver does not support direct upload' }, 400);
    }

    const addition = JSON.parse(storage.addition);
    const dstPath = path === '/' ? `/${fileName}` : `${path}/${fileName}`;
    const relativePath = getRelativePath(dstPath, storage.mount_path);
    const info = await driver.getDirectUploadInfo(relativePath, addition);

    return jsonResponse({ code: 200, message: 'success', data: info });
  } catch (error: any) {
    console.error('Get direct upload info error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// archive endpoints
// ---------------------------------------------------------------------------

// POST /api/fs/archive/meta - full archive tree + metadata
async function handleArchiveMeta(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;
    if (!path) return jsonResponse({ code: 400, message: 'Path is required' }, 400);

    const meta = await getNearestMeta(path, env);
    if (!canAccess(user, meta, path, body.password)) {
      return jsonResponse({ code: 403, message: '密码错误或无访问权限' }, 403);
    }

    const parsed = await parseArchive(path, env);
    let content = buildArchiveTree(parsed.entries);

    const signExpire = await getSignExpire(env);
    const signAll = await isSignAll(env);
    const storage = await getStorageForPath(path, env);
    const metaEncrypt = isMetaEncrypt(meta, path);
    const signNeeded = !!(storage?.enable_sign || signAll || metaEncrypt);
    const sign = signNeeded ? await signData(path, signExpire, env) : '';
    const rawUrl = await buildRawUrl(path, storage, env);

    // The frontend appends the archive's sign to the /ae/ (inner-file) URL, so
    // propagate it onto every tree node.
    const applySign = (nodes: any[]) => {
      for (const n of nodes) {
        n.sign = sign;
        if (n.children) applySign(n.children);
      }
    };
    applySign(content);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        comment: parsed.comment,
        encrypted: parsed.encrypted,
        content,
        raw_url: rawUrl,
        sign,
      }
    });
  } catch (error: any) {
    console.error('Archive meta error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/fs/archive/list - flat listing of a directory inside the archive
async function handleArchiveList(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const path = body.path;
    const innerPath = (body.inner_path || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const page = Math.max(1, body.page || 1);
    const perPage = Math.max(0, body.per_page || 0);
    if (!path) return jsonResponse({ code: 400, message: 'Path is required' }, 400);

    const meta = await getNearestMeta(path, env);
    if (!canAccess(user, meta, path, body.password)) {
      return jsonResponse({ code: 403, message: '密码错误或无访问权限' }, 403);
    }

    const parsed = await parseArchive(path, env);

    // The frontend appends the archive's sign to the /ae/ inner-file URL.
    const signExpire = await getSignExpire(env);
    const signAll = await isSignAll(env);
    const listStorage = await getStorageForPath(path, env);
    const listMeta = await getNearestMeta(path, env);
    const signNeeded = !!(listStorage?.enable_sign || signAll || isMetaEncrypt(listMeta, path));
    const archiveSign = signNeeded ? await signData(path, signExpire, env) : '';

    // Prefix to match: entries inside innerPath (one level deep).
    const prefix = innerPath ? `/${innerPath}` : '';
    const dirNames = new Set<string>();
    const items: any[] = [];
    for (const e of parsed.entries) {
      if (prefix && !e.name.startsWith(prefix + '/')) continue;
      const rest = e.name.slice(prefix.length).replace(/^\/+/, '');
      if (!rest) continue;
      const seg = rest.split('/')[0];
      if (!seg) continue;
      if (rest.includes('/')) {
        // A deeper entry: synthesize a directory entry for the first segment.
        if (!dirNames.has(seg)) {
          dirNames.add(seg);
          items.push({
            name: seg,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            created: new Date().toISOString(),
            sign: archiveSign,
            thumb: '',
            type: 1,
            hashinfo: '',
            hash_info: {},
          });
        }
      } else {
        items.push({
          name: e.name.split('/').filter(Boolean).pop() || '',
          size: e.size,
          is_dir: e.is_dir,
          modified: e.modified || new Date().toISOString(),
          created: e.modified || new Date().toISOString(),
          sign: archiveSign,
          thumb: '',
          type: e.is_dir ? 1 : 0,
          hashinfo: '',
          hash_info: {},
        });
      }
    }
    const content = items;

    const total = content.length;
    const sliced = perPage > 0 ? content.slice((page - 1) * perPage, (page - 1) * perPage + perPage) : content;

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { content: sliced, total, readme: '', header: '' }
    });
  } catch (error: any) {
    console.error('Archive list error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/fs/archive/decompress - extract the archive into the target folder
async function handleArchiveDecompress(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    // The frontend sends src_dir/dst_dir; API clients may use src/dst.
    const src = body.src_dir || body.src || body.path;
    const dst = body.dst_dir || body.dst || body.put_into_new_dir ? undefined : body.dst;
    if (!src || !dst) {
      return jsonResponse({ code: 400, message: 'src_dir and dst_dir are required' }, 400);
    }

    const storage = await getStorageForPath(dst, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    // Create a task row so the frontend can track progress.
    const taskResult = await env.DB.prepare(
      'INSERT INTO tasks (type, name, state, status, progress, extra, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('decompress', src.split('/').filter(Boolean).pop() || src, 1, 'running', 0, JSON.stringify({ src, dst }), user.id).run();
    const taskId = Number(taskResult.meta.last_row_id);

    // Best-effort extraction: iterate entries and upload to the destination.
    const parsed = await parseArchive(src, env);
    const driver = await getDriver(storage);
    const addition = JSON.parse(storage.addition);
    let extracted = 0;
    let failed = 0;
    const files = parsed.entries.filter(e => !e.is_dir);

    for (let i = 0; i < files.length; i++) {
      const e = files[i];
      try {
        const data = await extractArchiveEntry(src, e.name, env);
        const dstPath = `${dst.replace(/\/+$/, '')}/${e.name.replace(/^\/+/, '')}`;
        const relative = getRelativePath(dstPath, storage.mount_path);
        await driver.put(relative, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, 'application/octet-stream', addition);
        await invalidateCacheInDB(storage.id, dstPath.substring(0, dstPath.lastIndexOf('/')) || '/', env);
        extracted++;
      } catch (err) {
        failed++;
      }
      if (i % 10 === 0) {
        await env.DB.prepare("UPDATE tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?").bind(files.length ? extracted / files.length : 1, taskId).run();
      }
    }

    const done = failed === 0;
    await env.DB.prepare(
      'UPDATE tasks SET state = ?, status = ?, progress = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(done ? 7 : 6, done ? 'succeeded' : 'failed', 1, taskId).run();

    return jsonResponse({
      code: 200,
      message: `Extracted ${extracted} files${failed ? `, ${failed} failed` : ''}`,
      data: { id: taskId, type: 'decompress', state: done ? 7 : 6, status: done ? 'succeeded' : 'failed', progress: 1, error: '' }
    });
  } catch (error: any) {
    console.error('Archive decompress error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isSafeName(name: string): boolean {
  return !!name && !/[/\\]/.test(name) && name !== '.' && name !== '..';
}

function encodePath(path: string): string {
  return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

// Build a frontend-facing raw download URL for a file path.
async function buildRawUrl(path: string, storage: any, env: Env): Promise<string> {
  const signAll = await isSignAll(env);
  const signEnabled = !!storage.enable_sign || signAll;

  if (storage.down_proxy_url) {
    // External download proxy
    const downProxyBase = String(storage.down_proxy_url).split('\n')[0].replace(/\/+$/, '');
    let url = `${downProxyBase}${encodePath(path)}`;
    if (!storage.disable_proxy_sign) {
      const sign = await signData(path, await getSignExpire(env), env);
      url += `?sign=${sign}`;
    }
    return url;
  }

  if (isDocPreviewName(path)) {
    // Office/PDF documents are opened by in-app viewers that fetch the raw
    // bytes from the same origin (docx-preview / ExcelJS / pptxjs / pdf.js /
    // native <iframe>). Stream them through the worker so the fetch is not
    // cross-origin; the CORS header is added in download.ts proxyLink.
    let url = `/p/${encodePath(path.replace(/^\//, ''))}?type=preview`;
    if (signEnabled) {
      const sign = await signData(path, await getSignExpire(env), env);
      url += `&sign=${sign}`;
    }
    return url;
  }

  let url = `/d/${encodePath(path.replace(/^\//, ''))}`;
  if (signEnabled) {
    const sign = await signData(path, await getSignExpire(env), env);
    url += `?sign=${sign}`;
  }
  return url;
}

function getFileType(name: string): number {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
  const videoExts = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
  const textExts = ['txt', 'md'];

  if (imageExts.includes(ext)) return 5; // IMAGE
  if (videoExts.includes(ext)) return 2; // VIDEO
  if (audioExts.includes(ext)) return 3; // AUDIO
  if (textExts.includes(ext)) return 4;  // TEXT
  return 0; // UNKNOWN
}
