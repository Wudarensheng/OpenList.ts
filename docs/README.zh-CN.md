# OpenList.ts

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

一个基于 [Cloudflare Workers](https://workers.cloudflare.com/) 的文件列表程序 —— 采用 OpenList/AList 风格网页界面，可浏览和管理 S3 兼容存储（Backblaze B2、Cloudflare R2、AWS S3、MinIO 等）、Microsoft OneDrive、阿里云盘、PikPak 和 Dropbox 上的文件。

全部使用 TypeScript 编写，运行在 Workers 运行时上，文件树和下载链接缓存存储在 [Cloudflare D1](https://developers.cloudflare.com/d1/) 中。

> **OpenList.ts** 是 OpenList 生态项目及衍生项目，属于 OpenList 生态。

---

## ✨ 功能特性

- ☁️ 完全运行在 Cloudflare Workers + D1 上（无需 VPS）
- 📁 多存储支持：**S3 兼容**（B2 / R2 / AWS / MinIO）、**OneDrive**、**OneDrive APP**、**阿里云盘**、**PikPak**、**Dropbox**
- 🗄️ **D1 文件树缓存**：浏览时从 D1 读取缓存的文件树 —— 仅当管理员访问冷路径时才联系存储提供商，下载链接在下载时才按需生成
- 🔐 用户认证与授权（访客 / 普通用户 / 管理员）
- 🛡️ **TOTP 双因素认证（2FA）** —— 兼容 Google Authenticator
- 🔑 修改密码与个人资料
- 👤 通过 `guest` 用户账号提供可选的匿名（访客）浏览，默认关闭
- 🖥️ 管理面板：存储、设置、用户和驱动管理
- 📥 直链下载（`/d/`）与代理下载（`/p/`），支持 Range/HEAD
- 💻 **WebDAV**（`/dav/`）—— 将云端网盘挂载为本地文件夹（Windows 资源管理器、macOS Finder、rclone 等）
- 🔄 预签名链接缓存与单飞去重

---

## 🚀 快速部署

[![部署到 Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

点击上方按钮即可直接部署到你的 Cloudflare 账户（会自动创建 Workers 和 D1）。部署完成后打开 Worker 地址，使用默认凭据登录，然后在管理面板中添加存储。

### 手动部署

前置要求：[Node.js](https://nodejs.org/) 18+ 和 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)。

```bash
# 1. 安装依赖（推荐使用 pnpm）
pnpm install          # 或：npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 D1 数据库并记录 database_id
npx wrangler d1 create openlist-db
#   → 将输出的 database_id 填写到 wrangler.toml 的 [[d1_databases]] 中

# 4. 初始化数据库
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. （可选）本地预览
npm run dev           # http://127.0.0.1:8787

# 6. 部署到 Cloudflare
npm run deploy
```

---

## 🖥️ 本地开发

```bash
pnpm install
npm run dev          # 启动 wrangler dev，监听 http://127.0.0.1:8787
```

D1 数据库在本地 `.wrangler/state` 下模拟，schema 和缓存数据重启后仍会保留。

其他常用脚本：

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `npm run lint` | 对 `src` 运行 ESLint |
| `npm test` | Vitest 测试运行器 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run db:reset` | 删除所有表并重新初始化 schema |

---

## 🔐 认证

### 默认凭据

| 用户名 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin` | 管理员 |

> ⚠️ **首次登录后请立即修改默认密码**（个人资料 → 修改密码）。

### 角色

- **访客**（`role 1`）— 匿名访问者。`guest` 用户账号默认**停用**，在用户列表中启用它即可允许匿名浏览。
- **普通用户**（`role 0`）— 可浏览和管理文件。
- **管理员**（`role 2`）— 完整权限，包括管理面板。

> 浏览时不会联系存储提供商。只有**管理员**访问冷路径时才会触发提供商拉取以填充 D1 文件树；访客和普通用户始终从缓存读取。

### 双因素认证（2FA）

1. 登录后进入 **个人资料** → **双因素认证**。
2. 点击**启用**生成密钥，用 Google Authenticator（或任意 TOTP 应用）扫描二维码。
3. 输入 6 位验证码确认。
4. 此后登录都需要输入 6 位验证码。

当你的账号启用了 2FA 时，登录页面会自动显示 OTP 输入框。

---

## 🗄️ 文件树缓存

文件树缓存在 D1 中，浏览快速且对提供商友好：

1. **浏览**（`/api/fs/list`、`/api/fs/get`、`/api/fs/dirs`）**只从 D1 读取**文件树，绝不联系存储提供商。
2. 当**管理员**打开未缓存（或缓存过期）的路径时，Worker 一次性列出远程目录并存入 D1（`files`、`file_cache` 表）。
3. **下载**（`/d/` 和 `/p/`）按需生成签名下载 URL 并缓存在 D1（`file_links` 表），重复下载不会重新签名。
4. 空目录也会被缓存（通过 `file_cache` 行标记），避免反复访问提供商。

每个存储可通过 `cache_expiration` 字段配置缓存有效期（分钟，默认 30）。

---

## 📦 支持的存储

### S3 兼容（Backblaze B2、Cloudflare R2、AWS S3、MinIO 等）

在管理面板中添加驱动为 **S3** 的存储，`addition` JSON 示例：

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

> Backblaze B2 使用 `region: "auto"`，驱动会自动从 endpoint 主机名识别区域。

### Microsoft OneDrive / OneDrive APP

提供两个驱动：

- **OneDrive** — 通过 refresh token 访问个人 OneDrive。
- **OneDrive APP** — Azure AD 应用注册流程，支持 Global / CN（世纪互联）/ DE / US 区域。

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

## 📡 API 参考

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录（明文密码） |
| POST | `/api/auth/login/hash` | 登录（sha256 哈希，前端使用；支持 `otp_code`） |
| GET | `/api/auth/me` | 获取当前用户 |
| GET | `/api/auth/logout` | 退出登录 |
| POST | `/api/auth/2fa/generate` | 生成 TOTP 密钥（返回 `secret` + `qr`） |
| POST | `/api/auth/2fa/verify` | 验证验证码并启用 2FA |
| POST | `/api/auth/2fa/disable` | 禁用 2FA（需提供有效验证码） |

### 个人资料

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me` | 获取当前用户资料 |
| POST | `/api/me/update` | 修改用户名/密码（修改密码时需 `old_password`） |
| GET | `/api/me/sshkey/list` | SSH 密钥（占位） |

### 文件系统

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/fs/list` | 列出目录下的文件（`path`、`page`、`per_page`、`refresh`） |
| POST | `/api/fs/get` | 获取文件/目录信息（`path`） |
| POST | `/api/fs/dirs` | 列出目录（`path`） |
| POST | `/api/fs/mkdir` | 创建目录（`path`、`name`） |
| POST | `/api/fs/rename` | 重命名（`path`、`name`） |
| POST | `/api/fs/remove` | 删除（`dir`、`names[]`） |
| POST | `/api/fs/move` | 移动（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/copy` | 复制（`src_dir`、`dst_dir`、`names[]`） |
| PUT | `/api/fs/put` | 上传（`?path=` + 请求体） |
| PUT | `/api/fs/form` | 表单上传 |
| POST | `/api/fs/search` | 搜索（占位） |

### 下载 / 代理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/d/<path>` | 302 跳转到签名下载链接 |
| GET/HEAD | `/p/<path>` | 通过 Worker 流式传输文件（支持 Range） |

### WebDAV

通过标准 WebDAV 协议在 `/dav/` 挂载你的云端网盘为本地文件夹。支持方法：
`PROPFIND`、`GET`、`HEAD`、`PUT`、`MKCOL`、`DELETE`、`MOVE`、`COPY`、`LOCK`、`UNLOCK`、`OPTIONS`。

**Windows（资源管理器）：**
1. 右键"此电脑" → **映射网络驱动器**。
2. 文件夹填 `http://<你的worker>/dav/`。
3. 勾选"使用其他凭据连接"，输入 OpenList 用户名/密码。

**rclone：**
```bash
rclone config
# type = webdav
# url  = https://<你的worker>/dav
# vendor = other
# user = <openlist用户名>
# pass = <openlist密码>
```

每个存储以顶层文件夹形式出现在 `/dav/` 下（如 `/dav/backblaze/...`）。

### 管理 — 存储

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/storage/list` | 列出存储 |
| GET | `/api/admin/storage/get?id=` | 获取存储 |
| POST | `/api/admin/storage/create` | 创建存储 |
| POST | `/api/admin/storage/update` | 更新存储 |
| POST | `/api/admin/storage/delete?id=` | 删除存储 |
| POST | `/api/admin/storage/enable?id=` | 启用 |
| POST | `/api/admin/storage/disable?id=` | 禁用 |
| POST | `/api/admin/storage/refresh` | 刷新所有文件树缓存 |
| POST | `/api/admin/storage/refresh_one?id=` | 刷新单个存储缓存 |

### 管理 — 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/setting/list` | 列出设置（可选 `?group=`） |
| GET | `/api/admin/setting/get?key=` | 获取设置 |
| POST | `/api/admin/setting/save` | 保存一个或多个设置 |
| POST | `/api/admin/setting/delete?key=` | 删除设置 |

### 管理 — 用户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/user/list` | 列出用户 |
| GET | `/api/admin/user/get?id=` | 获取用户 |
| POST | `/api/admin/user/create` | 创建用户 |
| POST | `/api/admin/user/update` | 更新用户 |
| POST | `/api/admin/user/delete?id=` | 删除用户 |

### 管理 — 驱动

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/driver/names` | 列出已注册的驱动名 |
| GET | `/api/admin/driver/list` | 完整驱动信息 |
| GET | `/api/admin/driver/info?driver=` | 单个驱动信息 |

### 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/public/settings` | 公开设置（站点标题、logo、favicon 等） |
| GET | `/api/public/archive_extensions` | 压缩文件扩展名 |
| GET | `/api/public/offline_download_tools` | 离线下载工具（占位） |

---

## ⚙️ 设置

| 键 | 默认值 | 说明 |
|---|---|---|
| `site_title` | `OpenList` | 站点标题 |
| `site_description` | `A file list program` | 站点描述 |
| `logo` | `/images/logo.svg` | 站点 Logo |
| `favicon` | `/images/logo.png` | 站点图标 |
| `max_connections` | `0` | 最大连接数（0 = 不限） |
| `cache_expiration` | `30` | 默认缓存有效期（分钟） |

> 匿名浏览由用户列表中的 **`guest` 用户账号**控制 —— 默认停用。启用它即可允许访客无需登录浏览。

---

## 🗂️ 项目结构

```
src/
├── drivers/                  # 存储驱动
│   ├── types.ts              # 核心驱动接口
│   ├── registry.ts           # 驱动注册与查找
│   ├── base.ts               # 公共辅助函数
│   ├── s3/                   # S3 兼容驱动
│   ├── onedrive/             # OneDrive 驱动
│   ├── onedrive_app/         # OneDrive APP（Azure AD 应用）驱动
│   ├── aliyundrive_open/     # 阿里云盘驱动
│   ├── pikpak/               # PikPak 驱动
│   └── dropbox/              # Dropbox 驱动
├── models/
│   ├── init.ts               # schema 初始化与默认数据
│   └── schema.sql            # D1 schema
├── routes/
│   ├── api.ts                # API 路由
│   ├── auth.ts               # 认证 + 2FA + 个人资料
│   ├── fs.ts                 # 文件系统路由 + D1 缓存
│   ├── download.ts           # /d/ 和 /p/ 下载路由
│   ├── storage.ts            # 存储管理路由
│   ├── settings.ts           # 设置管理路由
│   ├── users.ts              # 用户管理路由
│   ├── drivers.ts            # 驱动管理路由
│   ├── refresh.ts            # 缓存刷新路由
│   └── static.ts             # 静态资源
├── utils/
│   ├── otp.ts                # TOTP 实现
│   ├── crypto.ts             # 密码哈希辅助
│   ├── guest.ts              # 访客用户模型
│   └── response.ts           # JSON 响应辅助
├── cache.ts                  # D1 缓存原语（文件、链接、锁）
├── router.ts                 # 主路由
├── types.ts                  # TypeScript 类型
└── worker.ts                 # Worker 入口
```

### 添加新的存储驱动

1. 创建 `src/drivers/<name>/index.ts`，实现 `Driver` 接口（`list`、`get`、`link`、`mkdir`、`rename`、`copy`、`move`、`remove`、`put`）。
2. 导出 `config` 和 `additional`，调用 `registerDriver(...)`。
3. 在 `src/drivers/registry.ts` 中导入该模块。

可参考 `src/drivers/template.ts` 中的现成模板。

---

## 📄 许可证

[AGPL-3.0](../LICENSE)
