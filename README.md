# OpenList.ts

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](./README.md) · [中文](./docs/README.zh-CN.md) · [日本語](./docs/README.ja-JP.md) · [Français](./docs/README.fr-FR.md) · [한국어](./docs/README.ko-KR.md)

A file-list program for [Cloudflare Workers](https://workers.cloudflare.com/) — an OpenList/AList-style web UI that browses and manages files on S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …), Microsoft OneDrive, Alibaba Cloud Drive, PikPak and Dropbox.

Everything is TypeScript, runs on the Workers runtime, and stores its file tree and download links in [Cloudflare D1](https://developers.cloudflare.com/d1/).

> **OpenList.ts** is a from-scratch TypeScript rewrite inspired by the OpenList/AList project. It is **not** affiliated with the original projects.

---

## ✨ Features

- ☁️ Runs entirely on Cloudflare Workers + D1 (no VPS required)
- 📁 Multi-storage support: **S3-compatible** (B2 / R2 / AWS / MinIO), **OneDrive**, **OneDrive APP**, **Alibaba Cloud Drive (AliyunPan)**, **PikPak**, **Dropbox**
- 🗄️ **D1 file-tree cache**: browsing reads the cached tree from D1 — the storage provider is only contacted when an admin visits a cold path, and download URLs are generated lazily on download
- 🔐 User authentication & authorization (guest / user / admin roles)
- 🛡️ **TOTP two-factor authentication (2FA)** — Google Authenticator compatible
- 🔑 Password change & profile update
- 👤 Optional anonymous (guest) browsing, disabled by default
- 🖥️ Admin panel: storage, settings, users and drivers management
- 📥 Direct download (`/d/`) and proxied download (`/p/`) with Range/HEAD support
- 🔄 Presigned-link caching with singleflight deduplication

---

## 🚀 Quick Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

Click the button above to deploy directly to your Cloudflare account (Workers + D1 are created automatically). After deployment, open your Worker URL and log in with the default credentials, then add a storage in the admin panel.

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
npm run dev           # http://127.0.0.1:8787

# 6. Deploy to Cloudflare
npm run deploy
```

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
| `npm run db:reset` | Drop all tables and re-initialize the schema |

---

## 🔐 Authentication

### Default credentials

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | Administrator |

> ⚠️ **Change the default password immediately after the first login** (Profile → Change Password).

### Roles

- **Guest** (`role 0`) — anonymous visitors. Only visible when the `anonymous` setting is enabled.
- **User** (`role 1`) — can browse and manage files.
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
| POST | `/api/fs/remove` | Delete (`dir`, `names[]`) |
| POST | `/api/fs/move` | Move (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/copy` | Copy (`src_dir`, `dst_dir`, `names[]`) |
| PUT | `/api/fs/put` | Upload (`?path=` + body) |
| PUT | `/api/fs/form` | Multipart upload |
| POST | `/api/fs/search` | Search (stub) |

### Download / proxy

| Method | Path | Description |
|---|---|---|
| GET | `/d/<path>` | 302 redirect to the signed download URL |
| GET/HEAD | `/p/<path>` | Stream the file through the worker (Range supported) |

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

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/api/public/settings` | Public settings (includes `anonymous`) |
| GET | `/api/public/archive_extensions` | Archive file extensions |
| GET | `/api/public/offline_download_tools` | Offline download tools (stub) |

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
| `anonymous` | `false` | Allow anonymous browsing. When `false`, visitors must log in. |

---

## 🗂️ Project Structure

```
src/
├── drivers/                  # Storage drivers
│   ├── types.ts              # Core driver interfaces
│   ├── registry.ts           # Driver registration & lookup
│   ├── base.ts               # Shared helpers
│   ├── s3/                   # S3-compatible driver
│   ├── onedrive/             # OneDrive driver
│   ├── onedrive_app/         # OneDrive APP (Azure AD app) driver
│   ├── aliyundrive_open/     # Alibaba Cloud Drive driver
│   ├── pikpak/               # PikPak driver
│   └── dropbox/              # Dropbox driver
├── models/
│   ├── init.ts               # Schema bootstrap & default data
│   └── schema.sql            # D1 schema
├── routes/
│   ├── api.ts                # API router
│   ├── auth.ts               # Auth + 2FA + profile
│   ├── fs.ts                 # File-system routes + D1 cache
│   ├── download.ts           # /d/ and /p/ download routes
│   ├── storage.ts            # Storage admin routes
│   ├── settings.ts           # Settings admin routes
│   ├── users.ts              # User admin routes
│   ├── drivers.ts            # Driver admin routes
│   ├── refresh.ts            # Cache refresh routes
│   └── static.ts             # Static assets
├── utils/
│   ├── otp.ts                # TOTP implementation
│   ├── crypto.ts             # Password hashing helpers
│   ├── guest.ts              # Guest user model
│   └── response.ts           # JSON response helper
├── cache.ts                  # D1 cache primitives (files, links, locks)
├── router.ts                 # Main request router
├── types.ts                  # TypeScript types
└── worker.ts                 # Worker entry point
```

### Adding a new storage driver

1. Create `src/drivers/<name>/index.ts` implementing the `Driver` interface (`list`, `get`, `link`, `mkdir`, `rename`, `copy`, `move`, `remove`, `put`).
2. Export `config` and `additional` and call `registerDriver(...)`.
3. Import the module in `src/drivers/registry.ts`.

See `src/drivers/template.ts` for a ready-to-copy skeleton.

---

## 📄 License

[AGPL-3.0](./LICENSE)
