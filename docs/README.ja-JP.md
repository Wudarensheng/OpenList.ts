# OpenList.ts

[![Cloudflare Workers にデプロイ](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [中文](./README.zh-CN.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [한국어](./README.ko-KR.md)

[Cloudflare Workers](https://workers.cloudflare.com/) 上で動作するファイルリストプログラムです。OpenList/AList 風の Web UI で、S3 互換ストレージ（Backblaze B2、Cloudflare R2、AWS S3、MinIO など）、Microsoft OneDrive、Alibaba Cloud Drive、PikPak、Dropbox 上のファイルを閲覧・管理できます。

すべて TypeScript で書かれており、Workers ランタイム上で動作し、ファイルツリーとダウンロードリンクは [Cloudflare D1](https://developers.cloudflare.com/d1/) にキャッシュされます。

> **OpenList.ts** は OpenList/AList プロジェクトに触発された新規 TypeScript 書き直しであり、元プロジェクトとは**無関係**です。

---

## ✨ 機能

- ☁️ Cloudflare Workers + D1 上で完結（VPS 不要）
- 📁 マルチストレージ対応：**S3 互換**（B2 / R2 / AWS / MinIO）、**OneDrive**、**OneDrive APP**、**Alibaba Cloud Drive**、**PikPak**、**Dropbox**
- 🗄️ **D1 ファイルツリーキャッシュ**：ブラウズ時は D1 のキャッシュを読み取り、ストレージ提供元へは管理者がコールドパスを開いたときだけ接続。ダウンロード URL はダウンロード時に遅延生成
- 🔐 ユーザー認証・権限（ゲスト / ユーザー / 管理者）
- 🛡️ **TOTP 二段階認証（2FA）** — Google Authenticator 互換
- 🔑 パスワード変更・プロフィール更新
- 👤 匿名（ゲスト）ブラウズをオプションで有効化（デフォルト無効）
- 🖥️ 管理パネル：ストレージ、設定、ユーザー、ドライバー管理
- 📥 直接ダウンロード（`/d/`）とプロキシダウンロード（`/p/`）、Range/HEAD 対応
- 🔄 署名済みリンクのキャッシュとシングルフライト重複排除

---

## 🚀 クイックデプロイ

[![Cloudflare Workers にデプロイ](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

上のボタンをクリックすると、Cloudflare アカウントに直接デプロイできます（Workers と D1 が自動生成されます）。デプロイ後、Worker URL を開いてデフォルト認証情報でログインし、管理パネルでストレージを追加してください。

### 手動デプロイ

前提条件：[Node.js](https://nodejs.org/) 18+ と [Wrangler](https://developers.cloudflare.com/workers/wrangler/)。

```bash
# 1. 依存関係のインストール（pnpm 推奨）
pnpm install          # または: npm install

# 2. Cloudflare にログイン
npx wrangler login

# 3. D1 データベースを作成し database_id を控える
npx wrangler d1 create openlist-db
#   → 出力された database_id を wrangler.toml の [[d1_databases]] に記入

# 4. スキーマを適用
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. （任意）ローカルでプレビュー
npm run dev           # http://127.0.0.1:8787

# 6. Cloudflare にデプロイ
npm run deploy
```

---

## 🖥️ ローカル開発

```bash
pnpm install
npm run dev          # wrangler dev を起動 http://127.0.0.1:8787
```

D1 データベースは `.wrangler/state` 下でローカルにシミュレートされ、スキーマとキャッシュは再起動後も保持されます。

その他のスクリプト：

| コマンド | 説明 |
|---|---|
| `npm run typecheck` | TypeScript 型チェック（`tsc --noEmit`） |
| `npm run lint` | `src` に対して ESLint |
| `npm test` | Vitest テストランナー |
| `npm run deploy` | Cloudflare にデプロイ |
| `npm run db:reset` | 全テーブルを削除してスキーマを再初期化 |

---

## 🔐 認証

### デフォルト認証情報

| ユーザー名 | パスワード | ロール |
|---|---|---|
| `admin` | `admin` | 管理者 |

> ⚠️ **初回ログイン後、すぐにデフォルトパスワードを変更してください**（プロフィール → パスワード変更）。

### ロール

- **ゲスト**（`role 0`）— 匿名訪問者。`anonymous` 設定を有効にした場合のみ表示されます。
- **ユーザー**（`role 1`）— ファイルの閲覧・管理が可能。
- **管理者**（`role 2`）— 管理パネルを含むフルアクセス。

> ブラウズ時にストレージ提供元へは接続しません。**管理者**がコールドパスを開いたときだけプロバイダーへアクセスして D1 ファイルツリーを構築します。ゲスト・一般ユーザーは常にキャッシュから読み取ります。

### 二段階認証（2FA）

1. ログイン後、**プロフィール** → **二段階認証** を開く。
2. **有効化**をクリックしてシークレットを生成し、Google Authenticator（または TOTP 対応アプリ）で QR コードをスキャン。
3. 6 桁のコードを入力して確定。
4. 以降のログインでは 6 桁のコードが必要です。

2FA を有効にしたアカウントでは、ログインページに OTP 入力欄が自動表示されます。

---

## 🗄️ ファイルツリーキャッシュ

ファイルツリーは D1 にキャッシュされ、ブラウズは高速かつプロバイダーに優しい動作になります：

1. **ブラウズ**（`/api/fs/list`、`/api/fs/get`、`/api/fs/dirs`）は **D1 からのみ**ファイルツリーを読み取ります。ストレージ提供元へは接続しません。
2. **管理者**が未キャッシュ（またはキャッシュ期限切れ）のパスを開くと、Worker がリモートディレクトリを一度だけ取得し、D1（`files`、`file_cache` テーブル）に保存します。
3. **ダウンロード**（`/d/`、`/p/`）は署名済み URL をオンデマンドで生成し、D1（`file_links` テーブル）にキャッシュするため、繰り返しダウンロードしても再署名されません。
4. 空ディレクトリもキャッシュされます（`file_cache` 行でマーク）。

キャッシュ有効期間はストレージごとに `cache_expiration` フィールドで設定できます（分単位、デフォルト 30）。

---

## 📦 対応ストレージ

### S3 互換（Backblaze B2、Cloudflare R2、AWS S3、MinIO など）

管理パネルでドライバー **S3** のストレージを追加し、`addition` JSON を指定します：

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

> Backblaze B2 の場合は `region: "auto"` を使用してください。ドライバーがエンドポイントのホスト名からリージョンを自動検出します。

### Microsoft OneDrive / OneDrive APP

2 つのドライバーを提供しています：

- **OneDrive** — リフレッシュトークンで個人 OneDrive にアクセス。
- **OneDrive APP** — Azure AD アプリ登録フロー。Global / CN（世紀互聯）/ DE / US リージョン対応。

`addition` 例（OneDrive APP）：

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

## 📡 API リファレンス

### 認証

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/login` | ログイン（平文パスワード） |
| POST | `/api/auth/login/hash` | ログイン（sha256 ハッシュ、フロントエンド用。`otp_code` 対応） |
| GET | `/api/auth/me` | 現在のユーザー取得 |
| GET | `/api/auth/logout` | ログアウト |
| POST | `/api/auth/2fa/generate` | TOTP シークレット生成（`secret` + `qr` を返す） |
| POST | `/api/auth/2fa/verify` | コード検証と 2FA 有効化 |
| POST | `/api/auth/2fa/disable` | 2FA 無効化（有効なコードが必要） |

### プロフィール

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/me` | 現在のユーザープロフィール取得 |
| POST | `/api/me/update` | ユーザー名 / パスワード変更（パスワード変更時は `old_password` 必須） |
| GET | `/api/me/sshkey/list` | SSH キー（スタブ） |

### ファイルシステム

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/fs/list` | ディレクトリ内のファイル一覧（`path`、`page`、`per_page`、`refresh`） |
| POST | `/api/fs/get` | ファイル / ディレクトリ情報取得（`path`） |
| POST | `/api/fs/dirs` | ディレクトリ一覧（`path`） |
| POST | `/api/fs/mkdir` | ディレクトリ作成（`path`、`name`） |
| POST | `/api/fs/rename` | リネーム（`path`、`name`） |
| POST | `/api/fs/remove` | 削除（`dir`、`names[]`） |
| POST | `/api/fs/move` | 移動（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/copy` | コピー（`src_dir`、`dst_dir`、`names[]`） |
| PUT | `/api/fs/put` | アップロード（`?path=` + ボディ） |
| PUT | `/api/fs/form` | マルチパートアップロード |
| POST | `/api/fs/search` | 検索（スタブ） |

### ダウンロード / プロキシ

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/d/<path>` | 署名済みダウンロード URL へ 302 リダイレクト |
| GET/HEAD | `/p/<path>` | Worker 経由でファイルをストリーム（Range 対応） |

### 管理 — ストレージ

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/storage/list` | ストレージ一覧 |
| GET | `/api/admin/storage/get?id=` | ストレージ取得 |
| POST | `/api/admin/storage/create` | ストレージ作成 |
| POST | `/api/admin/storage/update` | ストレージ更新 |
| POST | `/api/admin/storage/delete?id=` | ストレージ削除 |
| POST | `/api/admin/storage/enable?id=` | 有効化 |
| POST | `/api/admin/storage/disable?id=` | 無効化 |
| POST | `/api/admin/storage/refresh` | 全ファイルツリーキャッシュを更新 |
| POST | `/api/admin/storage/refresh_one?id=` | 1 つのストレージキャッシュを更新 |

### 管理 — 設定

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/setting/list` | 設定一覧（任意 `?group=`） |
| GET | `/api/admin/setting/get?key=` | 設定取得 |
| POST | `/api/admin/setting/save` | 設定保存 |
| POST | `/api/admin/setting/delete?key=` | 設定削除 |

### 管理 — ユーザー

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/user/list` | ユーザー一覧 |
| GET | `/api/admin/user/get?id=` | ユーザー取得 |
| POST | `/api/admin/user/create` | ユーザー作成 |
| POST | `/api/admin/user/update` | ユーザー更新 |
| POST | `/api/admin/user/delete?id=` | ユーザー削除 |

### 管理 — ドライバー

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/driver/names` | 登録済みドライバー名一覧 |
| GET | `/api/admin/driver/list` | ドライバー情報マップ |
| GET | `/api/admin/driver/info?driver=` | 個別ドライバー情報 |

### 公開

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/public/settings` | 公開設定（`anonymous` を含む） |
| GET | `/api/public/archive_extensions` | アーカイブ拡張子 |
| GET | `/api/public/offline_download_tools` | オフラインダウンロードツール（スタブ） |

---

## ⚙️ 設定

| キー | デフォルト | 説明 |
|---|---|---|
| `site_title` | `OpenList` | サイトタイトル |
| `site_description` | `A file list program` | サイト説明 |
| `logo` | `/images/logo.svg` | ロゴ |
| `favicon` | `/images/logo.png` | ファビコン |
| `max_connections` | `0` | 最大接続数（0 = 無制限） |
| `cache_expiration` | `30` | デフォルトキャッシュ有効期間（分） |
| `anonymous` | `false` | 匿名ブラウズを許可。`false` の場合はログイン必須 |

---

## 🗂️ プロジェクト構成

```
src/
├── drivers/                  # ストレージドライバー
│   ├── types.ts              # コアドライバーインターフェース
│   ├── registry.ts           # ドライバー登録・検索
│   ├── base.ts               # 共通ヘルパー
│   ├── s3/                   # S3 互換ドライバー
│   ├── onedrive/             # OneDrive ドライバー
│   ├── onedrive_app/         # OneDrive APP（Azure AD アプリ）ドライバー
│   ├── aliyundrive_open/     # Alibaba Cloud Drive ドライバー
│   ├── pikpak/               # PikPak ドライバー
│   └── dropbox/              # Dropbox ドライバー
├── models/
│   ├── init.ts               # スキーマ初期化とデフォルトデータ
│   └── schema.sql            # D1 スキーマ
├── routes/
│   ├── api.ts                # API ルーター
│   ├── auth.ts               # 認証 + 2FA + プロフィール
│   ├── fs.ts                 # ファイルシステムルート + D1 キャッシュ
│   ├── download.ts           # /d/ と /p/ ダウンロードルート
│   ├── storage.ts            # ストレージ管理ルート
│   ├── settings.ts           # 設定管理ルート
│   ├── users.ts              # ユーザー管理ルート
│   ├── drivers.ts            # ドライバー管理ルート
│   ├── refresh.ts            # キャッシュ更新ルート
│   └── static.ts             # 静的アセット
├── utils/
│   ├── otp.ts                # TOTP 実装
│   ├── crypto.ts             # パスワードハッシュヘルパー
│   ├── guest.ts              # ゲストユーザーモデル
│   └── response.ts           # JSON レスポンスヘルパー
├── cache.ts                  # D1 キャッシュプリミティブ（ファイル、リンク、ロック）
├── router.ts                 # メインルーター
├── types.ts                  # TypeScript 型
└── worker.ts                 # Worker エントリポイント
```

### 新しいストレージドライバーの追加

1. `src/drivers/<name>/index.ts` を作成し、`Driver` インターフェース（`list`、`get`、`link`、`mkdir`、`rename`、`copy`、`move`、`remove`、`put`）を実装。
2. `config` と `additional` をエクスポートし、`registerDriver(...)` を呼び出す。
3. `src/drivers/registry.ts` でモジュールをインポート。

テンプレートは `src/drivers/template.ts` を参照してください。

---

## 📄 ライセンス

[AGPL-3.0](../LICENSE)
