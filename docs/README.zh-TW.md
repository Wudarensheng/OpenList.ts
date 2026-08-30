# OpenList.ts

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [簡體中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

一個基於 [Cloudflare Workers](https://workers.cloudflare.com/) 的文件列表程序 —— 採用 OpenList/AList 風格網頁界面，可瀏覽和管理 S3 兼容存儲（Backblaze B2、Cloudflare R2、AWS S3、MinIO 等）、Microsoft OneDrive、OneDrive APP、阿里雲盤、PikPak、Dropbox 和天翼雲盤（189Cloud）上的文件。

全部使用 TypeScript 編寫，默認運行在 Workers 運行時上，文件樹和下載鏈接緩存存儲在 [Cloudflare D1](https://developers.cloudflare.com/d1/) 中。數據庫層是跨雲的 —— 設置 `USE_D1=false` 時改用 PostgreSQL（Cloudflare 上走 [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) 綁定，或直接使用 `PG_ADDRS` 連接串）；同一套請求處理邏輯也可以在 Cloudflare 之外的 Bun / Deno / Node 上運行（見[在 Cloudflare 之外運行](#-在-cloudflare-之外運行)）。

> **OpenList.ts** 是 OpenList 生態項目及衍生項目，屬於 OpenList 生態。

---

## ✨ 功能特性

- ☁️ 默認完全運行在 Cloudflare Workers + D1 上（無需 VPS）
- 🌍 **跨雲與跨平台**：數據庫層支持 D1 或 PostgreSQL（Hyperdrive / `PG_ADDRS`）；同一套請求處理邏輯可在 Cloudflare 之外的 Bun / Deno / Node 上運行
- 📁 多存儲支持：**S3 兼容**（B2 / R2 / AWS / MinIO）、**OneDrive**、**OneDrive APP**、**阿里雲盤**、**PikPak**、**Dropbox**、**天翼雲盤（189Cloud）**
- 🗄️ **文件樹緩存**：瀏覽時從數據庫讀取緩存的文件樹 —— 僅當管理員訪問冷路徑時才聯繫存儲提供商，下載鏈接在下載時才按需生成
- 🔐 用戶認證與授權（訪客 / 普通用戶 / 管理員）
- 🛡️ **TOTP 雙因素認證（2FA）** —— 兼容 Google Authenticator
- 🔑 修改密碼與個人資料
- 👤 通過 `guest` 用戶賬號提供可選的匿名（訪客）瀏覽，默認關閉
- 🖥️ 管理面板：存儲、設置、用戶、驅動和路徑元數據管理
- 🔗 **文件分享** —— 支持密碼保護、有效期與訪問次數限制
- 📤 **離線下載** —— 把 URL / magnet 交給 aria2 / qBittorrent / Transmission
- 🗜️ **壓縮包預覽與解壓** —— 無需下載整個文件即可查看 zip / tar / gz 內容
- 📥 直鏈下載（`/d/`）、代理下載（`/p/`）與壓縮包下載（`/ad/`、`/ap/`、`/ae/`），支持 Range/HEAD
- 💻 **WebDAV**（`/dav/`）—— 將雲端網盤掛載為本地資料夾（Windows 資源管理器、macOS Finder、rclone 等）
- 🔄 預簽名鏈接緩存與單飛去重

---

## 🚀 快速部署

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

點擊上方按鈕即可直接部署到你的 Cloudflare 賬戶（會自動創建 Workers 和 D1）。部署完成後打開 Worker 地址，使用默認憑據登錄，然後在管理面板中添加存儲。

### 手動部署

前置要求：[Node.js](https://nodejs.org/) 18+ 和 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)。

```bash
# 1. 安裝依賴（推薦使用 pnpm）
pnpm install          # 或：npm install

# 2. 登錄 Cloudflare
npx wrangler login

# 3. 創建 D1 數據庫並記錄 database_id
npx wrangler d1 create openlist-db
#   → 將輸出的 database_id 填寫到 wrangler.toml 的 [[d1_databases]] 中

# 4. 初始化數據庫
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. （可選）本地預覽
npm run dev           # http://127.0.0.1:8787

# 6. 部署到 Cloudflare
npm run deploy
```

---

## 🖥️ 本地開發

```bash
pnpm install
npm run dev          # 啟動 wrangler dev，監聽 http://127.0.0.1:8787
```

D1 數據庫在本地 `.wrangler/state` 下模擬，schema 和緩存數據重啟後仍會保留。

其他常用腳本：

| 命令 | 說明 |
|---|---|
| `npm run typecheck` | TypeScript 類型檢查（`tsc --noEmit`） |
| `npm run lint` | 對 `src` 運行 ESLint |
| `npm test` | Vitest 測試運行器 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run build:node` | 構建 Node 版本到 `dist-node/`（`node build.js`） |
| `npm run db:reset` | 刪除所有表並重新初始化 schema |

---

## 🌍 在 Cloudflare 之外運行

同一套請求處理邏輯可以在任何支持 Web 標準 `Request`/`Response` 語義的平台上運行。由於 Cloudflare 之外沒有 D1 綁定，改用 PostgreSQL：

- **Bun**：`bun run src/server.ts`
- **Deno**：`deno run --allow-net --allow-read --allow-env src/server.ts`
- **Node**：`node build.js`（或 `npm run build:node`）會把項目與內嵌的 Node 入口編譯到 `dist-node/`，然後 `node dist-node/server-node.js`
- **雲函數**：在廠商構建步驟中運行 `node build.js`，並將函數入口指向 `dist-node/server-node.js`

運行要求（Cloudflare 之外沒有 D1 綁定）：

```bash
USE_D1=false                              # PostgreSQL 模式
PG_ADDRS=postgres://user:pass@host:5432/dbname
# 可選：STATIC_BASE=https://...           # 由外部服務器提供靜態資源
# 可選：PUBLIC_DIR=/path/to/public        # node 構建：本地靜態文件（默認 dist-node/public）
# 可選：PORT=3000                         # node 構建：監聽端口
# 可選：HOST=0.0.0.0                      # node 構建：綁定地址
```

---

## 🔐 認證

### 默認憑據

| 用戶名 | 密碼 | 角色 |
|---|---|---|
| `admin` | `admin` | 管理員 |

> ⚠️ **首次登錄後請立即修改默認密碼**（個人資料 → 修改密碼）。

### 角色

- **訪客**（`role 1`）— 匿名訪問者。`guest` 用戶賬號默認**停用**，在用戶列表中啟用它即可允許匿名瀏覽。
- **普通用戶**（`role 0`）— 可瀏覽和管理文件。
- **管理員**（`role 2`）— 完整權限，包括管理面板。

> 瀏覽時不會聯繫存儲提供商。只有**管理員**訪問冷路徑時才會觸發提供商拉取以填充 D1 文件樹；訪客和普通用戶始終從緩存讀取。

### 雙因素認證（2FA）

1. 登錄後進入 **個人資料** → **雙因素認證**。
2. 點擊**啟用**生成密鑰，用 Google Authenticator（或任意 TOTP 應用）掃描二維碼。
3. 輸入 6 位驗證碼確認。
4. 此後登錄都需要輸入 6 位驗證碼。

當你的賬號啟用了 2FA 時，登錄頁面會自動顯示 OTP 輸入框。

---

## 🗄️ 文件樹緩存

文件樹緩存在 D1 中，瀏覽快速且對提供商友好：

1. **瀏覽**（`/api/fs/list`、`/api/fs/get`、`/api/fs/dirs`）**只從 D1 讀取**文件樹，絕不聯繫存儲提供商。
2. 當**管理員**打開未緩存（或緩存過期）的路徑時，Worker 一次性列出遠程目錄並存入 D1（`files`、`file_cache` 表）。
3. **下載**（`/d/` 和 `/p/`）按需生成簽名下載 URL 並緩存在 D1（`file_links` 表），重複下載不會重新簽名。
4. 空目錄也會被緩存（通過 `file_cache` 行標記），避免反覆訪問提供商。

每個存儲可通過 `cache_expiration` 字段配置緩存有效期（分鐘，默認 30）。

---

## 📦 支持的存儲

### S3 兼容（Backblaze B2、Cloudflare R2、AWS S3、MinIO 等）

在管理面板中添加驅動為 **S3** 的存儲，`addition` JSON 示例：

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

> Backblaze B2 使用 `region: "auto"`，驅動會自動從 endpoint 主機名識別區域。

### Microsoft OneDrive / OneDrive APP

提供兩個驅動：

- **OneDrive** — 通過 refresh token 訪問個人 OneDrive。
- **OneDrive APP** — Azure AD 應用註冊流程，支持 Global / CN（世紀互聯）/ DE / US 區域。

`addition` 示例（OneDrive APP）：

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

### 天翼雲盤（189Cloud）

`addition` 示例：

```json
{
  "username": "your-phone-number",
  "password": "your-password",
  "cookie": ""
}
```

> 如果因驗證碼無法登錄，可在 `cookie` 字段填入已登錄的會話 Cookie。

---

## 📡 API 參考

### 認證

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/login` | 登錄（明文密碼） |
| POST | `/api/auth/login/hash` | 登錄（sha256 哈希，前端使用；支持 `otp_code`） |
| GET | `/api/auth/me` | 獲取當前用戶 |
| GET | `/api/auth/logout` | 退出登錄 |
| POST | `/api/auth/2fa/generate` | 生成 TOTP 密鑰（返回 `secret` + `qr`） |
| POST | `/api/auth/2fa/verify` | 驗證驗證碼並啟用 2FA |
| POST | `/api/auth/2fa/disable` | 禁用 2FA（需提供有效驗證碼） |
| GET | `/api/auth/sso` | SSO 登錄跳轉（Github / Microsoft / Google / OIDC） |
| GET | `/api/auth/sso_callback` | SSO 回調 |
| GET | `/api/auth/get_sso_id` | 獲取當前用戶的 SSO 身份 |
| GET | `/api/auth/sso_get_token` | 用 SSO 授權碼換取會話令牌 |

### 個人資料

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/me` | 獲取當前用戶資料 |
| POST | `/api/me/update` | 修改用戶名/密碼（修改密碼時需 `old_password`） |
| GET | `/api/me/sshkey/list` | SSH 密鑰（佔位） |

### 文件系統

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/fs/list` | 列出目錄下的文件（`path`、`page`、`per_page`、`refresh`） |
| POST | `/api/fs/get` | 獲取文件/目錄信息（`path`） |
| POST | `/api/fs/dirs` | 列出目錄（`path`） |
| POST | `/api/fs/mkdir` | 創建目錄（`path`、`name`） |
| POST | `/api/fs/rename` | 重命名（`path`、`name`） |
| POST | `/api/fs/batch_rename` | 批量重命名 |
| POST | `/api/fs/regex_rename` | 正則重命名 |
| POST | `/api/fs/remove` | 刪除（`dir`、`names[]`） |
| POST | `/api/fs/remove_empty_directory` | 刪除空目錄 |
| POST | `/api/fs/move` | 移動（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/recursive_move` | 遞歸移動 |
| POST | `/api/fs/copy` | 複製（`src_dir`、`dst_dir`、`names[]`） |
| PUT | `/api/fs/put` | 上傳（`?path=` + 請求體） |
| PUT | `/api/fs/form` | 表單上傳 |
| POST | `/api/fs/add_offline_download` | 添加離線下載任務（aria2 / qBittorrent / Transmission） |
| POST | `/api/fs/archive/meta` | 獲取壓縮包元信息（`path`） |
| POST | `/api/fs/archive/list` | 列出壓縮包內文件（`path`、`inner`） |
| POST | `/api/fs/archive/decompress` | 解壓壓縮包（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/search` | 搜索（佔位） |
| POST | `/api/fs/other` | 其他驅動操作（佔位） |
| POST | `/api/fs/link` | 生成下載鏈接（`path`） |
| POST | `/api/fs/get_direct_upload_info` | 獲取直傳信息 |

### 下載 / 代理

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/d/<path>` | 302 跳轉到簽名下載鏈接 |
| GET/HEAD | `/p/<path>` | 通過 Worker 流式傳輸文件（支持 Range） |
| GET | `/ad/<path>?inner=` | 流式讀取壓縮包內的單個文件 |
| GET | `/ap/<path>?inner=` | 代理壓縮包內的單個文件（支持 Range） |
| GET | `/ae/<path>?inner=` | 解壓壓縮包內單個條目（下載） |
| GET | `/sd/<sid>/<path>` | 下載分享中的文件（密碼分享需 `pwd`） |

### 分享

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/share/list` | 列出分享 |
| GET | `/api/share/get?id=` | 獲取分享 |
| POST | `/api/share/create` | 創建分享（`files[]`、`expires`、`pwd`、`max_accessed` 等） |
| POST | `/api/share/update` | 更新分享 |
| POST | `/api/share/delete?id=` | 刪除分享 |
| POST | `/api/share/enable?id=` | 啟用分享 |
| POST | `/api/share/disable?id=` | 停用分享 |

### WebDAV

通過標準 WebDAV 協議在 `/dav/` 掛載你的雲端網盤為本地資料夾。支持方法：
`PROPFIND`、`GET`、`HEAD`、`PUT`、`MKCOL`、`DELETE`、`MOVE`、`COPY`、`LOCK`、`UNLOCK`、`OPTIONS`。

每個存儲以頂層資料夾形式出現在 `/dav/` 下（如 `/dav/backblaze/...`）。

### 管理 — 存儲

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/storage/list` | 列出存儲 |
| GET | `/api/admin/storage/get?id=` | 獲取存儲 |
| POST | `/api/admin/storage/create` | 創建存儲 |
| POST | `/api/admin/storage/update` | 更新存儲 |
| POST | `/api/admin/storage/delete?id=` | 刪除存儲 |
| POST | `/api/admin/storage/enable?id=` | 啟用 |
| POST | `/api/admin/storage/disable?id=` | 禁用 |
| POST | `/api/admin/storage/refresh` | 刷新所有文件樹緩存 |
| POST | `/api/admin/storage/refresh_one?id=` | 刷新單個存儲緩存 |

### 管理 — 設置

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/setting/list` | 列出設置（可選 `?group=`） |
| GET | `/api/admin/setting/get?key=` | 獲取設置 |
| POST | `/api/admin/setting/save` | 保存一個或多個設置 |
| POST | `/api/admin/setting/delete?key=` | 刪除設置 |

### 管理 — 用戶

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/user/list` | 列出用戶 |
| GET | `/api/admin/user/get?id=` | 獲取用戶 |
| POST | `/api/admin/user/create` | 創建用戶 |
| POST | `/api/admin/user/update` | 更新用戶 |
| POST | `/api/admin/user/delete?id=` | 刪除用戶 |

### 管理 — 驅動

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/driver/names` | 列出已註冊的驅動名 |
| GET | `/api/admin/driver/list` | 完整驅動信息 |
| GET | `/api/admin/driver/info?driver=` | 單個驅動信息 |

### 管理 — 元數據（路徑級）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/meta/list` | 列出元數據 |
| GET | `/api/admin/meta/get?path=` | 獲取某路徑的元數據 |
| POST | `/api/admin/meta/create` | 創建元數據（readme / header / 密碼 / 隱藏 / 讀寫用戶） |
| POST | `/api/admin/meta/update` | 更新元數據 |
| POST | `/api/admin/meta/delete?path=` | 刪除元數據 |

### 任務（離線下載、傳輸等）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/task/<type>/undone` | 未完成任務列表 |
| GET | `/api/task/<type>/done` | 已完成任務列表 |
| GET | `/api/task/<type>/info?tid=` | 任務詳情 |
| POST | `/api/task/<type>/cancel?tid=` | 取消任務 |
| POST | `/api/task/<type>/delete?tid=` | 刪除任務 |
| POST | `/api/task/<type>/retry?tid=` | 重試任務 |
| POST | `/api/task/<type>/clear_done` | 清空已完成任務 |

### 公開

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/public/settings` | 公開設置（站點標題、logo、favicon 等） |
| GET | `/api/public/archive_extensions` | 壓縮文件擴展名 |
| GET | `/api/public/offline_download_tools` | 已配置的離線下載工具（aria2 / qBittorrent / Transmission） |

---

## ⚙️ 設置

| 鍵 | 默認值 | 說明 |
|---|---|---|
| `site_title` | `OpenList` | 站點標題 |
| `site_description` | `A file list program` | 站點描述 |
| `logo` | `/images/logo.svg` | 站點 Logo |
| `favicon` | `/images/logo.png` | 站點圖標 |
| `max_connections` | `0` | 最大連接數（0 = 不限） |
| `cache_expiration` | `30` | 默認緩存有效期（分鐘） |
| `aria2_uri` / `aria2_secret` | | aria2 RPC 地址 / 密鑰（離線下載） |
| `qbittorrent_url` / `qbittorrent_seedtime` | | qBittorrent Web API / 做種時間（離線下載） |
| `transmission_uri` / `transmission_seedtime` | | Transmission RPC / 做種時間（離線下載） |

> 匿名瀏覽由用戶列表中的 **`guest` 用戶賬號**控制 —— 默認停用。啟用它即可允許訪客無需登錄瀏覽。

---

## 🗂️ 項目結構

```
src/
├── db/                       # 跨雲數據庫層（D1 / PostgreSQL / Hyperdrive）
│   ├── types.ts              # 共享 Database 接口（不含 CF 專有類型）
│   ├── d1.ts                 # D1 適配器（Cloudflare）
│   ├── postgres.ts           # PostgreSQL 適配器（postgres.js，跨雲）
│   ├── sqlite.ts             # SQLite → PostgreSQL SQL 轉換器
│   └── index.ts              # createDatabase(env)：USE_D1 / PG_ADDRS 切換
├── drivers/                  # 存儲驅動
│   ├── types.ts              # 核心驅動接口
│   ├── registry.ts           # 驅動註冊與查找
│   ├── base.ts               # 公共輔助函數
│   ├── s3/                   # S3 兼容驅動
│   ├── onedrive/             # OneDrive 驅動
│   ├── onedrive_app/         # OneDrive APP（Azure AD 應用）驅動
│   ├── aliyundrive_open/     # 阿里雲盤驅動
│   ├── pikpak/               # PikPak 驅動
│   ├── dropbox/              # Dropbox 驅動
│   ├── cloud189/             # 天翼雲盤（189Cloud）驅動
│   ├── google_drive/         # Google Drive 驅動
│   ├── webdav/               # WebDAV 驅動
│   └── template.ts           # 可直接複製的驅動模板
├── models/
│   ├── init.ts               # schema 初始化與默認數據
│   └── schema.sql            # D1 schema
├── routes/
│   ├── api.ts                # API 路由
│   ├── auth.ts               # 認證 + 2FA + 個人資料
│   ├── sso.ts                # SSO 登錄（Github / Microsoft / Google / OIDC）
│   ├── fs.ts                 # 文件系統路由 + 數據庫緩存
│   ├── download.ts           # /d/、/p/ 與壓縮包下載路由
│   ├── share.ts              # 文件分享路由
│   ├── storage.ts            # 存儲管理路由
│   ├── settings.ts           # 設置管理路由
│   ├── users.ts              # 用戶管理路由
│   ├── drivers.ts            # 驅動管理路由
│   ├── meta.ts               # 路徑級元數據管理路由
│   ├── tasks.ts              # 任務路由（離線下載、傳輸等）
│   ├── refresh.ts            # 緩存刷新路由
│   ├── webdav.ts             # WebDAV 路由
│   └── static.ts             # 靜態資源
├── utils/
│   ├── otp.ts                # TOTP 實現
│   ├── crypto.ts             # 密碼哈希輔助
│   ├── auth.ts               # 令牌 / 密碼 / 權限輔助
│   ├── sign.ts               # 下載鏈接簽名
│   ├── guest.ts              # 訪客用戶模型
│   ├── response.ts           # JSON 響應輔助
│   ├── meta.ts               # 路徑級元數據輔助
│   ├── archive.ts            # 壓縮包預覽 / 解壓（zip / tar / gz）
│   └── offline.ts            # 離線下載（aria2 / qBittorrent / Transmission）
├── cache.ts                  # 數據庫緩存原語（文件、鏈接、鎖）
├── router.ts                 # 主路由
├── types.ts                  # TypeScript 類型
├── static-local.ts           # 本地靜態資源提供器（Bun / Deno，無 node 依賴）
├── server.ts                 # 跨平台入口（Bun / Deno）
└── worker.ts                 # Worker 入口（Cloudflare）
```

### 添加新的存儲驅動

1. 創建 `src/drivers/<name>/index.ts`，實現 `Driver` 接口（`list`、`get`、`link`、`mkdir`、`rename`、`copy`、`move`、`remove`、`put`）。
2. 導出 `config` 和 `additional`，調用 `registerDriver(...)`。
3. 在 `src/drivers/registry.ts` 中導入該模塊。

可參考 `src/drivers/template.ts` 中的現成模板。

---

## 📄 許可證

[AGPL-3.0](../LICENSE)
