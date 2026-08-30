# OpenList.ts

[![Cloudflare Workers にデプロイ](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

[Cloudflare Workers](https://workers.cloudflare.com/) 上で動作するファイルリストプログラムです。OpenList/AList 風の Web UI で、S3 互換ストレージ（Backblaze B2、Cloudflare R2、AWS S3、MinIO など）、Microsoft OneDrive、OneDrive APP、Alibaba Cloud Drive、PikPak、Dropbox、189Cloud（天翼云盤）上のファイルを閲覧・管理できます。

すべて TypeScript で書かれており、デフォルトで Workers ランタイム上で動作し、ファイルツリーとダウンロードリンクは [Cloudflare D1](https://developers.cloudflare.com/d1/) にキャッシュされます。データベース層はクラウド横断対応です — `USE_D1=false` にすると PostgreSQL（Cloudflare では [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) バインディング、または `PG_ADDRS` 接続文字列）を使用します。同じリクエストハンドラは Cloudflare 外の Bun / Deno / Node でも実行できます（[Cloudflare 外での実行](#-cloudflare-外での実行) を参照）。

> **OpenList.ts** は OpenList エコシステムのプロジェクトであり、OpenList エコシステムに属する派生プロジェクトです。

---

## ✨ 機能

- ☁️ デフォルトで Cloudflare Workers + D1 上で完結（VPS 不要）
- 🌍 **クラウド横断・クロスプラットフォーム**：データベース層は D1 または PostgreSQL（Hyperdrive / `PG_ADDRS`）に対応。同じリクエストハンドラは Cloudflare 外の Bun / Deno / Node でも実行可能
- 📁 マルチストレージ対応：**S3 互換**（B2 / R2 / AWS / MinIO）、**OneDrive**、**OneDrive APP**、**Alibaba Cloud Drive**、**PikPak**、**Dropbox**、**189Cloud（天翼云盤）**
- 🗄️ **ファイルツリーキャッシュ**：ブラウズ時はデータベースのキャッシュを読み取り、ストレージ提供元へは管理者がコールドパスを開いたときだけ接続。ダウンロード URL はダウンロード時に遅延生成
- 🔐 ユーザー認証・権限（ゲスト / ユーザー / 管理者）
- 🛡️ **TOTP 二段階認証（2FA）** — Google Authenticator 互換
- 🔑 パスワード変更・プロフィール更新
- 👤 匿名（ゲスト）ブラウズを `guest` ユーザーアカウントでオプション提供（デフォルト無効）
- 🖥️ 管理パネル：ストレージ、設定、ユーザー、ドライバー、パス別メタデータ管理
- 🔗 **ファイル共有** — パスワード保護・有効期限・アクセス回数制限に対応
- 📤 **オフラインダウンロード** — URL / magnet を aria2 / qBittorrent / Transmission に引き渡し
- 🗜️ **アーカイブプレビューと解凍** — ファイル全体をダウンロードせずに zip / tar / gz の中身を閲覧・抽出
- 📥 直接ダウンロード（`/d/`）、プロキシダウンロード（`/p/`）、アーカイブダウンロード（`/ad/`、`/ap/`、`/ae/`）、Range/HEAD 対応
- 💻 **WebDAV**（`/dav/`）— クラウドドライブをローカルフォルダとしてマウント（Windows エクスプローラー、macOS Finder、rclone など）
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
| `npm run build:node` | Node 版を `dist-node/` にビルド（`node build.js`） |
| `npm run db:reset` | 全テーブルを削除してスキーマを再初期化 |

---

## 🌍 Cloudflare 外での実行

同じリクエストハンドラは、Web 標準の `Request`/`Response` セマンティクスを持つ任意のホストで実行できます。Cloudflare 外には D1 バインディングがないため、代わりに PostgreSQL を使用します：

- **Bun**：`bun run src/server.ts`
- **Deno**：`deno run --allow-net --allow-read --allow-env src/server.ts`
- **Node**：`node build.js`（または `npm run build:node`）でプロジェクトと組み込み Node エントリを `dist-node/` にコンパイルし、`node dist-node/server-node.js` で起動
- **クラウド関数**：ベンダーのビルドステップで `node build.js` を実行し、関数エントリを `dist-node/server-node.js` に指定

実行要件（Cloudflare 外には D1 バインディングなし）：

```bash
USE_D1=false                              # PostgreSQL モード
PG_ADDRS=postgres://user:pass@host:5432/dbname
# 任意：STATIC_BASE=https://...           # 外部サーバーで静的アセットを配信
# 任意：PUBLIC_DIR=/path/to/public        # node ビルド：ローカル静的ファイル（デフォルト dist-node/public）
# 任意：PORT=3000                         # node ビルド：リッスンポート
# 任意：HOST=0.0.0.0                      # node ビルド：バインドアドレス
```

---

## 🔐 認証

### デフォルト認証情報

| ユーザー名 | パスワード | ロール |
|---|---|---|
| `admin` | `admin` | 管理者 |

> ⚠️ **初回ログイン後、すぐにデフォルトパスワードを変更してください**（プロフィール → パスワード変更）。

### ロール

- **ゲスト**（`role 1`）— 匿名訪問者。`guest` ユーザーアカウントは初期状態で**無効**になっており、ユーザー一覧で有効にすると匿名ブラウズが可能になります。
- **ユーザー**（`role 0`）— ファイルの閲覧・管理が可能。
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

### 189Cloud（天翼云盤）

`addition` 例：

```json
{
  "username": "your-phone-number",
  "password": "your-password",
  "cookie": ""
}
```

> キャプチャでログインできない場合は、`cookie` フィールドにログイン済みセッション Cookie を入力してください。

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
| GET | `/api/auth/sso` | SSO ログインリダイレクト（Github / Microsoft / Google / OIDC） |
| GET | `/api/auth/sso_callback` | SSO コールバック |
| GET | `/api/auth/get_sso_id` | 現在のユーザーの SSO 識別情報を取得 |
| GET | `/api/auth/sso_get_token` | SSO コードをセッショントークンと交換 |

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
| POST | `/api/fs/batch_rename` | 一括リネーム |
| POST | `/api/fs/regex_rename` | 正規表現リネーム |
| POST | `/api/fs/remove` | 削除（`dir`、`names[]`） |
| POST | `/api/fs/remove_empty_directory` | 空ディレクトリを削除 |
| POST | `/api/fs/move` | 移動（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/recursive_move` | 再帰移動 |
| POST | `/api/fs/copy` | コピー（`src_dir`、`dst_dir`、`names[]`） |
| PUT | `/api/fs/put` | アップロード（`?path=` + ボディ） |
| PUT | `/api/fs/form` | マルチパートアップロード |
| POST | `/api/fs/add_offline_download` | オフラインダウンロードタスクを追加（aria2 / qBittorrent / Transmission） |
| POST | `/api/fs/archive/meta` | アーカイブメタデータ取得（`path`） |
| POST | `/api/fs/archive/list` | アーカイブ内のファイル一覧（`path`、`inner`） |
| POST | `/api/fs/archive/decompress` | アーカイブを解凍（`src_dir`、`dst_dir`、`names[]`） |
| POST | `/api/fs/search` | 検索（スタブ） |
| POST | `/api/fs/other` | その他のドライバー操作（スタブ） |
| POST | `/api/fs/link` | ダウンロードリンク生成（`path`） |
| POST | `/api/fs/get_direct_upload_info` | 直接アップロード情報を取得 |

### ダウンロード / プロキシ

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/d/<path>` | 署名済みダウンロード URL へ 302 リダイレクト |
| GET/HEAD | `/p/<path>` | Worker 経由でファイルをストリーム（Range 対応） |
| GET | `/ad/<path>?inner=` | アーカイブ内の単一ファイルをストリーム |
| GET | `/ap/<path>?inner=` | アーカイブ内の単一ファイルをプロキシ（Range 対応） |
| GET | `/ae/<path>?inner=` | アーカイブ内の単一エントリを解凍してダウンロード |
| GET | `/sd/<sid>/<path>` | 共有ファイルをダウンロード（パスワード共有は `pwd`） |

### 共有

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/share/list` | 共有一覧 |
| GET | `/api/share/get?id=` | 共有取得 |
| POST | `/api/share/create` | 共有作成（`files[]`、`expires`、`pwd`、`max_accessed` など） |
| POST | `/api/share/update` | 共有更新 |
| POST | `/api/share/delete?id=` | 共有削除 |
| POST | `/api/share/enable?id=` | 共有有効化 |
| POST | `/api/share/disable?id=` | 共有無効化 |

### WebDAV

標準 WebDAV プロトコルで `/dav/` にクラウドドライブをローカルフォルダとしてマウントできます。対応メソッド：
`PROPFIND`、`GET`、`HEAD`、`PUT`、`MKCOL`、`DELETE`、`MOVE`、`COPY`、`LOCK`、`UNLOCK`、`OPTIONS`。

各ストレージは `/dav/` のトップレベルフォルダとして表示されます（例: `/dav/backblaze/...`）。

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

### 管理 — メタデータ（パス別）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/meta/list` | メタデータ一覧 |
| GET | `/api/admin/meta/get?path=` | パスのメタデータ取得 |
| POST | `/api/admin/meta/create` | メタデータ作成（readme / header / パスワード / 非表示 / 読み書きユーザー） |
| POST | `/api/admin/meta/update` | メタデータ更新 |
| POST | `/api/admin/meta/delete?path=` | メタデータ削除 |

### タスク（オフラインダウンロード、転送など）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/task/<type>/undone` | 未完了タスク一覧 |
| GET | `/api/task/<type>/done` | 完了タスク一覧 |
| GET | `/api/task/<type>/info?tid=` | タスク詳細 |
| POST | `/api/task/<type>/cancel?tid=` | タスクキャンセル |
| POST | `/api/task/<type>/delete?tid=` | タスク削除 |
| POST | `/api/task/<type>/retry?tid=` | タスク再試行 |
| POST | `/api/task/<type>/clear_done` | 完了タスクをクリア |

### 公開

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/public/settings` | 公開設定（サイトタイトル、ロゴ、ファビコンなど） |
| GET | `/api/public/archive_extensions` | アーカイブ拡張子 |
| GET | `/api/public/offline_download_tools` | 設定済みのオフラインダウンロードツール（aria2 / qBittorrent / Transmission） |

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
| `aria2_uri` / `aria2_secret` | | aria2 RPC エンドポイント / シークレット（オフラインダウンロード） |
| `qbittorrent_url` / `qbittorrent_seedtime` | | qBittorrent Web API / シード時間（オフラインダウンロード） |
| `transmission_uri` / `transmission_seedtime` | | Transmission RPC / シード時間（オフラインダウンロード） |

> 匿名ブラウズはユーザー一覧の **`guest` ユーザーアカウント**で制御します — 初期状態では無効です。有効にするとログインなしでのブラウズが可能になります。

---

## 🗂️ プロジェクト構成

```
src/
├── db/                       # クラウド横断データベース層（D1 / PostgreSQL / Hyperdrive）
│   ├── types.ts              # 共有 Database インターフェース（CF 専有型なし）
│   ├── d1.ts                 # D1 アダプター（Cloudflare）
│   ├── postgres.ts           # PostgreSQL アダプター（postgres.js、クラウド横断）
│   ├── sqlite.ts             # SQLite → PostgreSQL SQL 変換
│   └── index.ts              # createDatabase(env)：USE_D1 / PG_ADDRS 切替
├── drivers/                  # ストレージドライバー
│   ├── types.ts              # コアドライバーインターフェース
│   ├── registry.ts           # ドライバー登録・検索
│   ├── base.ts               # 共通ヘルパー
│   ├── s3/                   # S3 互換ドライバー
│   ├── onedrive/             # OneDrive ドライバー
│   ├── onedrive_app/         # OneDrive APP（Azure AD アプリ）ドライバー
│   ├── aliyundrive_open/     # Alibaba Cloud Drive ドライバー
│   ├── pikpak/               # PikPak ドライバー
│   ├── dropbox/              # Dropbox ドライバー
│   ├── cloud189/             # 189Cloud（天翼云盤）ドライバー
│   ├── google_drive/         # Google Drive ドライバー
│   ├── webdav/               # WebDAV ドライバー
│   └── template.ts           # コピー可能なドライバーテンプレート
├── models/
│   ├── init.ts               # スキーマ初期化とデフォルトデータ
│   └── schema.sql            # D1 スキーマ
├── routes/
│   ├── api.ts                # API ルーター
│   ├── auth.ts               # 認証 + 2FA + プロフィール
│   ├── sso.ts                # SSO ログイン（Github / Microsoft / Google / OIDC）
│   ├── fs.ts                 # ファイルシステムルート + データベースキャッシュ
│   ├── download.ts           # /d/、/p/ とアーカイブダウンロードルート
│   ├── share.ts              # ファイル共有ルート
│   ├── storage.ts            # ストレージ管理ルート
│   ├── settings.ts           # 設定管理ルート
│   ├── users.ts              # ユーザー管理ルート
│   ├── drivers.ts            # ドライバー管理ルート
│   ├── meta.ts               # パス別メタデータ管理ルート
│   ├── tasks.ts              # タスクルート（オフラインダウンロード、転送など）
│   ├── refresh.ts            # キャッシュ更新ルート
│   ├── webdav.ts             # WebDAV ルート
│   └── static.ts             # 静的アセット
├── utils/
│   ├── otp.ts                # TOTP 実装
│   ├── crypto.ts             # パスワードハッシュヘルパー
│   ├── auth.ts               # トークン / パスワード / 権限ヘルパー
│   ├── sign.ts               # ダウンロードリンク署名
│   ├── guest.ts              # ゲストユーザーモデル
│   ├── response.ts           # JSON レスポンスヘルパー
│   ├── meta.ts               # パス別メタデータヘルパー
│   ├── archive.ts            # アーカイブプレビュー / 解凍（zip / tar / gz）
│   └── offline.ts            # オフラインダウンロード（aria2 / qBittorrent / Transmission）
├── cache.ts                  # データベースキャッシュプリミティブ（ファイル、リンク、ロック）
├── router.ts                 # メインルーター
├── types.ts                  # TypeScript 型
├── static-local.ts           # ローカル静的プロバイダー（Bun / Deno、node 依存なし）
├── server.ts                 # クロスプラットフォームエントリ（Bun / Deno）
└── worker.ts                 # Worker エントリポイント（Cloudflare）
```

### 新しいストレージドライバーの追加

1. `src/drivers/<name>/index.ts` を作成し、`Driver` インターフェース（`list`、`get`、`link`、`mkdir`、`rename`、`copy`、`move`、`remove`、`put`）を実装。
2. `config` と `additional` をエクスポートし、`registerDriver(...)` を呼び出す。
3. `src/drivers/registry.ts` でモジュールをインポート。

テンプレートは `src/drivers/template.ts` を参照してください。

---

## 📄 ライセンス

[AGPL-3.0](../LICENSE)
