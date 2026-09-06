/**
 * Github (GitHub Contents / Git Trees API) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/github (driver.ts + util.ts + types.ts).
 *
 * List / get / link go through the contents API (Accept:
 * application/vnd.github.object+json). Every write is committed through the
 * git data API: upload blob → rewrite trees up to the repo root → create a
 * commit → fast-forward the ref. A per-instance promise chain serializes
 * concurrent commits on the same branch.
 *
 * `root_folder_path` keeps the "base folder" semantics of the reference: the
 * whole driver operates on <root_folder_path> + <mount-relative path> inside
 * the repository, while all tree/commit operations still climb to the repo
 * root ("/").
 *
 * gpg_private_key / gpg_key_passphrase are preserved as config fields; the
 * reference never signs commits with them.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const githubConfig: DriverConfig = {
  name: 'Github',
  label: 'GitHub',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const githubAdditional: DriverItem[] = [
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: 'Root folder path' },
  { name: 'token', type: 'string', default: '', options: '', required: true, help: 'Access token' },
  { name: 'owner', type: 'string', default: '', options: '', required: true, help: 'Repo owner' },
  { name: 'repo', type: 'string', default: '', options: '', required: true, help: 'Repository name' },
  { name: 'ref', type: 'string', default: '', options: '', required: false, help: 'A branch, a tag or a commit SHA, default branch by default.' },
  { name: 'gh_proxy', type: 'string', default: '', options: '', required: false, help: 'GitHub proxy, e.g. https://ghproxy.net/raw.githubusercontent.com' },
  { name: 'gpg_private_key', type: 'text', default: '', options: '', required: false, help: 'GPG private key (unused)' },
  { name: 'gpg_key_passphrase', type: 'string', default: '', options: '', required: false, help: 'GPG key passphrase (unused)' },
  { name: 'committer_name', type: 'string', default: '', options: '', required: false, help: 'Committer name' },
  { name: 'committer_email', type: 'string', default: '', options: '', required: false, help: 'Committer email' },
  { name: 'author_name', type: 'string', default: '', options: '', required: false, help: 'Author name' },
  { name: 'author_email', type: 'string', default: '', options: '', required: false, help: 'Author email' },
  { name: 'mkdir_commit_message', type: 'text', default: '{{.UserName}} mkdir {{.ObjPath}}', options: '', required: false, help: 'Commit message template for mkdir' },
  { name: 'delete_commit_message', type: 'text', default: '{{.UserName}} remove {{.ObjPath}}', options: '', required: false, help: 'Commit message template for delete' },
  { name: 'put_commit_message', type: 'text', default: '{{.UserName}} upload {{.ObjPath}}', options: '', required: false, help: 'Commit message template for upload' },
  { name: 'rename_commit_message', type: 'text', default: '{{.UserName}} rename {{.ObjPath}} to {{.TargetName}}', options: '', required: false, help: 'Commit message template for rename' },
  { name: 'copy_commit_message', type: 'text', default: '{{.UserName}} copy {{.ObjPath}} to {{.TargetPath}}', options: '', required: false, help: 'Commit message template for copy' },
  { name: 'move_commit_message', type: 'text', default: '{{.UserName}} move {{.ObjPath}} to {{.TargetPath}}', options: '', required: false, help: 'Commit message template for move' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: 'Sort field' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Sort direction' },
];

// ---------------------------------------------------------------- types

interface GithubLinks {
  git: string;
  html: string;
  self: string;
}

interface GithubObject {
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  encoding?: string;
  size: number;
  name: string;
  path: string;
  content?: string;
  sha: string;
  url: string;
  git_url: string;
  html_url: string;
  download_url: string | null;
  entries?: GithubObject[];
  _links?: GithubLinks;
  submodule_git_url?: string;
  target?: string;
}

interface GithubTreeObjReq {
  path: string;
  mode: string; // "100644" file, "100755" executable, "040000" tree (dir), "160000" commit, "120000" symlink
  type: 'blob' | 'tree' | 'commit';
  sha?: string | null;
  content?: string;
}

interface GithubTreeObjResp extends GithubTreeObjReq {
  size?: number;
  url?: string;
}

interface GithubTreeResp {
  sha: string;
  url: string;
  tree: GithubTreeObjResp[];
  truncated: boolean;
}

interface GithubBranchResp {
  name: string;
  commit: { sha: string };
}

interface GithubRepoResp {
  default_branch: string;
}

interface GithubUserResp {
  name: string;
  email: string;
  login: string;
}

interface MessageTemplateVars {
  UserName: string;
  ObjName: string;
  ObjPath: string;
  ParentName: string;
  ParentPath: string;
  TargetName?: string;
  TargetPath?: string;
}

type NewTreeEntry = GithubTreeObjReq | { path: string; mode: string; type: string; content?: string };

// ---------------------------------------------------------------- path helpers

function cleanPath(p: string): string {
  if (!p) return '/';
  const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const trimmed = normalized.replace(/^\/|\/$/g, '');
  return trimmed ? '/' + trimmed : '/';
}

function dirname(p: string): string {
  const cleaned = cleanPath(p);
  if (cleaned === '/') return '/';
  const parts = cleaned.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

function basename(p: string): string {
  const cleaned = cleanPath(p);
  if (cleaned === '/') return '';
  const parts = cleaned.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function joinPath(...parts: string[]): string {
  return cleanPath(parts.join('/'));
}

function renderCommitMessage(
  tmpl: string | undefined,
  vars: MessageTemplateVars,
  defaultOp: string,
): string {
  if (!tmpl || !tmpl.trim()) {
    return `${vars.UserName} ${defaultOp} ${vars.ObjPath}`;
  }
  let msg = tmpl;
  msg = msg.replace(/\{\{\.UserName\}\}/g, vars.UserName || '');
  msg = msg.replace(/\{\{\.ObjName\}\}/g, vars.ObjName || '');
  msg = msg.replace(/\{\{\.ObjPath\}\}/g, vars.ObjPath || '');
  msg = msg.replace(/\{\{\.ParentName\}\}/g, vars.ParentName || '');
  msg = msg.replace(/\{\{\.ParentPath\}\}/g, vars.ParentPath || '');
  msg = msg.replace(/\{\{\.TargetName\}\}/g, vars.TargetName || '');
  msg = msg.replace(/\{\{\.TargetPath\}\}/g, vars.TargetPath || '');
  return msg;
}

/**
 * Example:
 * a = /aaa/bbb/ccc, b = /aaa/b11/ddd/ccc
 * ancestor = /aaa, aChildName = bbb, bChildName = b11, ...
 */
