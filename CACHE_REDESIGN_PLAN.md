# OpenList.ts D1 File Cache Redesign — Implementation Plan

## 1. Bug Inventory

Every defect found during code analysis, with file:line references:

| # | Location | Bug | Fix |
|---|---|---|---|
| B1 | `fs.ts:614-631` | `getCachedFiles` never checks `file_cache.expires_at` | Join against `file_cache` and compare `expires_at > datetime('now')` |
| B2 | `fs.ts:663-665` | `DELETE ... WHERE path LIKE '${path}%'` matches `/photos-backup` when path=`/photos` | Use `${path}/%` with trailing separator |
| B3 | `fs.ts:701-703` | `invalidateCache` same prefix-overreach as B2 | Same fix: `${path}/%` |
| B4 | `fs.ts:645-658` | `getCachedDirs` LIKE `${path}%` matches sibling dirs | Use `parent_path` column for exact match |
| B5 | `fs.ts:660-693` | N+1 D1 inserts in `cacheFiles()` | Use `env.DB.batch()` |
| B6 | `fs.ts:687-689` | Hardcoded `+1 hour` TTL ignores `storage.cache_expiration` | Read `storage.cache_expiration` and compute TTL |
| B7 | `refresh.ts:117-119` | Hardcoded `+24 hours` TTL | Same fix: use per-storage TTL |
| B8 | `refresh.ts:87-88` | Deletes all cache before rebuild | Swap: insert new rows first, then delete stale ones |
| B9 | `refresh.ts:95-114` | N+1 D1 inserts during refresh | Use `env.DB.batch()` |
| B10 | `fs.ts:222,256` | `write: true` hardcoded, ignores `userRole` | Set `write: userRole >= 1` |
| B11 | `fs.ts:345-385` | `handleListDirs` never persists results | Cache dir listing after driver fetch |
| B12 | `fs.ts:147-148` | `page`/`per_page` accepted but unused | Implement pagination in cache layer |
| B13 | `fs.ts:280` | `getCachedFile` ignores expiry | Add expiry check |
| B14 | `s3.ts:111-122` | `get()` uses HeadObject, fails for directories | Check `is_dir` from cache or use ListObjects prefix |
| B15 | `aliyundrive_open.ts:297-321` | `getFileId()` N API calls per path, no caching | Add path→fileId mapping table or in-request memo |
| B16 | `aliyundrive_open.ts:88-112` | `list()` max 200, no continuation | Follow `next_marker` pagination |
| B17 | `onedrive.ts:106-119` | `list()` max ~200, no `@odata.nextLink` | Follow pagination links |
| B18 | `s3.ts:66-109` | `list()` max 1000, no `ContinuationToken` | Loop with `ContinuationToken` |
| B19 | `fs.ts:310-316` | `link()` headers discarded | Store headers in `file_links` table |
| B20 | `registry.ts:67` | `JSON.stringify(config)` as cache key is order-sensitive | Sort keys before stringify, or use storage ID |

---

## 2. Database Schema Changes

### 2.1 Modified `files` table — add `parent_path` column

The current `getCachedFiles` and `getCachedDirs` use fragile LIKE patterns to find children of a directory. Adding a `parent_path` column enables exact-match queries.

**Migration SQL** (add to `runMigrations()` in `init.ts`):
```sql
ALTER TABLE files ADD COLUMN parent_path TEXT;
CREATE INDEX IF NOT EXISTS idx_files_parent_path ON files(parent_path, storage_id);
```

**Backfill** existing rows:
```sql
UPDATE files SET parent_path = CASE
  WHEN path = '/' THEN ''
  ELSE rtrim(substr(path, 1, length(path) - length(name) - 1), '/')
END;
```

**New child query** (replaces all LIKE-based child lookups):
```sql
SELECT * FROM files
WHERE storage_id = ?1 AND parent_path = ?2
ORDER BY is_folder DESC, name ASC;
```

This eliminates B2, B3, B4 in one stroke — no more prefix matching.

### 2.2 New `file_links` table

Presigned URLs have their own TTL (often 1h for S3, shorter for others). Caching them avoids re-signing on every request.

```sql
CREATE TABLE IF NOT EXISTS file_links (
  file_path   TEXT    NOT NULL,
  storage_id  INTEGER NOT NULL,
  url         TEXT    NOT NULL,
  header      TEXT,            -- JSON-encoded Record<string,string>
  expires_at  TEXT    NOT NULL,
  PRIMARY KEY (file_path, storage_id),
  FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_links_expires_at ON file_links(expires_at);
```

