# OpenList.ts

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [簡體中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

一個基於 [Cloudflare Workers](https://workers.cloudflare.com/) 的文件列表程序 —— 採用 OpenList/AList 風格網頁界面，可瀏覽和管理 S3 兼容存儲（Backblaze B2、Cloudflare R2、AWS S3、MinIO 等）、Microsoft OneDrive、阿里雲盤、PikPak 和 Dropbox 上的文件。

全部使用 TypeScript 編寫，運行在 Workers 運行時上，文件樹和下載鏈接緩存存儲在 [Cloudflare D1](https://developers.cloudflare.com/d1/) 中。

> **OpenList.ts** 是 OpenList 生態項目及衍生項目，屬於 OpenList 生態。

---

## ✨ 功能特性

- ☁️ 完全運行在 Cloudflare Workers + D1 上（無需 VPS）
- 📁 多存儲支持：**S3 兼容**（B2 / R2 / AWS / MinIO）、**OneDrive**、**OneDrive APP**、**阿里雲盤**、**PikPak**、**Dropbox**
- 🗄️ **D1 文件樹緩存**：瀏覽時從 D1 讀取緩存的文件樹 —— 僅當管理員訪問冷路徑時才聯繫存儲提供商，下載鏈接在下載時才按需生成
- 🔐 用戶認證與授權（訪客 / 普通用戶 / 管理員）
- 🛡️ **TOTP 雙因素認證（2FA）** —— 兼容 Google Authenticator
- 🔑 修改密碼與個人資料
- 👤 通過 `guest` 用戶賬號提供可選的匿名（訪客）瀏覽，默認關閉
- 🖥️ 管理面板：存儲、設置、用戶和驅動管理
- 📥 直鏈下載（`/d/`）與代理下載（`/p/`），支持 Range/HEAD
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
| `npm run db:reset` | 刪除所有表並重新初始化 schema |

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
| POST | `/api/fs/remove` | 刪除（`dir`、`names[]`） |
| POST | `/api/fs/move` | 移動（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/copy` | 複製（`src_dir`、`dst_dir`、`names[]`） |
| PUT | `/api/fs/put` | 上傳（`?path=` + 請求體） |
| PUT | `/api/fs/form` | 表單上傳 |
| POST | `/api/fs/search` | 搜索（佔位） |

### 下載 / 代理

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/d/<path>` | 302 跳轉到簽名下載鏈接 |
| GET/HEAD | `/p/<path>` | 通過 Worker 流式傳輸文件（支持 Range） |

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

### 公開

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/public/settings` | 公開設置（站點標題、logo、favicon 等） |
| GET | `/api/public/archive_extensions` | 壓縮文件擴展名 |
| GET | `/api/public/offline_download_tools` | 離線下載工具（佔位） |

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

> 匿名瀏覽由用戶列表中的 **`guest` 用戶賬號**控制 —— 默認停用。啟用它即可允許訪客無需登錄瀏覽。

---

## 🗂️ 項目結構

```
src/
├── drivers/                  # 存儲驅動
│   ├── types.ts              # 核心驅動接口
│   ├── registry.ts           # 驅動註冊與查找
│   ├── base.ts               # 公共輔助函數
│   ├── s3/                   # S3 兼容驅動
│   ├── onedrive/             # OneDrive 驅動
│   ├── onedrive_app/         # OneDrive APP（Azure AD 應用）驅動
│   ├── aliyundrive_open/     # 阿里雲盤驅動
│   ├── pikpak/               # PikPak 驅動
│   └── dropbox/              # Dropbox 驅動
├── models/
│   ├── init.ts               # schema 初始化與默認數據
│   └── schema.sql            # D1 schema
├── routes/
│   ├── api.ts                # API 路由
│   ├── auth.ts               # 認證 + 2FA + 個人資料
│   ├── fs.ts                 # 文件系統路由 + D1 緩存
│   ├── download.ts           # /d/ 和 /p/ 下載路由
│   ├── storage.ts            # 存儲管理路由
│   ├── settings.ts           # 設置管理路由
│   ├── users.ts              # 用戶管理路由
│   ├── drivers.ts            # 驅動管理路由
│   ├── refresh.ts            # 緩存刷新路由
│   └── static.ts             # 靜態資源
├── utils/
│   ├── otp.ts                # TOTP 實現
│   ├── crypto.ts             # 密碼哈希輔助
│   ├── guest.ts              # 訪客用戶模型
│   └── response.ts           # JSON 響應輔助
├── cache.ts                  # D1 緩存原語（文件、鏈接、鎖）
├── router.ts                 # 主路由
├── types.ts                  # TypeScript 類型
└── worker.ts                 # Worker 入口
```

### 添加新的存儲驅動

1. 創建 `src/drivers/<name>/index.ts`，實現 `Driver` 接口（`list`、`get`、`link`、`mkdir`、`rename`、`copy`、`move`、`remove`、`put`）。
2. 導出 `config` 和 `additional`，調用 `registerDriver(...)`。
3. 在 `src/drivers/registry.ts` 中導入該模塊。

可參考 `src/drivers/template.ts` 中的現成模板。

---

## 📄 許可證

[AGPL-3.0](../LICENSE)
