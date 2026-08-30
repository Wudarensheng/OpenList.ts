# OpenList.ts

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](./README.md) · [简体中文](./docs/README.zh-CN.md) · [繁體中文](./docs/README.zh-TW.md) · [日本語](./docs/README.ja-JP.md) · [Français](./docs/README.fr-FR.md) · [조선어](./docs/README.ko-KP.md)

A file-list program for [Cloudflare Workers](https://workers.cloudflare.com/) — an OpenList/AList-style web UI that browses and manages files on S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …), Microsoft OneDrive, OneDrive APP, Alibaba Cloud Drive, PikPak, Dropbox and 189Cloud (天翼云盘).

Everything is TypeScript and runs on the Workers runtime by default, storing its file tree and download links in [Cloudflare D1](https://developers.cloudflare.com/d1/). The database layer is cross-cloud — with `USE_D1=false` it uses PostgreSQL instead (a [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) binding on Cloudflare, or a plain `PG_ADDRS` connection string) — and the same request handler can also run outside Cloudflare on Bun, Deno or Node (see [Running outside Cloudflare](#-running-outside-cloudflare)).

> **OpenList.ts** is an ecosystem project and a derivative of OpenList, part of the OpenList ecosystem.

---

## ✨ Features

- ☁️ Runs entirely on Cloudflare Workers + D1 by default (no VPS required)
- 🌍 **Cross-cloud & cross-platform**: database layer supports D1 or PostgreSQL (Hyperdrive / `PG_ADDRS`); the same request handler runs on Bun / Deno / Node outside Cloudflare
- 📁 Multi-storage support: **S3-compatible** (B2 / R2 / AWS / MinIO), **OneDrive**, **OneDrive APP**, **Alibaba Cloud Drive (AliyunPan)**, **PikPak**, **Dropbox**, **189Cloud (天翼云盘)**
- 🗄️ **File-tree cache**: browsing reads the cached tree from the database — the storage provider is only contacted when an admin visits a cold path, and download URLs are generated lazily on download
- 🔐 User authentication & authorization (guest / user / admin roles)
- 🛡️ **TOTP two-factor authentication (2FA)** — Google Authenticator compatible
- 🔑 Password change & profile update
- 👤 Optional anonymous (guest) browsing via the `guest` user account, disabled by default
- 🖥️ Admin panel: storage, settings, users, drivers and per-path metadata management
- 🔗 **File sharing** — password-protected shares with expiry and access limits
- 📤 **Offline download** — hand URLs/magnets to aria2 / qBittorrent / Transmission
- 🗜️ **Archive preview & extraction** — list and extract zip / tar / gz archives without downloading the whole file
- 📥 Direct download (`/d/`), proxied download (`/p/`) and archive downloads (`/ad/`, `/ap/`, `/ae/`) with Range/HEAD support
- 💻 **WebDAV** (`/dav/`) — mount your cloud drives as a local folder (Windows Explorer, macOS Finder, rclone, …)
- 🔄 Presigned-link caching with singleflight deduplication

---

## 🚀 Quick Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

Click the button above to deploy directly to your Cloudflare account. The one-click
flow reads `wrangler.toml`, creates a fresh D1 database in *your* account (the
`database_id` is intentionally left empty in the repo), and deploys the worker.
After deployment, open your Worker URL and log in with the default credentials,
then add a storage in the admin panel.

> The worker auto-creates the D1 schema on first run (`src/models/init.ts`), so no
> manual schema step is needed after deployment.

### Manual deployment

Prerequisites: [Node.js](https://nodejs.org/) 18+ and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
# 1. Install dependencies (pnpm is recommended)
pnpm install          # or: npm install

# 2. Login to Cloudflare
npx wrangler login

# 3. Create the D1 database and capture its database_id
npx wrangler d1 create openlist-db
#   → copy the printed database_id into wrangler.toml under [[d1_databases]]

# 4. Apply the schema
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. (Optional) preview locally
npm run dev           # http://127.0.0.1:8787  (uses wrangler.local.toml)

# 6. Deploy to Cloudflare
npm run deploy
```

> `wrangler.toml` keeps `database_id` empty so the one-click deploy flow can create
> a fresh database per deployer. For manual deployment, fill it in with the ID from
> step 3. Local development uses `wrangler.local.toml` (which carries a local ID) via
> `npm run dev`, so you never need to touch the main config.

---

## 🖥️ Local Development

```bash
pnpm install
npm run dev          # starts wrangler dev on http://127.0.0.1:8787
```

The D1 database is simulated locally under `.wrangler/state`. Schema changes and cache data persist across restarts.

Other useful scripts:

| Command | Description |
|---|---|
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | ESLint over `src` |
| `npm test` | Vitest test runner |
| `npm run deploy` | Deploy the worker to Cloudflare |
| `npm run build:node` | Build the Node.js version to `dist-node/` (`node build.js`) |
| `npm run db:reset` | Drop all tables and re-initialize the schema |

---

## 🌍 Running outside Cloudflare

The exact same request handler can run on any host with Web-standard `Request`/`Response` semantics. Since there is no D1 binding off Cloudflare, PostgreSQL is used instead:

- **Bun**: `bun run src/server.ts`
- **Deno**: `deno run --allow-net --allow-read --allow-env src/server.ts`
- **Node**: `node build.js` (or `npm run build:node`) compiles the project and the embedded Node entry to `dist-node/`, then `node dist-node/server-node.js`
- **Cloud functions**: run `node build.js` as the vendor build step and point the function entry to `dist-node/server-node.js`

Requirements (no D1 binding exists off Cloudflare):

```bash
USE_D1=false                              # PostgreSQL mode
PG_ADDRS=postgres://user:pass@host:5432/dbname
# optional: STATIC_BASE=https://...       # serve static assets from an external server
# optional: PUBLIC_DIR=/path/to/public    # node build: local static files (default dist-node/public)
# optional: PORT=3000                     # node build: listen port
# optional: HOST=0.0.0.0                  # node build: bind address
```

---

## 🔐 Authentication

### Default credentials

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | Administrator |

> ⚠️ **Change the default password immediately after the first login** (Profile → Change Password).

### Roles

- **Guest** (`role 1`) — anonymous visitors. The `guest` user account is created
  **disabled** by default; enable it in the user list to allow anonymous browsing.
- **User** (`role 0`) — can browse and manage files.
- **Admin** (`role 2`) — full access, including the admin panel.

> Browsing never contacts the storage provider. Only an **admin** visiting a cold path triggers a provider fetch to populate the D1 file tree; guests and normal users always read from the cache.

### Two-factor authentication (2FA)

1. Log in as a user, go to **Profile** → **Two-Factor Authentication**.
2. Click **Enable** to generate a secret, scan the QR code with Google Authenticator (or any TOTP app).
3. Enter the 6-digit code to confirm.
4. From now on, logins require the 6-digit code.

The login page shows the OTP field automatically when your account has 2FA enabled.

---

## 🗄️ File Tree Cache

The file tree is cached in D1 so browsing is fast and provider-friendly:

1. **Browsing** (`/api/fs/list`, `/api/fs/get`, `/api/fs/dirs`) reads the tree **from D1 only**. The storage provider is never contacted while browsing.
2. When an **admin** opens a path that is not cached (or the cache expired), the worker lists the remote directory once and stores it in D1 (`files`, `file_cache` tables).
3. **Downloads** (`/d/` and `/p/`) generate a signed download URL on demand and cache it in D1 (`file_links`), so repeat downloads don't re-sign.
4. Empty directories are cached too (marked by a `file_cache` row), so they don't cause repeated provider hits.

Configure the cache lifetime per storage via the `cache_expiration` field (minutes, default 30).

---

## 📦 Supported Storages

### S3-compatible (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …)

In the admin panel, add a storage with driver **S3** and `addition` JSON:

```json
{
  "bucket": "your-bucket-name",
  "endpoint": "https://s3.ca-central-1.amazonaws.com",
  "region": "ca-central-1",
  "access_key_id": "your-access-key",
  "access_key_secret": "your-secret-key",
  "root_path": "",
  "custom_host": "",
  "sign_url_expire": 3600,
  "enable_custom_host_presign": false,
  "remove_bucket": false,
  "add_filename_to_disposition": false,
  "list_object_version": "v2",
  "placeholder": "placeholder"
}
```

> For Backblaze B2, use `region: "auto"` — the driver auto-detects the region from the endpoint host.

### Microsoft OneDrive / OneDrive APP

Two drivers are available:

- **OneDrive** — personal OneDrive via a refresh token.
- **OneDrive APP** — Azure AD app registration flow with support for Global / CN (世纪互联) / DE / US regions.

`addition` example (OneDrive APP):

```json
{
  "client_id": "your-application-client-id",
  "client_secret": "your-client-secret",
  "tenant_id": "common",
  "refresh_token": "your-refresh-token",
  "email": "you@example.com",
  "region": "global",
  "root_folder_path": "/",
  "redirect_uri": "http://localhost",
  "chunk_size": 10,
  "custom_host": ""
}
```

### 189Cloud (天翼云盘)

`addition` example:

```json
{
  "username": "your-phone-number",
  "password": "your-password",
  "cookie": ""
}
```

> If login fails due to a CAPTCHA, fill in the `cookie` field with a logged-in session cookie.

---

## 📡 API Reference

### Authentication

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Login (plaintext password) |
| POST | `/api/auth/login/hash` | Login (sha256 hash, used by the frontend; supports `otp_code`) |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/auth/logout` | Logout |
| POST | `/api/auth/2fa/generate` | Generate a TOTP secret (returns `secret` + `qr`) |
| POST | `/api/auth/2fa/verify` | Verify a code and enable 2FA |
| POST | `/api/auth/2fa/disable` | Disable 2FA (requires a valid code) |
| GET | `/api/auth/sso` | SSO login redirect (Github / Microsoft / Google / OIDC) |
| GET | `/api/auth/sso_callback` | SSO callback |
| GET | `/api/auth/get_sso_id` | Get the SSO identity of the current user |
| GET | `/api/auth/sso_get_token` | Exchange an SSO code for a session token |

### Profile

| Method | Path | Description |
|---|---|---|
| GET | `/api/me` | Get current user profile |
| POST | `/api/me/update` | Update username / password (`old_password` required when changing password) |
| GET | `/api/me/sshkey/list` | SSH keys (stub) |

### File system

| Method | Path | Description |
|---|---|---|
| POST | `/api/fs/list` | List files in a directory (`path`, `page`, `per_page`, `refresh`) |
| POST | `/api/fs/get` | Get file/dir info (`path`) |
| POST | `/api/fs/dirs` | List directories (`path`) |
| POST | `/api/fs/mkdir` | Create a directory (`path`, `name`) |
| POST | `/api/fs/rename` | Rename (`path`, `name`) |
| POST | `/api/fs/batch_rename` | Batch rename |
| POST | `/api/fs/regex_rename` | Regex-based rename |
| POST | `/api/fs/remove` | Delete (`dir`, `names[]`) |
| POST | `/api/fs/remove_empty_directory` | Remove empty directories |
| POST | `/api/fs/move` | Move (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/recursive_move` | Recursive move |
| POST | `/api/fs/copy` | Copy (`src_dir`, `dst_dir`, `names[]`) |
| PUT | `/api/fs/put` | Upload (`?path=` + body) |
| PUT | `/api/fs/form` | Multipart upload |
| POST | `/api/fs/add_offline_download` | Add an offline download task (aria2 / qBittorrent / Transmission) |
| POST | `/api/fs/archive/meta` | Get archive metadata (`path`) |
| POST | `/api/fs/archive/list` | List files inside an archive (`path`, `inner`) |
| POST | `/api/fs/archive/decompress` | Decompress an archive (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/search` | Search (stub) |
| POST | `/api/fs/other` | Other driver operations (stub) |
| POST | `/api/fs/link` | Generate a download link (`path`) |
| POST | `/api/fs/get_direct_upload_info` | Get direct-upload info |

### Download / proxy

| Method | Path | Description |
|---|---|---|
| GET | `/d/<path>` | 302 redirect to the signed download URL |
| GET/HEAD | `/p/<path>` | Stream the file through the worker (Range supported) |
| GET | `/ad/<path>?inner=` | Stream a single file out of an archive |
| GET | `/ap/<path>?inner=` | Proxy a single file out of an archive (Range supported) |
| GET | `/ae/<path>?inner=` | Extract a single archive entry (download) |
| GET | `/sd/<sid>/<path>` | Download a file from a share (`pwd` for password-protected shares) |

### Sharing

| Method | Path | Description |
|---|---|---|
| GET | `/api/share/list` | List shares |
| GET | `/api/share/get?id=` | Get a share |
| POST | `/api/share/create` | Create a share (`files[]`, `expires`, `pwd`, `max_accessed`, …) |
| POST | `/api/share/update` | Update a share |
| POST | `/api/share/delete?id=` | Delete a share |
| POST | `/api/share/enable?id=` | Enable a share |
| POST | `/api/share/disable?id=` | Disable a share |

### WebDAV

Mount your cloud drives as a local folder via the standard WebDAV protocol at
`/dav/`. Supported methods: `PROPFIND`, `GET`, `HEAD`, `PUT`, `MKCOL`,
`DELETE`, `MOVE`, `COPY`, `LOCK`, `UNLOCK`, `OPTIONS`.

**Windows (Explorer):**
1. Right-click *This PC* → **Map network drive**.
2. Enter `http://<your-worker>/dav/` as the folder.
3. Check *Connect using different credentials* and use your OpenList
   username/password.

**rclone:**
```bash
rclone config
# type = webdav
# url  = https://<your-worker>/dav
# vendor = other
# user = <openlist-username>
# pass = <openlist-password>
```

Each storage appears as a top-level folder under `/dav/` (e.g. `/dav/backblaze/...`).

### Admin — storages

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/storage/list` | List storages |
| GET | `/api/admin/storage/get?id=` | Get a storage |
| POST | `/api/admin/storage/create` | Create a storage |
| POST | `/api/admin/storage/update` | Update a storage |
| POST | `/api/admin/storage/delete?id=` | Delete a storage |
| POST | `/api/admin/storage/enable?id=` | Enable |
| POST | `/api/admin/storage/disable?id=` | Disable |
| POST | `/api/admin/storage/refresh` | Refresh all file-tree caches |
| POST | `/api/admin/storage/refresh_one?id=` | Refresh one storage cache |

### Admin — settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/setting/list` | List settings (optional `?group=`) |
| GET | `/api/admin/setting/get?key=` | Get a setting |
| POST | `/api/admin/setting/save` | Save one or more settings |
| POST | `/api/admin/setting/delete?key=` | Delete a setting |

### Admin — users

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/user/list` | List users |
| GET | `/api/admin/user/get?id=` | Get a user |
| POST | `/api/admin/user/create` | Create a user |
| POST | `/api/admin/user/update` | Update a user |
| POST | `/api/admin/user/delete?id=` | Delete a user |

### Admin — drivers

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/driver/names` | List registered driver names |
| GET | `/api/admin/driver/list` | Full driver info map |
| GET | `/api/admin/driver/info?driver=` | Info for one driver |

### Admin — meta (per-path metadata)

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/meta/list` | List metadata entries |
| GET | `/api/admin/meta/get?path=` | Get metadata for a path |
| POST | `/api/admin/meta/create` | Create metadata (readme / header / password / hide / read & write users) |
| POST | `/api/admin/meta/update` | Update metadata |
| POST | `/api/admin/meta/delete?path=` | Delete metadata |

### Tasks (offline download, transfer, …)

| Method | Path | Description |
|---|---|---|
| GET | `/api/task/<type>/undone` | List unfinished tasks |
| GET | `/api/task/<type>/done` | List finished tasks |
| GET | `/api/task/<type>/info?tid=` | Get task info |
| POST | `/api/task/<type>/cancel?tid=` | Cancel a task |
| POST | `/api/task/<type>/delete?tid=` | Delete a task |
| POST | `/api/task/<type>/retry?tid=` | Retry a task |
| POST | `/api/task/<type>/clear_done` | Clear done tasks |

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/api/public/settings` | Public settings (site title, logo, favicon, …) |
| GET | `/api/public/archive_extensions` | Archive file extensions |
| GET | `/api/public/offline_download_tools` | Configured offline download tools (aria2 / qBittorrent / Transmission) |

---

## ⚙️ Settings

| Key | Default | Description |
|---|---|---|
| `site_title` | `OpenList` | Site title |
| `site_description` | `A file list program` | Site description |
| `logo` | `/images/logo.svg` | Logo |
| `favicon` | `/images/logo.png` | Favicon |
| `max_connections` | `0` | Max connections (0 = unlimited) |
| `cache_expiration` | `30` | Default cache lifetime (minutes) |
| `aria2_uri` / `aria2_secret` | | aria2 RPC endpoint / secret (offline download) |
| `qbittorrent_url` / `qbittorrent_seedtime` | | qBittorrent Web API / seed time (offline download) |
| `transmission_uri` / `transmission_seedtime` | | Transmission RPC / seed time (offline download) |

> Anonymous browsing is controlled by the **`guest` user account** in the user
> list — it is created disabled by default. Enable it to allow visitors to
> browse without logging in.

---

## 🗂️ Project Structure

```
src/
├── db/                       # Cross-cloud database layer (D1 / PostgreSQL / Hyperdrive)
│   ├── types.ts              # Shared Database interface (no CF-specific types)
│   ├── d1.ts                 # D1 adapter (Cloudflare)
│   ├── postgres.ts           # PostgreSQL adapter (postgres.js, cross-cloud)
│   ├── sqlite.ts             # SQLite → PostgreSQL SQL translator
│   └── index.ts              # createDatabase(env): USE_D1 / PG_ADDRS switch
├── drivers/                  # Storage drivers
│   ├── types.ts              # Core driver interfaces
│   ├── registry.ts           # Driver registration & lookup
│   ├── base.ts               # Shared helpers
│   ├── s3/                   # S3-compatible driver
│   ├── onedrive/             # OneDrive driver
│   ├── onedrive_app/         # OneDrive APP (Azure AD app) driver
│   ├── aliyundrive_open/     # Alibaba Cloud Drive driver
│   ├── pikpak/               # PikPak driver
│   ├── dropbox/              # Dropbox driver
│   ├── cloud189/             # 189Cloud (天翼云盘) driver
│   ├── google_drive/         # Google Drive driver
│   ├── webdav/               # WebDAV driver
│   └── template.ts           # Ready-to-copy driver skeleton
├── models/
│   ├── init.ts               # Schema bootstrap & default data
│   └── schema.sql            # D1 schema
├── routes/
│   ├── api.ts                # API router
│   ├── auth.ts               # Auth + 2FA + profile
│   ├── sso.ts                # SSO login (Github / Microsoft / Google / OIDC)
│   ├── fs.ts                 # File-system routes + DB cache
│   ├── download.ts           # /d/, /p/ and archive download routes
│   ├── share.ts              # File sharing routes
│   ├── storage.ts            # Storage admin routes
│   ├── settings.ts           # Settings admin routes
│   ├── users.ts              # User admin routes
│   ├── drivers.ts            # Driver admin routes
│   ├── meta.ts               # Per-path metadata admin routes
│   ├── tasks.ts              # Task routes (offline download, transfer, …)
│   ├── refresh.ts            # Cache refresh routes
│   ├── webdav.ts             # WebDAV routes
│   └── static.ts             # Static assets
├── utils/
│   ├── otp.ts                # TOTP implementation
│   ├── crypto.ts             # Password hashing helpers
│   ├── auth.ts               # Token / password / permission helpers
│   ├── sign.ts               # Download-link signing
│   ├── guest.ts              # Guest user model
│   ├── response.ts           # JSON response helper
│   ├── meta.ts               # Per-path metadata helpers
│   ├── archive.ts            # Archive preview / extraction (zip / tar / gz)
│   └── offline.ts            # Offline download (aria2 / qBittorrent / Transmission)
├── cache.ts                  # DB cache primitives (files, links, locks)
├── router.ts                 # Main request router
├── types.ts                  # TypeScript types
├── static-local.ts           # Local static provider (Bun / Deno, node-free)
├── server.ts                 # Cross-platform entry (Bun / Deno)
└── worker.ts                 # Worker entry point (Cloudflare)
```

### Adding a new storage driver

1. Create `src/drivers/<name>/index.ts` implementing the `Driver` interface (`list`, `get`, `link`, `mkdir`, `rename`, `copy`, `move`, `remove`, `put`).
2. Export `config` and `additional` and call `registerDriver(...)`.
3. Import the module in `src/drivers/registry.ts`.

See `src/drivers/template.ts` for a ready-to-copy skeleton.

---

## 📄 License

[AGPL-3.0](./LICENSE)