### 2.3 New `request_locks` table (D1 singleflight)

CF Workers have no shared memory. Use D1 as a lightweight lock coordinator to prevent thundering-herd on cache miss.

```sql
CREATE TABLE IF NOT EXISTS request_locks (
  lock_key    TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_locks_expires_at ON request_locks(expires_at);
```

### 2.4 Where to put migration code

Add a `runMigrations(env)` function at the bottom of `src/models/init.ts`, called at the end of `initializeDatabase()`. All statements use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN` with try-catch for idempotency.

Also update `src/models/schema.sql` to include the new tables/columns for documentation purposes (it's not executed directly — `init.ts` runs programmatically).

---

## 3. Cache Manager Module

**New file: `src/cache.ts`**

Extract all cache logic from `fs.ts` into a dedicated module. This is the core of the redesign.

### 3.1 Exported Functions

```typescript
// src/cache.ts
import { Env } from './types';

// --- TTL helpers ---
function computeExpiresAt(minutes: number): string;
// Returns ISO string of now + minutes

// --- Cache validity ---
async function isCacheValid(path: string, storageId: number, env: Env): Promise<boolean>;
// SELECT expires_at FROM file_cache WHERE path=? AND storage_id=?
// Compare against datetime('now')

// --- File listing cache ---
async function getCachedChildren(
  parentPath: string, storageId: number, env: Env
): Promise<any[] | null>;
// 1. Check isCacheValid(parentPath, storageId, env)
// 2. If expired, return null
// 3. SELECT * FROM files WHERE storage_id=? AND parent_path=?
//    ORDER BY is_folder DESC, name ASC

async function cacheDirectoryContents(
  parentPath: string, storageId: number, files: DriverFileObject[],
  ttlMinutes: number, env: Env
): Promise<void>;
// 1. Compute filePaths for each file
// 2. Build batch of INSERT OR REPLACE statements
// 3. Use env.DB.batch() — single round-trip
// 4. INSERT OR REPLACE INTO file_cache (path, storage_id, expires_at)

// --- Single file cache ---
async function getCachedFile(
  path: string, storageId: number, env: Env
): Promise<any | null>;
// 1. Check file_cache expiry for parent directory
// 2. SELECT * FROM files WHERE path=? AND storage_id=?

// --- Dir listing cache ---
async function getCachedDirs(
  parentPath: string, storageId: number, env: Env
): Promise<any[] | null>;
// Check expiry, then SELECT from files WHERE parent_path=? AND is_folder=1

// --- Invalidation ---
async function invalidateDirectory(
  parentPath: string, storageId: number, env: Env
): Promise<void>;
// 1. DELETE FROM files WHERE parent_path=? AND storage_id=?
// 2. DELETE FROM file_cache WHERE path=? AND storage_id=?
// Uses exact parent_path match — no LIKE

async function invalidateSubtree(
  path: string, storageId: number, env: Env
): Promise<void>;
// For move/remove of directories — needs prefix delete
// DELETE FROM files WHERE (path = ? OR path LIKE ?) AND storage_id = ?
// WHERE the LIKE uses path + '/%' (with separator)

// --- Link cache ---
async function getCachedLink(
  filePath: string, storageId: number, env: Env
): Promise<{ url: string; header: Record<string, string> } | null>;

async function cacheLink(
  filePath: string, storageId: number, url: string,
  header: Record<string, string>, ttlMinutes: number, env: Env
): Promise<void>;