function getPathCommonAncestor(
  a: string,
  b: string,
): {
  ancestor: string;
  aChildName: string;
  bChildName: string;
  aRest: string;
  bRest: string;
} {
  const pathA = cleanPath(a);
  const pathB = cleanPath(b);

  let idx = 1;
  while (idx < pathA.length && idx < pathB.length) {
    if (pathA[idx] !== pathB[idx]) {
      break;
    }
    idx++;
  }

  let aNextIdx = idx;
  while (aNextIdx < pathA.length) {
    if (pathA[aNextIdx] === '/') {
      break;
    }
    aNextIdx++;
  }

  let bNextIdx = idx;
  while (bNextIdx < pathB.length) {
    if (pathB[bNextIdx] === '/') {
      break;
    }
    bNextIdx++;
  }

  while (idx > 0) {
    if (pathA[idx] === '/') {
      break;
    }
    idx--;
  }

  const ancestor = cleanPath(pathA.slice(0, idx));
  const aChildName = pathA.slice(idx + 1, aNextIdx);
  const bChildName = pathB.slice(idx + 1, bNextIdx);
  const aRest = pathA.slice(idx + 1);
  const bRest = pathB.slice(idx + 1);

  return { ancestor, aChildName, bChildName, aRest, bRest };
}

// ---------------------------------------------------------------- misc helpers

