/**
 * Base driver utilities
 * Common functions shared across drivers
 */

import { Obj, ListResult, LinkResult } from './types';

/**
 * Normalize path - ensure it starts with / and doesn't end with /
 */
export function normalizePath(path: string): string {
  if (!path) return '/';
  let normalized = path;
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Join paths
 */
export function joinPath(...parts: string[]): string {
  return parts
    .map(part => part.replace(/^\/|\/$/g, ''))
    .filter(part => part.length > 0)
    .join('/');
}

/**
 * Get parent path
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

/**
 * Get file name from path
 */
export function getFileName(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Create a file object
 */
export function createFileObj(params: {
  name: string;
  size?: number;
  modified?: string;
  created?: string;
  thumb?: string;
  hash_info?: string;
  id?: string;
  path?: string;
}): Obj {
  return {
    name: params.name,
    size: params.size || 0,
    is_dir: false,
    modified: params.modified || new Date().toISOString(),
    created: params.created,
    thumb: params.thumb,
    hash_info: params.hash_info,
    id: params.id,
    path: params.path,
  };
}

/**
 * Create a directory object
 */
export function createDirObj(params: {
  name: string;
  modified?: string;
  created?: string;
  id?: string;
  path?: string;
}): Obj {
  return {
    name: params.name,
    size: 0,
    is_dir: true,
    modified: params.modified || new Date().toISOString(),
    created: params.created,
    id: params.id,
    path: params.path,
  };
}

/**
 * Make HTTP request with retry
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || i === maxRetries - 1) {
        return response;
      }
      // Retry on 5xx errors
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        await sleep(Math.pow(2, i) * 100); // Exponential backoff
        continue;
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i === maxRetries - 1) throw lastError;
      await sleep(Math.pow(2, i) * 100);
    }
  }
  
  throw lastError || new Error('Request failed');
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Encode path for URL
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * Parse JSON safely
 */
export function parseJSON<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Get file extension
 */
export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

/**
 * Check if path is a folder (ends with /)
 */
export function isFolderPath(path: string): boolean {
  return path.endsWith('/');
}

/**
 * Remove trailing slash from path
 */
export function removeTrailingSlash(path: string): string {
  if (path.endsWith('/') && path.length > 1) {
    return path.slice(0, -1);
  }
  return path;
}

/**
 * Add trailing slash to path
 */
export function addTrailingSlash(path: string): string {
  if (!path.endsWith('/')) {
    return path + '/';
  }
  return path;
}