// --- Lock cleanup ---
async function cleanExpiredLocks(env: Env): Promise<void>;
// DELETE FROM request_locks WHERE expires_at < datetime('now')
// Called opportunistically (not on every request)
```

### 3.2 Key Design Decisions

1. **`parent_path` column** replaces all LIKE-based child lookups. Every `getCachedChildren` and `getCachedDirs` becomes an exact-match query on `(parent_path, storage_id)`.

2. **`env.DB.batch()`** for bulk inserts. D1 batch sends all statements in a single HTTP round-trip. A directory with 500 files goes from 500 D1 calls to 1.

3. **TTL is always computed from `storage.cache_expiration`**. The caller passes the TTL in minutes; the cache module never reads the storage table directly.

4. **Expiry check happens at the directory level** via `file_cache` table. Individual files don't have their own expiry — the entire directory listing expires together.

---

## 4. Singleflight / Request Dedup

**New file: `src/singleflight.ts`**

### 4.1 Algorithm

When a request for `/api/fs/list` with path `/photos` arrives:

1. Compute `lock_key = "list:{storage_id}:{path}"`.
2. Try `INSERT INTO request_locks (lock_key, expires_at) VALUES (?, datetime('now', '+30 seconds'))`.
   - If insert succeeds → this worker "owns" the lock. Proceed with driver fetch.
   - If insert fails (PRIMARY KEY conflict) → another worker is already fetching.
3. The waiting worker polls `file_cache` for up to 10 seconds (sleep 500ms between checks).
   - If cache becomes valid → return cached data.
   - If timeout → proceed with its own driver fetch (fallback, don't block forever).
4. After the owning worker finishes, it deletes the lock row.
5. Opportunistically clean expired locks: `DELETE FROM request_locks WHERE expires_at < datetime('now', '-1 minute')`.

### 4.2 Interface

```typescript
// src/singleflight.ts

export async function withSingleflight<T>(
  lockKey: string,
  env: Env,
  fn: () => Promise<T>,
  waitForResult: () => Promise<T | null>,
  options?: { lockTtlSeconds?: number; waitTimeoutMs?: number }
): Promise<T>;
```

The caller provides:
- `fn`: the expensive operation to run if we acquire the lock
- `waitForResult`: a function that checks if the result appeared (e.g., re-check cache)

### 4.3 Lock Key Design

| Operation | Lock Key Pattern |
|---|---|
| List files | `list:{storage_id}:{path}` |
| Get file | `get:{storage_id}:{path}` |
| List dirs | `dirs:{storage_id}:{path}` |
| Full refresh | `refresh:{storage_id}` |

---

## 5. Changes to fs.ts Route Handlers

### 5.1 `handleListFiles` (lines 143-263)

**Current flow**: try cache → miss → driver → cache result → return
**New flow**:

```
1. Parse path, page, per_page, refresh from request body
2. Find storage via getStorageForPath()
3. If path == '/', return virtual folder listing (storages) — no change
4. If refresh == true, skip cache (but still use singleflight for the driver call)
5. Try getCachedChildren(path, storageId, env) from cache module
6. If cache hit and not expired → apply pagination → return
7. Cache miss: use withSingleflight() to deduplicate concurrent requests
   a. Inside lock: call driver.list(relativePath, config)
   b. Pass result to cacheDirectoryContents() with storage.cache_expiration TTL
   c. Apply pagination to result
   d. Return
8. Set write field based on userRole (not hardcoded true)
```

**Pagination implementation**:
```typescript
const start = (page - 1) * perPage;
const paged = allFiles.slice(start, start + perPage);
return jsonResponse({
  code: 200, message: 'success',
  data: {
    content: paged.map(/* ... */),
    total: allFiles.length,
    page,
    per_page: perPage,
    // ...rest
  }
});
```

### 5.2 `handleGetFile` (lines 265-343)

**Changes**:
- Add expiry check to `getCachedFile` (fixes B13)
- Cache link URL via `cacheLink()` after calling `driver.link()`
- Before calling `driver.link()`, check `getCachedLink()`
- For S3 directories: if `cachedFile.is_folder`, skip `driver.link()` call (fixes B14)

### 5.3 `handleListDirs` (lines 345-385)

**Changes**:
- After fetching from driver, persist results via `cacheDirectoryContents()` (fixes B11)
- Use `getCachedDirs()` with expiry check from cache module

### 5.4 Write Operations (mkdir, rename, remove, move, copy, upload, form)

**Changes to invalidation calls**:
- Replace `invalidateCache(path, storageId, env)` with `invalidateDirectory(path, storageId, env)` for the parent
- For `remove` and `move` of directories, also call `invalidateSubtree()` to clean child entries
- For `move`, invalidate both source and destination parent directories
- For `copy`, invalidate destination parent

**Surgical cache updates** (optimistic):
After a successful `mkdir`, instead of invalidating the whole parent cache, INSERT the new directory entry directly:
```typescript
await cacheDirectoryContents(parentPath, storageId, [newDirEntry], ttl, env);
```
This avoids a full re-fetch just because one item was added.

After `rename`, UPDATE the existing row's `name` and `path` columns rather than invalidating.

After `remove`, DELETE just the removed rows from `files` table.

### 5.5 Remove Embedded Cache Functions

Delete lines 613-707 from `fs.ts`. All cache logic now lives in `src/cache.ts`.

---

## 6. Changes to refresh.ts

### 6.1 `refreshStorage()` Rewrite

**Current**: delete everything → recursively list → insert one-by-one
**New**: recursive list → batch insert → delete only stale entries

```
1. Parse storage config, get driver instance
2. Call listAllFiles() recursively (unchanged)
3. Compute all (path, parent_path, name, ...) tuples
4. Use env.DB.batch() to INSERT OR REPLACE all files in one round-trip
5. INSERT OR REPLACE INTO file_cache for each directory path with correct TTL
6. Delete files that exist in DB for this storage but were NOT in the fresh listing
   DELETE FROM files WHERE storage_id = ? AND id NOT IN (batch of fresh IDs)
   (This removes files that were deleted from the cloud since last refresh)