/** Base64-encode bytes without Buffer (Workers / browser compatible). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sortItems(items: Obj[], orderBy?: string, orderDirection?: string): Obj[] {
  const asc = orderDirection !== 'desc';
  const key = String(orderBy || 'name').toLowerCase();
  return [...items].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp: number;
    if (key.includes('size')) {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (key.includes('time') || key.includes('modified') || key.includes('created')) {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = String(a.name).localeCompare(String(b.name));
    }
    return asc ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------- api client

class GithubApiClient {
  private cfg: Record<string, any>;
  private token: string;
  private owner: string;
  private repo: string;

  constructor(cfg: Record<string, any>) {
    this.cfg = cfg;
    this.token = String(cfg.token || '').trim();
    this.owner = String(cfg.owner || '').trim();
    this.repo = String(cfg.repo || '').trim();
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github.object+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OpenListNext-Github-Driver',
    };
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(
    url: string,
    options: { method?: string; body?: any; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const reqHeaders: Record<string, string> = {
      ...this.headers,
      ...(options.headers || {}),
    };

    let bodyStr: string | undefined = undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        bodyStr = options.body;
      } else {
        bodyStr = JSON.stringify(options.body);
        if (!reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: reqHeaders,
      body: bodyStr,
    });

    if (!res.ok) {
      let errMsg = `${res.status} ${res.statusText}`;
      try {
        const errJson = (await res.json()) as any;
        if (errJson?.message) {
          errMsg = `${res.status} ${res.statusText}: ${errJson.message}`;
        }
      } catch {
        // keep status-only message
      }
      throw new Error(errMsg);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  getContentApiUrl(path: string): string {
    const clean = cleanPath(path);
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents${clean === '/' ? '' : clean}`;
  }

  async getContents(path: string, ref?: string): Promise<GithubObject> {
    const url = new URL(this.getContentApiUrl(path));
    if (ref) {
      url.searchParams.set('ref', ref);
    }
    return this.request<GithubObject>(url.toString());
  }

  async getRepo(): Promise<GithubRepoResp> {
    return this.request<GithubRepoResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}`,
    );
  }

  async getBranchHead(branch: string): Promise<string> {
    const res = await this.request<GithubBranchResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}`,
    );
    return res.commit.sha;
  }

  // Kept for parity with the reference (user identity for commit messages).
  async getAuthenticatedUser(): Promise<GithubUserResp> {
    return this.request<GithubUserResp>('https://api.github.com/user');
  }

  async getTree(sha: string): Promise<GithubTreeResp> {
    return this.request<GithubTreeResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${sha}`,
    );
  }

  async getTreeDirectly(
    path: string,
    ref?: string,
  ): Promise<{ tree: GithubTreeResp; dirSha: string }> {
    const p = await this.getContents(path, ref);
    if (!p.entries && p.type !== 'dir') {
      throw new Error(`${path} is not a folder`);
    }
    const tree = await this.getTree(p.sha);
    if (tree.truncated) {
      throw new Error(`tree ${path} is truncated`);
    }
    return { tree, dirSha: p.sha };
  }

  async newTree(
    baseSha: string | null | undefined,
    trees: NewTreeEntry[],
  ): Promise<string> {
    const body: Record<string, any> = { tree: trees };
    if (baseSha) {
      body.base_tree = baseSha;
    }
    const res = await this.request<GithubTreeResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: 'POST',
        body,
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    return res.sha;
  }

  async putBlob(content: ArrayBuffer | Uint8Array): Promise<string> {
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    const base64Content = bytesToBase64(bytes);
    const res = await this.request<{ sha: string }>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: 'POST',
        body: {
          encoding: 'base64',
          content: base64Content,
        },
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    return res.sha;
  }

  async createCommit(
    message: string,
    treeSha: string,
    parentCommitSha: string,
    committer?: { name: string; email: string },
    author?: { name: string; email: string },
  ): Promise<string> {
    const body: Record<string, any> = {
      message,
      tree: treeSha,
      parents: [parentCommitSha],
    };
    if (committer?.name) {
      body.committer = {
        name: committer.name,
        email: committer.email,
        date: new Date().toISOString(),
      };
    }
    if (author?.name) {
      body.author = {
        name: author.name,
        email: author.email,
        date: new Date().toISOString(),
      };
    }

    const res = await this.request<{ sha: string }>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: 'POST',
        body,
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    return res.sha;
  }

  async updateRef(branch: string, commitSha: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: 'PATCH',
        body: {
          sha: commitSha,
          force: false,
        },
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
  }

  /**
   * Recursively renew parent trees from path up until `until` directory.
   */
  async renewParentTrees(
    path: string,
    prevSha: string,
    curSha: string,
    until: string,
    ref?: string,
  ): Promise<string> {
    let currentPath = cleanPath(path);
    const targetUntil = cleanPath(until);

    while (currentPath !== targetUntil) {
      currentPath = dirname(currentPath);
      const { tree, dirSha } = await this.getTreeDirectly(currentPath, ref);

      const targetTreeObj = tree.tree.find((t) => t.sha === prevSha);
      if (!targetTreeObj) {
        throw new Error(`Object with sha ${prevSha} not found in ${currentPath}`);
      }

      const newTreeReq: GithubTreeObjReq = {
        path: targetTreeObj.path,
        mode: targetTreeObj.mode,
        type: targetTreeObj.type,
        sha: curSha,
      };

      curSha = await this.newTree(dirSha, [newTreeReq]);
      prevSha = dirSha;
    }
    return curSha;
  }
}

