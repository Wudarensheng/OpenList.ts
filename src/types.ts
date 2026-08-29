import type { Database } from './db';

/** Static asset provider (Cloudflare ASSETS binding, external server or local files). */
export interface AssetProvider {
  fetch(request: Request): Promise<Response>;
}

/** Minimal execution context used off Cloudflare (no CF-specific members needed). */
export interface ContextLike {}

export interface Env {
  /**
   * Database handle. Always accessed through the database abstraction layer;
   * at runtime this is a D1 database (D1 mode) or the adapter chosen by
   * `createDatabase` (PostgreSQL / Hyperdrive mode).
   */
  DB: Database;
  ENVIRONMENT: string;
  /** Static file source. Optional off Cloudflare; see STATIC_BASE / LOCAL_STATIC. */
  ASSETS?: AssetProvider;
  /**
   * Database backend switch: "true" (default) uses D1, "false" uses
   * PostgreSQL (via HYPERDRIVE binding or PG_ADDRS). Enables cross-cloud
   * deployments outside of Cloudflare.
   */
  USE_D1?: string;
  /** External PostgreSQL connection string, e.g. postgres://user:pass@host:5432/dbname */
  PG_ADDRS?: string;
  /** Cloudflare Hyperdrive binding (used when USE_D1=false). */
  HYPERDRIVE?: { connectionString: string };
  /** External static-server base URL (plain fetch, cross-cloud). */
  STATIC_BASE?: string;
  /** Local static provider injected by the cross-platform entry (src/server.ts). */
  LOCAL_STATIC?: AssetProvider;
}

export interface Storage {
  id: number;
  mount_path: string;
  order: number;
  driver: string;
  cache_expiration: number;
  status: string;
  addition: string;
  remark: string;
  modified: string;
  disabled: boolean;
  disable_index: boolean;
  enable_sign: boolean;
  order_by: string;
  order_direction: string;
  extract_folder: string;
  web_proxy: boolean;
  webdav_policy: string;
  proxy_range: boolean;
  down_proxy_url: string;
  disable_proxy_sign: boolean;
}

export interface SettingItem {
  key: string;
  value: string;
  help: string;
  type: string;
  options: string;
  group: number;
  flag: number;
  index: number;
}

export interface FileObject {
  id: string;
  path: string;
  name: string;
  size: number;
  modified: string;
  ctime: string;
  is_folder: boolean;
  hash_info: string;
  storage_id: number;
}

export interface User {
  id: number;
  username: string;
  password: string;
  role: number;
  disabled: boolean;
  sso_id: string;
  otp_secret: string;
}

export interface S3Config {
  bucket: string;
  endpoint: string;
  region: string;
  access_key_id: string;
  access_key_secret: string;
  root_path: string;
  custom_host: string;
  sign_url_expire: number;
  enable_custom_host_presign: boolean;
  remove_bucket: boolean;
  add_filename_to_disposition: boolean;
  list_object_version: string;
  placeholder: string;
}

export interface ListResult {
  content: FileObject[];
  total: number;
  readme: string;
  header: string;
  write: boolean;
  provider: string;
}
