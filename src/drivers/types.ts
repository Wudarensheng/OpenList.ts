// Core driver types - inspired by OpenList's driver interface design
// Adapted for Cloudflare Workers stateless environment

export interface Obj {
  /** File/folder name */
  name: string;
  /** File size in bytes (0 for folders) */
  size: number;
  /** Whether this is a directory */
  is_dir: boolean;
  /** Last modified time (ISO string) */
  modified: string;
  /** Creation time (ISO string, optional) */
  created?: string;
  /** Thumbnail URL (optional) */
  thumb?: string;
  /** Hash info (optional) */
  hash_info?: string;
  /** Internal ID used by driver (optional) */
  id?: string;
  /** Internal path used by driver (optional) */
  path?: string;
}

export interface ListResult {
  /** List of files/folders */
  content: Obj[];
  /** Total count */
  total: number;
}

export interface LinkResult {
  /** Download URL */
  url: string;
  /** Optional headers for the request */
  header?: Record<string, string>;
}

export interface DriverConfig {
  /** Driver name (unique identifier) */
  name: string;
  /** Display label */
  label: string;
  /** Whether to sort locally */
  local_sort: boolean;
  /** Only support proxy mode */
  only_proxy: boolean;
  /** Disable caching */
  no_cache: boolean;
  /** Disable upload */
  no_upload: boolean;
  /** Default root path */
  default_root: string;
  /** Alert message (optional) */
  alert?: string;
}

export interface DriverItem {
  /** Field name */
  name: string;
  /** Field type */
  type: 'string' | 'number' | 'bool' | 'select' | 'text' | 'float';
  /** Default value */
  default: string;
  /** Options for select type (comma-separated) */
  options: string;
  /** Whether required */
  required?: boolean;
  /** Help text */
  help?: string;
}

export interface DriverInfo {
  /** Driver configuration */
  config: DriverConfig;
  /** Common fields (shared by all drivers) */
  common?: DriverItem[];
  /** Driver-specific additional fields */
  additional: DriverItem[];
}

/**
 * Base driver interface
 * All storage drivers must implement this interface
 */
export interface Driver {
  /** Get driver configuration */
  config(): DriverConfig;
  
  /** Initialize driver with config */
  init(config: Record<string, any>): Promise<void>;
  
  /** List files in directory */
  list(path: string, config: Record<string, any>): Promise<ListResult>;
  
  /** Get file info */
  get(path: string, config: Record<string, any>): Promise<Obj>;
  
  /** Get download link */
  link(path: string, config: Record<string, any>): Promise<LinkResult>;
  
  /** Create directory */
  mkdir(path: string, config: Record<string, any>): Promise<void>;
  
  /** Rename file/directory */
  rename(path: string, newName: string, config: Record<string, any>): Promise<void>;
  
  /** Copy file */
  copy(src: string, dst: string, config: Record<string, any>): Promise<void>;
  
  /** Move file */
  move(src: string, dst: string, config: Record<string, any>): Promise<void>;
  
  /** Delete file/directory */
  remove(path: string, config: Record<string, any>): Promise<void>;
  
  /** Upload file */
  put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void>;
}

/**
 * Optional interface for drivers that support getting file by path
 */
export interface Getter {
  get(path: string, config: Record<string, any>): Promise<Obj>;
}

/**
 * Type for driver constructor
 */
export type DriverConstructor = new () => Driver;
