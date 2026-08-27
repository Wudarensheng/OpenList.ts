/**
 * Per-path metadata (port of OpenList's internal/op/meta + server/common/check).
 *
 * A meta entry attaches to a path and can provide:
 *  - a folder password (`password` + `p_sub`)
 *  - a README / header rendered in list & get responses (`readme`/`header` + `*_sub`)
 *  - hide regexes filtered from listings (`hide` + `h_sub`)
 *  - per-user read/write restrictions (`read_users` / `write_users` + `*_sub`)
 *  - a write override for folders the storage driver can't grant itself
 */

import { Env } from '../types';

export interface Meta {
  id: number;
  path: string;
  read_users: number[];
  read_users_sub: boolean;
  write_users: number[];
  write_users_sub: boolean;
  password: string;
  p_sub: boolean;
  write: boolean;
  w_sub: boolean;
  hide: string;
  h_sub: boolean;
  readme: string;
  r_sub: boolean;
  header: string;
  header_sub: boolean;
}

export function rowToMeta(row: any): Meta {
  const parseIds = (s: string | null): number[] => {
    try {
      const v = JSON.parse(s || '[]');
      return Array.isArray(v) ? v.map(Number) : [];
    } catch {
      return [];
    }
  };
  return {
    id: (row as any).id,
    path: (row as any).path || '/',
    read_users: parseIds((row as any).read_users),
    read_users_sub: !!((row as any).read_users_sub),
    write_users: parseIds((row as any).write_users),
    write_users_sub: !!((row as any).write_users_sub),
    password: (row as any).password || '',
    p_sub: !!((row as any).p_sub),
    write: !!((row as any).write),
    w_sub: !!((row as any).w_sub),
    hide: (row as any).hide || '',
    h_sub: !!((row as any).h_sub),
    readme: (row as any).readme || '',
    r_sub: !!((row as any).r_sub),
    header: (row as any).header || '',
    header_sub: !!((row as any).header_sub),
  };
}

function fixPath(p: string): string {
  if (!p) return '/';
  let cleaned = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!cleaned.startsWith('/')) cleaned = '/' + cleaned;
  while (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

export function isSubPath(parent: string, child: string): boolean {
  const p = fixPath(parent);
  const c = fixPath(child);
  if (p === '/') return true;
  return c === p || c.startsWith(p + '/');
}

// Load all metas, longest path first (cheap on D1 for personal scale).
export async function getMetas(env: Env): Promise<Meta[]> {
  try {
    const rows = await env.DB.prepare(
      'SELECT * FROM metas ORDER BY length(path) DESC, id ASC'
    ).all();
    return (rows.results || []).map(rowToMeta);
  } catch {
    return [];
  }
}

export async function getMetaById(id: number, env: Env): Promise<Meta | null> {
  try {
    const row = await env.DB.prepare('SELECT * FROM metas WHERE id = ?').bind(id).first();
    return row ? rowToMeta(row) : null;
  } catch {
    return null;
  }
}

// Find the meta whose path is the closest ancestor of `path`.
export async function getNearestMeta(path: string, env: Env): Promise<Meta | null> {
  const target = fixPath(path);
  const metas = await getMetas(env);
  let nearest: Meta | null = null;
  for (const m of metas) {
    if (isSubPath(m.path, target)) {
      if (!nearest || m.path.length > nearest.path.length) nearest = m;
    }
  }
  return nearest;
}

export function metaCoversPath(metaPath: string, reqPath: string, applyToSub: boolean): boolean {
  if (fixPath(metaPath) === fixPath(reqPath)) return true;
  return isSubPath(metaPath, reqPath) && applyToSub;
}

// Validate the hide regexes (newline separated). Returns the invalid line or ''.
export function validHide(hide: string): string {
  for (const line of hide.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      new RegExp(t);
    } catch {
      return t;
    }
  }
  return '';
}

// Access control check. Mirrors OpenList's common.CanAccess.
export function canAccess(user: any, meta: Meta | null, reqPath: string, password?: string): boolean {
  const permission = user?.role === 2 ? 0xFFFFFFFF : Number(user?.permission) || 0;
  const canSeeHides = (permission & 1) !== 0;
  const canAccessWithoutPassword = (permission >> 1 & 1) !== 0;

  // Hide filter: regexes matched against the base name; meta must cover the parent.
  if (meta && !canSeeHides && meta.hide && metaCoversPath(meta.path, fixPath(reqPath).substring(0, fixPath(reqPath).lastIndexOf('/')) || '/', meta.h_sub)) {
    const base = fixPath(reqPath).split('/').pop() || '';
    for (const line of meta.hide.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        if (new RegExp(t).test(base)) return false;
      } catch {
        // ignore invalid regex
      }
    }
  }

  // Read-user restriction
  if (meta && meta.read_users.length > 0 && user && !meta.read_users.includes(Number(user.id)) && metaCoversPath(meta.path, reqPath, meta.read_users_sub)) {
    return false;
  }

  if (canAccessWithoutPassword) return true;
  if (!meta || !meta.password) return true;
  if (!metaCoversPath(meta.path, reqPath, meta.p_sub)) return true;
  return meta.password === (password || '');
}

export function getReadme(meta: Meta | null, path: string): string {
  if (meta && metaCoversPath(meta.path, path, meta.r_sub)) return meta.readme || '';
  return '';
}

export function getHeader(meta: Meta | null, path: string): string {
  if (meta && metaCoversPath(meta.path, path, meta.header_sub)) return meta.header || '';
  return '';
}

// Whether paths under `path` need signed links (meta password protection).
export function isMetaEncrypt(meta: Meta | null, path: string): boolean {
  return !!(meta && meta.password && metaCoversPath(meta.path, path, meta.p_sub));
}

// Apply a meta's hide regexes to a listing of items (by name).
export function filterMetaHide(items: any[], meta: Meta | null, parentPath: string): any[] {
  if (!meta || !meta.hide || !metaCoversPath(meta.path, parentPath, meta.h_sub)) return items;
  const regexes: RegExp[] = [];
  for (const line of meta.hide.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      regexes.push(new RegExp(t));
    } catch {
      // ignore
    }
  }
  if (!regexes.length) return items;
  return items.filter(it => !regexes.some(re => re.test(it.name)));
}
