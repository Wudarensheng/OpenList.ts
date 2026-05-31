export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ASSETS: Fetcher;
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