// ---------------------------------------------------------------- driver

export class GithubDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: GithubApiClient = new GithubApiClient({});
  private ref = '';
  private rootFolder = '/';
  private isOnBranch = false;
  private commitLock: Promise<void> = Promise.resolve();

  config(): DriverConfig {
    return githubConfig;
  }

  private async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    const currentLock = this.commitLock;
    let releaseLock: () => void = () => {};
    this.commitLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await currentLock;
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  private formatDownloadUrl(rawUrl: string | null | undefined): string {
    if (!rawUrl) return '';
    const ghProxy = String(this.cfg.gh_proxy || '').trim();
    if (ghProxy) {
      return rawUrl.replace('https://raw.githubusercontent.com', ghProxy);
    }
    return rawUrl;
  }

  // mount-relative path -> repo path (root_folder_path semantics of the reference)
  private toRepoPath(p: string): string {
    const base = this.rootFolder;
    const rel = cleanPath(p);
    if (base === '/') return rel;
    if (rel === '/') return base;
    return cleanPath(`${base}${rel}`);
  }

  private async commitAndPush(message: string, rootTreeSha: string): Promise<void> {
    const branch = this.ref;
    const headCommitSha = await this.client.getBranchHead(branch);

    const committer =
      this.cfg.committer_name && this.cfg.committer_email
        ? { name: this.cfg.committer_name, email: this.cfg.committer_email }
        : undefined;

    const author =
      this.cfg.author_name && this.cfg.author_email
        ? { name: this.cfg.author_name, email: this.cfg.author_email }
        : undefined;

    const newCommitSha = await this.client.createCommit(
      message,
      rootTreeSha,
      headCommitSha,
      committer,
      author,
    );
    await this.client.updateRef(branch, newCommitSha);
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    if (!this.cfg.owner || !this.cfg.repo) {
      throw new Error('github: owner and repo are required');
    }
    this.client = new GithubApiClient(cfg);
    this.rootFolder = cleanPath(String(this.cfg.root_folder_path || '/'));

    if (
      (this.cfg.committer_name && !this.cfg.committer_email) ||
      (!this.cfg.committer_name && this.cfg.committer_email)
    ) {
      throw new Error('committer_name and committer_email must both be set or empty');
    }

    if (
      (this.cfg.author_name && !this.cfg.author_email) ||
      (!this.cfg.author_name && this.cfg.author_email)
    ) {
      throw new Error('author_name and author_email must both be set or empty');
    }

    const ref = String(this.cfg.ref || '').trim();
    if (!ref) {
      const repo = await this.client.getRepo();
      this.ref = repo.default_branch;
      this.isOnBranch = true;
    } else {
      this.ref = ref;
      try {
        await this.client.getBranchHead(ref);
        this.isOnBranch = true;
      } catch {
        this.isOnBranch = false;
      }
    }
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const p = this.toRepoPath(path);
    const obj = await this.client.getContents(p, this.ref);

    if (!obj.entries && obj.type !== 'dir') {
      throw new Error(`${path} is not a folder`);
    }

    const items: Obj[] = [];

    if (obj.entries && obj.entries.length >= 1000) {
      const tree = await this.client.getTree(obj.sha);
      if (tree.truncated) {
        throw new Error(`Tree ${path} is truncated (>100,000 items)`);
      }
      for (const t of tree.tree) {
        if (t.path === '.gitkeep') continue;
        const isDir = t.type === 'tree';
        const tid = t.sha || undefined;
        if (isDir) {
          items.push(createDirObj({
            name: t.path,
            modified: new Date(0).toISOString(),
            id: tid,
          }));
        } else {
          items.push(createFileObj({
            name: t.path,
            size: t.size || 0,
            modified: new Date(0).toISOString(),
            id: tid,
          }));
        }
      }
    } else if (obj.entries) {
      for (const entry of obj.entries) {
        if (entry.name === '.gitkeep') continue;
        const isDir = entry.type === 'dir';
        if (isDir) {
          items.push(createDirObj({
            name: entry.name,
            modified: new Date(0).toISOString(),
            id: entry.sha,
          }));
        } else {
          items.push(createFileObj({
            name: entry.name,
            size: entry.size || 0,
            modified: new Date(0).toISOString(),
            id: entry.sha,
          }));
        }
      }
    }

    const sorted = sortItems(items, this.cfg.order_by, this.cfg.order_direction);
    return { content: sorted, total: sorted.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const p = this.toRepoPath(path);
    const obj = await this.client.getContents(p, this.ref);

    if (obj.type === 'submodule') {
      throw new Error('cannot download a submodule');
    }

    const isDir = obj.type === 'dir' || !!obj.entries;
    const name = obj.name || basename(p) || 'root';
    const common = {
      name,
      size: obj.size || 0,
      modified: new Date(0).toISOString(),
      id: obj.sha,
    };
    return isDir ? createDirObj(common) : createFileObj(common);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const p = this.toRepoPath(path);
    const obj = await this.client.getContents(p, this.ref);

    if (obj.type === 'submodule') {
      throw new Error('cannot download a submodule');
    }
    const isDir = obj.type === 'dir' || !!obj.entries;
    if (isDir) {
      throw new Error(`cannot get a download link for directory: ${path}`);
    }
    const url = this.formatDownloadUrl(obj.download_url);
    if (!url) {
      throw new Error(`no download url for: ${path}`);
    }
    return { url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const p = this.toRepoPath(path);
    const parentPath = dirname(p);
    const dirName = basename(p);

    await this.acquireLock(async () => {
      const parent = await this.client.getContents(parentPath, this.ref);
      if (!parent.entries && parent.type !== 'dir') {
        throw new Error(`${parentPath} is not a folder`);
      }

      // Create new tree with .gitkeep inside sub directory
      const subDirSha = await this.client.newTree('', [
        {
          path: '.gitkeep',
          mode: '100644',
          type: 'blob',
          content: '',
        },
      ]);

      const newTreeEntries: NewTreeEntry[] = [
        {
          path: dirName,
          mode: '040000',
          type: 'tree',
          sha: subDirSha,
        },
      ];

      // If parent only had .gitkeep, remove .gitkeep
      if (parent.entries?.length === 1 && parent.entries[0].name === '.gitkeep') {
        newTreeEntries.push({
          path: '.gitkeep',
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      }

      const newSha = await this.client.newTree(parent.sha, newTreeEntries);
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        parent.sha,
        newSha,
        '/',
        this.ref,
      );

      const commitMessage = renderCommitMessage(
        this.cfg.mkdir_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: dirName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        'mkdir',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const p = this.toRepoPath(path);
    const parentPath = dirname(p);
    const fileName = basename(p);

    await this.acquireLock(async () => {
      const blobSha = await this.client.putBlob(file);
      const parent = await this.client.getContents(parentPath, this.ref);
      if (!parent.entries && parent.type !== 'dir') {
        throw new Error(`${parentPath} is not a folder`);
      }

      const newTreeEntries: NewTreeEntry[] = [
        {
          path: fileName,
          mode: '100644',
          type: 'blob',
          sha: blobSha,
        },
      ];

      // If parent had only .gitkeep, remove .gitkeep
      if (parent.entries?.length === 1 && parent.entries[0].name === '.gitkeep') {
        newTreeEntries.push({
          path: '.gitkeep',
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      }

      const newSha = await this.client.newTree(parent.sha, newTreeEntries);
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        parent.sha,
        newSha,
        '/',
        this.ref,
      );

      const commitMessage = renderCommitMessage(
        this.cfg.put_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: fileName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        'upload',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const p = this.toRepoPath(path);
    const parentPath = dirname(p);
    const oldName = basename(p);

    await this.acquireLock(async () => {
      const { tree, dirSha } = await this.client.getTreeDirectly(parentPath, this.ref);
      const target = tree.tree.find((t) => t.path === oldName);
      if (!target) {
        throw new Error(`Object not found: ${p}`);
      }
      if (target.type === 'commit') {
        throw new Error('cannot rename a submodule');
      }

      const delOld: GithubTreeObjReq = {
        path: oldName,
        mode: target.mode,
        type: target.type,
        sha: null,
      };
      const addNew: GithubTreeObjReq = {
        path: newName,
        mode: target.mode,
        type: target.type,
        sha: target.sha,
      };

      const newSha = await this.client.newTree(dirSha, [delOld, addNew]);
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        dirSha,
        newSha,
        '/',
        this.ref,
      );

      const commitMessage = renderCommitMessage(
        this.cfg.rename_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: oldName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
          TargetName: newName,
          TargetPath: joinPath(parentPath, newName),
        },
        'rename',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const p = this.toRepoPath(path);
    const parentPath = dirname(p);
    const objName = basename(p);

    await this.acquireLock(async () => {
      const { tree, dirSha } = await this.client.getTreeDirectly(parentPath, this.ref);
      const target = tree.tree.find((t) => t.path === objName);
      if (!target) {
        throw new Error(`Object not found: ${p}`);
      }
      if (target.type === 'commit') {
        throw new Error('cannot remove a submodule');
      }

      const treeEntries: NewTreeEntry[] = [
        {
          path: objName,
          mode: target.mode,
          type: target.type,
          sha: null,
        },
      ];

      // If emptying directory, add .gitkeep so folder remains valid
      if (tree.tree.length === 1) {
        treeEntries.push({
          path: '.gitkeep',
          mode: '100644',
          type: 'blob',
          content: '',
        });
      }

      const newSha = await this.client.newTree(dirSha, treeEntries);
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        dirSha,
        newSha,
        '/',
        this.ref,
      );

      const commitMessage = renderCommitMessage(
        this.cfg.delete_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: objName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        'remove',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  // Per-item move: src is the full source path, dst is the full destination
  // path (parent dir = dirname(dst), the target keeps its own name).
  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const srcPath = this.toRepoPath(src);
    const dstDir = this.toRepoPath(dirname(dst));

    if (dstDir.startsWith(srcPath)) {
      throw new Error('cannot move parent dir to child');
    }

    await this.acquireLock(async () => {
      let rootSha = '';
      const srcParentPath = dirname(srcPath);
      const srcObjName = basename(srcPath);

      if (dstDir.startsWith(srcParentPath)) {
        // Case 1: moving to sibling subdirectory (e.g. /aa/1 -> /aa/bb/)
        const { dstOldSha, dstNewSha, ancestorOldSha, srcParentTree } =
          await this.copyWithoutRenewTree(srcPath, dstDir);

        const dstRest = dstDir.slice(srcParentPath.length).replace(/^\//, '');
        const dstNextName = dstRest.split('/')[0];
        const dstNextPath = joinPath(srcParentPath, dstNextName);

        const dstNextTreeSha = await this.client.renewParentTrees(
          dstDir,
          dstOldSha,
          dstNewSha,
          dstNextPath,
          this.ref,
        );

        const delSrc = srcParentTree.tree.find((t) => t.path === srcObjName);
        const dstNextTree = srcParentTree.tree.find((t) => t.path === dstNextName);

        if (!delSrc || !dstNextTree) {
          throw new Error('Object not found during move');
        }

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: delSrc.path,
            mode: delSrc.mode,
            type: delSrc.type,
            sha: null,
          },
          {
            path: dstNextTree.path,
            mode: dstNextTree.mode,
            type: dstNextTree.type,
            sha: dstNextTreeSha,
          },
        ]);

        rootSha = await this.client.renewParentTrees(
          srcParentPath,
          ancestorOldSha,
          ancestorNewSha,
          '/',
          this.ref,
        );
      } else if (srcPath.startsWith(dstDir)) {
        // Case 2: moving to ancestor directory (e.g. /aa/bb/1 -> /aa/)
        const { tree: srcParentTree, dirSha: srcParentOldSha } =
          await this.client.getTreeDirectly(srcParentPath, this.ref);

        const src = srcParentTree.tree.find((t) => t.path === srcObjName);
        if (!src) throw new Error('Object not found');
        if (src.type === 'commit') throw new Error('cannot move a submodule');

        const delSrcTree: NewTreeEntry[] = [
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: null,
          },
        ];
        if (srcParentTree.tree.length === 1) {
          delSrcTree.push({
            path: '.gitkeep',
            mode: '100644',
            type: 'blob',
            content: '',
          });
        }

        const srcParentNewSha = await this.client.newTree(srcParentOldSha, delSrcTree);

        const srcRest = srcPath.slice(dstDir.length).replace(/^\//, '');
        const srcNextName = srcRest.split('/')[0];
        if (!srcNextName) throw new Error('cannot move in place');

        const srcNextPath = joinPath(dstDir, srcNextName);
        const srcNextTreeSha = await this.client.renewParentTrees(
          srcParentPath,
          srcParentOldSha,
          srcParentNewSha,
          srcNextPath,
          this.ref,
        );

        const { tree: ancestorTree, dirSha: ancestorOldSha } =
          await this.client.getTreeDirectly(dstDir, this.ref);

        const srcNextTree = ancestorTree.tree.find((t) => t.path === srcNextName);
        if (!srcNextTree) throw new Error('Object not found');

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: srcNextTree.path,
            mode: srcNextTree.mode,
            type: srcNextTree.type,
            sha: srcNextTreeSha,
          },
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: src.sha,
          },
        ]);

        rootSha = await this.client.renewParentTrees(
          dstDir,
          ancestorOldSha,
          ancestorNewSha,
          '/',
          this.ref,
        );
      } else {
        // Case 3: moving across different branches (e.g. /aa/1 -> /bb/)
        const { dstOldSha, dstNewSha, srcParentOldSha, srcParentTree } =
          await this.copyWithoutRenewTree(srcPath, dstDir);

        const src = srcParentTree.tree.find((t) => t.path === srcObjName);
        if (!src) throw new Error('Object not found');

        const delSrcTree: NewTreeEntry[] = [
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: null,
          },
        ];
        if (srcParentTree.tree.length === 1) {
          delSrcTree.push({
            path: '.gitkeep',
            mode: '100644',
            type: 'blob',
            content: '',
          });
        }

        const srcParentNewSha = await this.client.newTree(srcParentOldSha, delSrcTree);

        const { ancestor, aChildName: srcChildName, bChildName: dstChildName } =
          getPathCommonAncestor(srcPath, dstDir);

        const dstNextTreeSha = await this.client.renewParentTrees(
          dstDir,
          dstOldSha,
          dstNewSha,
          joinPath(ancestor, dstChildName),
          this.ref,
        );

        const srcNextTreeSha = await this.client.renewParentTrees(
          srcParentPath,
          srcParentOldSha,
          srcParentNewSha,
          joinPath(ancestor, srcChildName),
          this.ref,
        );

        const { tree: ancestorTree, dirSha: ancestorOldSha } =
          await this.client.getTreeDirectly(ancestor, this.ref);

        const srcChild = ancestorTree.tree.find((t) => t.path === srcChildName);
        const dstChild = ancestorTree.tree.find((t) => t.path === dstChildName);

        if (!srcChild || !dstChild) {
          throw new Error('Ancestor child tree not found');
        }

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: srcChild.path,
            mode: srcChild.mode,
            type: srcChild.type,
            sha: srcNextTreeSha,
          },
          {
            path: dstChild.path,
            mode: dstChild.mode,
            type: dstChild.type,
            sha: dstNextTreeSha,
          },
        ]);

        rootSha = await this.client.renewParentTrees(
          ancestor,
          ancestorOldSha,
          ancestorNewSha,
          '/',
          this.ref,
        );
      }

      const commitMessage = renderCommitMessage(
        this.cfg.move_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: srcObjName,
          ObjPath: srcPath,
          ParentName: basename(srcParentPath),
          ParentPath: srcParentPath,
          TargetName: basename(dstDir),
          TargetPath: dstDir,
        },
        'move',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  // Per-item copy: src is the full source path, dst is the full destination
  // path; the item is copied into dirname(dst) under its own name.
  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error('cannot write to non-branch reference');
    }

    const srcPath = this.toRepoPath(src);
    const dstDir = this.toRepoPath(dirname(dst));

    if (dstDir.startsWith(srcPath)) {
      throw new Error('cannot copy parent dir to child');
    }

    await this.acquireLock(async () => {
      const { dstOldSha, dstNewSha } = await this.copyWithoutRenewTree(srcPath, dstDir);
      const rootSha = await this.client.renewParentTrees(
        dstDir,
        dstOldSha,
        dstNewSha,
        '/',
        this.ref,
      );

      const commitMessage = renderCommitMessage(
        this.cfg.copy_commit_message,
        {
          UserName: 'OpenListNext',
          ObjName: basename(srcPath),
          ObjPath: srcPath,
          ParentName: basename(dirname(srcPath)),
          ParentPath: dirname(srcPath),
          TargetName: basename(dstDir),
          TargetPath: dstDir,
        },
        'copy',
      );

      await this.commitAndPush(commitMessage, rootSha);
    });
  }

  private async copyWithoutRenewTree(
    srcPath: string,
    dstPath: string,
  ): Promise<{
    dstOldSha: string;
    dstNewSha: string;
    srcParentOldSha: string;
    srcParentTree: GithubTreeResp;
    ancestorOldSha: string;
  }> {
    const dst = await this.client.getContents(dstPath, this.ref);
    if (!dst.entries && dst.type !== 'dir') {
      throw new Error(`${dstPath} is not a folder`);
    }

    const srcParentPath = dirname(srcPath);
    const srcObjName = basename(srcPath);
    const { tree: srcParentTree, dirSha: srcParentOldSha } =
      await this.client.getTreeDirectly(srcParentPath, this.ref);

    const src = srcParentTree.tree.find((t) => t.path === srcObjName);
    if (!src) {
      throw new Error(`Object not found: ${srcPath}`);
    }
    if (src.type === 'commit') {
      throw new Error('cannot copy a submodule');
    }

    const newTreeEntries: NewTreeEntry[] = [
      {
        path: src.path,
        mode: src.mode,
        type: src.type,
        sha: src.sha,
      },
    ];

    // If destination only had .gitkeep, remove .gitkeep
    if (dst.entries?.length === 1 && dst.entries[0].name === '.gitkeep') {
      newTreeEntries.push({
        path: '.gitkeep',
        mode: '100644',
        type: 'blob',
        sha: null,
      });
    }

    const dstNewSha = await this.client.newTree(dst.sha, newTreeEntries);

    return {
      dstOldSha: dst.sha,
      dstNewSha,
      srcParentOldSha,
      srcParentTree,
      ancestorOldSha: srcParentOldSha,
    };
  }
}

registerDriver(GithubDriver, githubConfig, githubAdditional);
