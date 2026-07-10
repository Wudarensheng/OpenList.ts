/**
 * Template Driver
 * A template for creating new storage drivers
 * Use this as a reference when implementing new drivers
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from './types';
import { registerDriver } from './registry';
import { normalizePath, createFileObj, createDirObj } from './base';

// Driver configuration
const config: DriverConfig = {
  name: 'Template',
  label: 'Template Driver',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields specific to this driver
const additional: DriverItem[] = [
  { name: 'api_key', type: 'string', default: '', options: '', required: true, help: 'API Key' },
  { name: 'api_secret', type: 'string', default: '', options: '', required: true, help: 'API Secret' },
  { name: 'endpoint', type: 'string', default: 'https://api.example.com', options: '', required: false, help: 'API Endpoint' },
];

/**
 * Template Driver Implementation
 */
export class TemplateDriver implements Driver {
  private apiKey: string = '';
  private apiSecret: string = '';
  private endpoint: string = '';

  config(): DriverConfig {
    return config;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.apiKey = cfg.api_key;
    this.apiSecret = cfg.api_secret;
    this.endpoint = cfg.endpoint || 'https://api.example.com';
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    // TODO: Implement list files
    throw new Error('Not implemented');
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    // TODO: Implement get file info
    throw new Error('Not implemented');
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    // TODO: Implement get download link
    throw new Error('Not implemented');
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement create directory
    throw new Error('Not implemented');
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement rename
    throw new Error('Not implemented');
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement copy
    throw new Error('Not implemented');
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement move
    throw new Error('Not implemented');
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement delete
    throw new Error('Not implemented');
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    // TODO: Implement upload
    throw new Error('Not implemented');
  }
}

// Register this driver
registerDriver(TemplateDriver, config, additional);