7. Delete file_cache entries for directories that no longer exist
```

This fixes B8 (no cache gap during refresh) and B9 (batch inserts).

### 6.2 TTL Fix

Replace hardcoded `datetime("now", "+24 hours")` with:
```typescript
const ttlMinutes = storage.cache_expiration || 30;
const expiresAt = computeExpiresAt(ttlMinutes);
```
Fixes B7.

### 6.3 Batch Insert Optimization

Instead of N individual `INSERT OR REPLACE` calls, build one batch:
```typescript
const stmts = files.map(f => env.DB.prepare(
  `INSERT OR REPLACE INTO files (id, path, parent_path, name, size, modified, ctime, is_folder, hash_info, storage_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(f.id, f.path, f.parentPath, f.name, f.size, f.modified, f.ctime, f.isFolder, f.hashInfo, storageId));

await env.DB.batch(stmts);
```

D1 batch limit is ~100 statements per call. For large storages, chunk into batches of 80.

### 6.4 `listAllFiles()` — Add Pagination

For drivers that support pagination (S3 continuation tokens, OneDrive `@odata.nextLink`, Aliyundrive `next_marker`), modify the driver's `list()` method to accept/return continuation state. The recursive `listAllFiles` loops until all pages are fetched.

---

## 7. Driver Fixes

### 7.1 S3 Driver (`src/drivers/s3.ts`)

**Fix B14 — `get()` for directories**:
```typescript
async get(path: string, config: Record<string, any>): Promise<FileObject> {
  const key = this.getKey(path);
  try {
    const command = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    const response = await this.client.send(command);
    return {
      name: path.split('/').pop() || path,
      size: response.ContentLength || 0,
      is_dir: false,
      modified: response.LastModified?.toISOString() || new Date().toISOString(),
    };
  } catch (e: any) {
    // HeadObject fails for directories — check if it's a prefix
    const prefix = key.endsWith('/') ? key : key + '/';
    const listCmd = new ListObjectsV2Command({
      Bucket: this.bucket, Prefix: prefix, MaxKeys: 1,
    });
    const listResp = await this.client.send(listCmd);
    if (listResp.Contents && listResp.Contents.length > 0) {
      return {
        name: path.split('/').pop() || path,
        size: 0,
        is_dir: true,
        modified: listResp.Contents[0].LastModified?.toISOString() || new Date().toISOString(),
      };
    }
    throw e; // Not found at all
  }
}
```

**Fix B18 — Pagination in `list()`**:
```typescript
async list(path: string, config: Record<string, any>): Promise<ListResult> {
  const prefix = this.getKey(path);
  const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '';
  const content: FileObject[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: normalizedPrefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    });
    const response = await this.client.send(command);
    // ... process CommonPrefixes and Contents as before ...
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return { content, total: content.length };
}
```

### 7.2 OneDrive Driver (`src/drivers/onedrive.ts`)

**Fix B17 — Pagination in `list()`**:
```typescript
async list(path: string, config: Record<string, any>): Promise<ListResult> {
  let apiPath = `${this.encodePath(path)}:/children`;
  const content: FileObject[] = [];

  while (apiPath) {
    const data = await this.request(apiPath, config);
    for (const item of (data.value || [])) {
      content.push({
        name: item.name,
        size: item.size || 0,
        is_dir: !!item.folder,
        modified: item.lastModifiedDateTime || new Date().toISOString(),
        created: item.createdDateTime,
        thumb: item.thumbnails?.[0]?.small?.url,
      });
    }
    apiPath = data['@odata.nextLink']
      ? data['@odata.nextLink'].replace(GRAPH_API, '')
      : '';
  }

  return { content, total: content.length };
}
```

### 7.3 Aliyundrive Driver (`src/drivers/aliyundrive_open.ts`)

**Fix B15 — Path-to-fileId caching**:

Add a `Map<string, string>` field `private pathIdCache = new Map<string, string>()` to the class. Populate it during `list()` (we already get `file_id` for each item from the API). Clear it on `init()`. Use it in `getFileId()`:

```typescript
private pathIdCache = new Map<string, string>();

private async getFileId(path: string, config: Record<string, any>): Promise<string> {
  if (path === '/' || path === 'root') return 'root';
  const cached = this.pathIdCache.get(path);
  if (cached) return cached;

  // ... existing recursive resolution ...
  this.pathIdCache.set(path, result);
  return result;
}
```

During `list()`, after receiving items:
```typescript
for (const item of data.items || []) {
  const itemPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`;
  this.pathIdCache.set(itemPath, item.file_id);
}
```

**Fix B16 — Pagination in `list()`**:
```typescript
async list(path: string, config: Record<string, any>): Promise<ListResult> {
  const fileId = /* ... */;
  const content: FileObject[] = [];
  let marker: string | undefined;

  do {
    const body: any = {
      drive_id: await this.getDriveId(config),
      parent_file_id: fileId,
      order_by: config.order_by || 'updated_at',
      order_direction: config.order_direction || 'ASC',
      limit: 200,
    };
    if (marker) body.marker = marker;

    const data = await this.request('/adrive/v1.0/openFile/list', config, {
      method: 'POST', body: JSON.stringify(body),
    });

    for (const item of (data.items || [])) {
      const itemPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`;
      this.pathIdCache.set(itemPath, item.file_id);
      content.push({ /* ... */ });
    }

    marker = data.next_marker;
  } while (marker);

  return { content, total: content.length };
}
```

### 7.4 PikPak and Dropbox

Both have similar pagination patterns. Apply the same `do/while` loop with the respective API's continuation token:
- **PikPak**: `next_page_token` field in response
- **Dropbox**: `cursor` + `list_folder/continue` endpoint

### 7.5 Driver Interface Extension

Add optional `listPage` or pagination fields to the `Driver` interface in `src/drivers/types.ts`:

```typescript
export interface ListResult {
  content: FileObject[];
  total: number;
  nextMarker?: string;  // NEW: pagination cursor
}
```

Drivers that don't support pagination simply return `nextMarker: undefined`.

---

## 8. Link Caching

### 8.1 Flow

When `handleGetFile` needs a download URL:

1. Check `getCachedLink(path, storageId, env)`.
2. If hit and not expired → use cached URL.
3. If miss or expired → call `driver.link()`.
4. Store result via `cacheLink(path, storageId, url, header, linkTtl, env)`.
5. Return to client.

### 8.2 Link TTL Strategy

Different drivers have different link lifetimes:
- **S3**: controlled by `sign_url_expire` config (default 3600s). Use that as link TTL.
- **OneDrive**: `@microsoft.graph.downloadUrl` expires in ~1 hour.
- **Aliyundrive**: download URLs expire in ~15 minutes.
- **PikPak**: `web_content_link` has no documented expiry, use 30 min.
- **Dropbox**: temporary links expire in 4 hours.

Add a `linkTtlMinutes` constant per driver (in driver config or as a method on the Driver interface).

### 8.3 Integration with `handleGetFile`

```typescript
// In handleGetFile, replace the current link logic:
let linkUrl = '';
let linkHeaders: Record<string, string> = {};

const cachedLink = await getCachedLink(path, storage.id, env);
if (cachedLink) {
  linkUrl = cachedLink.url;
  linkHeaders = cachedLink.header;
} else {
  try {
    const link = await driver.link(relativePath, JSON.parse(storage.addition));
    linkUrl = link.url;
    linkHeaders = link.header || {};
    await cacheLink(path, storage.id, linkUrl, linkHeaders, linkTtlMinutes, env);
  } catch (e) {
    // Ignore link errors
  }
}
```

---

## 9. Pagination Support

### 9.1 API Contract

The frontend already sends `page` and `per_page` in the POST body. The response should include:

```json
{
  "code": 200,
  "data": {
    "content": [...],
    "total": 1500,
    "page": 2,
    "per_page": 100
  }
}
```

### 9.2 Server-Side Implementation

Pagination is applied AFTER fetching the full listing (either from cache or driver). This is the correct approach because:
- Cloud storage APIs have their own pagination that doesn't align with client page/size
- We need the total count for the frontend
- Cache stores the complete directory listing

```typescript
// In handleListFiles, after getting allFiles:
const total = allFiles.length;
const start = (page - 1) * perPage;
const end = Math.min(start + perPage, total);
const pagedContent = allFiles.slice(start, end);
```

### 9.3 Future Optimization

For very large directories (10k+ files), consider cursor-based pagination at both the cache and API level. This is out of scope for the initial implementation — the slice approach works for directories up to several thousand files.

---

## 10. Order of Implementation

### Phase 1: Foundation (no behavior changes yet)

| Step | What | Files | Verification |
|---|---|---|---|
| 1.1 | Create `src/cache.ts` with all cache functions using `parent_path` | `src/cache.ts` (new) | Unit-testable: mock D1, verify SQL |
| 1.2 | Create `src/singleflight.ts` | `src/singleflight.ts` (new) | Unit-testable: mock D1, verify lock acquire/release |
| 1.3 | Add migration code to `src/models/init.ts` for `parent_path`, `file_links`, `request_locks` | `src/models/init.ts` | Deploy, verify tables exist via `wrangler d1 execute` |
| 1.4 | Update `src/models/schema.sql` with new tables | `src/models/schema.sql` | N/A (documentation) |

### Phase 2: Wire up cache module (fix bugs B1-B6, B10, B11, B13)

| Step | What | Files | Verification |
|---|---|---|---|
| 2.1 | Replace embedded cache functions in `fs.ts` with imports from `src/cache.ts` | `src/routes/fs.ts` | List files → verify `file_cache.expires_at` is checked |
| 2.2 | Fix `handleListFiles` to use `getCachedChildren` with expiry check | `src/routes/fs.ts` | Wait >TTL → verify fresh fetch from driver |
| 2.3 | Fix `handleGetFile` to check link cache + file expiry | `src/routes/fs.ts` | Verify link is cached, second request uses cached link |
| 2.4 | Fix `handleListDirs` to cache results | `src/routes/fs.ts` | Second request for same dirs → no driver call |
| 2.5 | Fix `write: true` → `write: userRole >= 1` | `src/routes/fs.ts` | Login as guest → verify `write: false` |
| 2.6 | Apply `parent_path`-based invalidation in all write handlers | `src/routes/fs.ts` | Create file at `/a/b` → verify `/a` cache invalidated but `/a2` untouched |

### Phase 3: Singleflight (fixes concurrent request thundering herd)

| Step | What | Files | Verification |
|---|---|---|---|
| 3.1 | Wrap driver calls in `withSingleflight()` in `handleListFiles` | `src/routes/fs.ts` | Fire 5 concurrent requests → verify only 1 driver call (check logs) |
| 3.2 | Wrap `handleGetFile` driver call similarly | `src/routes/fs.ts` | Same test |

### Phase 4: Refresh improvements (fixes B7, B8, B9)

| Step | What | Files | Verification |
|---|---|---|---|
| 4.1 | Rewrite `refreshStorage()` with batch inserts | `src/routes/refresh.ts` | Refresh a storage → verify D1 call count is ~5 not ~500 |
| 4.2 | Use per-storage TTL instead of hardcoded 24h | `src/routes/refresh.ts` | Set storage TTL to 5min → verify expires_at reflects it |
| 4.3 | Swap delete/insert order (insert first, delete stale after) | `src/routes/refresh.ts` | During refresh, verify cached data still available |

### Phase 5: Link caching (fixes B19)

| Step | What | Files | Verification |
|---|---|---|---|
| 5.1 | Add `getCachedLink` / `cacheLink` to `src/cache.ts` | `src/cache.ts` | Already done in Phase 1 |
| 5.2 | Wire into `handleGetFile` | `src/routes/fs.ts` | GET file twice → second request uses cached link |
| 5.3 | Invalidate link cache on file write ops | `src/routes/fs.ts` | Upload new version → verify link refreshed |

### Phase 6: Driver fixes (fixes B14-B18)

| Step | What | Files | Verification |
|---|---|---|---|
| 6.1 | Fix S3 `get()` for directories | `src/drivers/s3.ts` | GET a directory → returns `is_dir: true` |
| 6.2 | Fix S3 `list()` pagination | `src/drivers/s3.ts` | List dir with >1000 files → all returned |
| 6.3 | Fix OneDrive `list()` pagination | `src/drivers/onedrive.ts` | List dir with >200 files → all returned |
| 6.4 | Fix Aliyundrive `list()` pagination + path caching | `src/drivers/aliyundrive_open.ts` | List large dir; deep path access is faster |
| 6.5 | Fix PikPak pagination | `src/drivers/pikpak.ts` | List large dir |
| 6.6 | Fix Dropbox pagination | `src/drivers/dropbox.ts` | List large dir |

### Phase 7: Pagination API support (fixes B12)

| Step | What | Files | Verification |
|---|---|---|---|
| 7.1 | Apply page/per_page slicing in `handleListFiles` | `src/routes/fs.ts` | Request page=2&per_page=10 → returns items 11-20 |
| 7.2 | Include page/per_page in response body | `src/routes/fs.ts` | Verify response JSON has page, per_page fields |

---

## 11. Verification Checklist

### Functional Tests

- [ ] **Cache hit**: List `/photos` twice → second request returns instantly without driver call
- [ ] **Cache expiry**: Wait for TTL → next list fetches from driver
- [ ] **Per-storage TTL**: Storage A (TTL=5min) expires before Storage B (TTL=60min)
- [ ] **Path isolation**: Files at `/photos` don't appear in `/photos-backup` listing
- [ ] **Invalidation precision**: Creating `/a/b/file.txt` invalidates `/a/b` cache but not `/a/c`
- [ ] **Subtree invalidation**: Removing `/a/b` (directory) cleans all child cache entries
- [ ] **Link caching**: Second GET for same file uses cached presigned URL
- [ ] **Link expiry**: After link TTL, new presigned URL is generated
- [ ] **Singleflight**: 5 concurrent requests for same path → only 1 driver API call
- [ ] **Write permission**: Guest users see `write: false`
- [ ] **Pagination**: `page=2&per_page=5` returns items 6-10
- [ ] **Refresh no-gap**: During refresh, stale cache is served until new data is ready
- [ ] **S3 directory GET**: `GET` on a directory prefix returns `is_dir: true`
- [ ] **Large directory**: List a directory with 2000+ files → all returned
- [ ] **Deep path speed (Aliyundrive)**: Access `/a/b/c/d` → second access skips API calls

### Performance Tests

- [ ] **Batch inserts**: Refresh 1000 files → completes in <2s (vs ~10s with N+1)
- [ ] **Cache read latency**: Cached list returns in <50ms
- [ ] **Lock cleanup**: `request_locks` table doesn't grow unbounded

### Regression Tests

- [ ] **Root listing**: `/` still returns virtual folder of storages
- [ ] **Disabled storages**: Don't appear in root listing
- [ ] **Auth**: Write operations still require valid token
- [ ] **Frontend**: Existing SPA works without changes (same API contract)

---

## Appendix: File Change Summary

| File | Action | Description |
|---|---|---|
| `src/cache.ts` | **CREATE** | All cache CRUD operations, TTL helpers |
| `src/singleflight.ts` | **CREATE** | D1-based request deduplication |
| `src/models/init.ts` | MODIFY | Add `runMigrations()` for new tables + `parent_path` column |
| `src/models/schema.sql` | MODIFY | Document new tables/columns |
| `src/routes/fs.ts` | MODIFY | Replace cache functions with imports, add singleflight, fix write flag, add pagination |
| `src/routes/refresh.ts` | MODIFY | Batch inserts, per-storage TTL, swap delete order |
| `src/drivers/types.ts` | MODIFY | Add `nextMarker` to `ListResult` |
| `src/drivers/s3.ts` | MODIFY | Directory GET fix, pagination |
| `src/drivers/onedrive.ts` | MODIFY | `@odata.nextLink` pagination |
| `src/drivers/aliyundrive_open.ts` | MODIFY | Path-to-ID cache, `next_marker` pagination |
| `src/drivers/pikpak.ts` | MODIFY | Pagination |
| `src/drivers/dropbox.ts` | MODIFY | `list_folder/continue` pagination |
