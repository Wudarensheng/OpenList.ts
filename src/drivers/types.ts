export interface DriverConfig {
  name: string;
  label: string;
  local_sort: boolean;
  only_local: boolean;
  only_proxy: boolean;
  no_cache: boolean;
  no_upload: boolean;
  need_ms: boolean;
  default_root: string;
  alert?: string;
}

export interface DriverItem {
  name: string;
  type: 'string' | 'number' | 'bool' | 'select' | 'text' | 'float';
  default: string;
  options: string;
  required?: boolean;
  help?: string;
}

export interface DriverInfo {
  config: DriverConfig;
  common?: DriverItem[];
  additional: DriverItem[];
}

export interface FileObject {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created?: string;
  thumb?: string;
  hash_info?: string;
  url?: string;
}

export interface ListResult {
  content: FileObject[];
  total: number;
}

export interface LinkResult {
  url: string;
  header?: Record<string, string>;
}

export interface Driver {
  // Initialize the driver with config
  init(config: Record<string, any>): Promise<void>;
  
  // List files in directory
  list(path: string, config: Record<string, any>): Promise<ListResult>;
  
  // Get file info
  get(path: string, config: Record<string, any>): Promise<FileObject>;
  
  // Get download link
  link(path: string, config: Record<string, any>): Promise<LinkResult>;
  
  // Create directory
  mkdir(path: string, config: Record<string, any>): Promise<void>;
  
  // Rename file/directory
  rename(path: string, newName: string, config: Record<string, any>): Promise<void>;
  
  // Copy file
  copy(src: string, dst: string, config: Record<string, any>): Promise<void>;
  
  // Move file
  move(src: string, dst: string, config: Record<string, any>): Promise<void>;
  
  // Delete file/directory
  remove(path: string, config: Record<string, any>): Promise<void>;
  
  // Upload file
  put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void>;
}
