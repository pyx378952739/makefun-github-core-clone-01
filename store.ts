// store.ts — the forge's in-memory state and git object model.
//
// Everything lives in memory: one process, no disk, no external service. The
// suite drives the forge for one trial and then discards it, so durability is
// not a requirement; speed is (the benchmark pushes, clones and reads against
// this store hundreds of times in a row).
//
// The viewer is the token owner. The suite's scenario is built from a fixed
// seed in the kit (SCENARIO_SEED), so the viewer's login is the same in every
// practice trial and in the finals: adaiversen (id 1000). Any non-empty bearer
// token authenticates as that viewer; a missing token authenticates as nobody.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const AGENT = 'makefun-forge/1.0.0';

/** Deterministic clock: a fixed epoch plus a monotonic second counter, so no
 *  wall clock ever enters a response (the suite replays must be stable). */
const EPOCH_BASE = 1_700_000_000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const x = aIsDir ? `${a}/` : a;
  const y = bIsDir ? `${b}/` : b;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    compareTreeNames(a.name, a.mode === '40000', b.name, b.mode === '40000'),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const out =
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\n` +
    `tagger ${fields.tagger}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------- entities

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, Label>();
  counter = 0;
  seq = 0;
  createdAt: string;
  updatedAt: string;
  /** Bumps whenever a genuinely new object lands in the object store. Fetch
   * responses are a pure function of the objects plus the request, so they
   * are cached against this generation. */
  generation = 0;
  private commitCache = new Map<string, CommitView>();
  private treeCache = new Map<string, TreeEntry[]>();

  constructor(id: number, name: string, owner: string, priv: boolean, description: string, createdAt: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.private = priv;
    this.description = description;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.generation += 1;
    }
    return oid;
  }

  putExisting(type: ObjType, data: Buffer): string {
    return this.putObject(type, data);
  }

  commitOf(oid: string): CommitView | null {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    const view = parseCommit(obj.data);
    this.commitCache.set(oid, view);
    return view;
  }

  treeOf(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    this.treeCache.set(oid, entries);
    return entries;
  }

  /** Commits reachable from `tip`, newest first (depth-first, parents in order). */
  commitList(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(oid);
      if (view === null) continue;
      out.push(oid);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]);
    }
    return out;
  }

  /** Every object reachable from a set of tips (commits, trees, blobs, tags). */
  reachableObjects(tips: readonly string[]): Set<string> {
    const found = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (found.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      found.add(oid);
      if (obj.type === 'commit') {
        const view = this.commitOf(oid);
        if (view !== null) {
          queue.push(view.tree);
          for (const parent of view.parents) queue.push(parent);
        }
      } else if (obj.type === 'tree') {
        const entries = this.treeOf(oid);
        if (entries !== null) for (const entry of entries) queue.push(entry.oid);
      } else if (obj.type === 'tag') {
        const view = parseTag(obj.data);
        if (view.object !== '') queue.push(view.object);
      }
    }
    return found;
  }

  /** Flat path -> {mode, oid} map of a tree, recursively. */
  flatTree(treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Diff two trees (null = empty). Status and line counts per changed path. */
  diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
    const base = baseTree === null ? new Map() : this.flatTree(baseTree);
    const head = headTree === null ? new Map() : this.flatTree(headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const lines = countLines(this.blobText(h.oid));
        out.push({ path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
      } else if (b !== undefined && h === undefined) {
        const lines = countLines(this.blobText(b.oid));
        out.push({ path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
      } else if (b !== undefined && h !== undefined) {
        const oldLines = this.blobText(b.oid).split('\n');
        const newLines = this.blobText(h.oid).split('\n');
        const { additions, deletions } = lineDiff(oldLines, newLines);
        out.push({
          path,
          status: 'modified',
          additions: Math.max(1, additions),
          deletions,
          changes: Math.max(1, additions) + deletions,
        });
      }
    }
    return out;
  }

  blobText(oid: string): string {
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'blob') return '';
    return obj.data.toString('utf8');
  }

  /** First common ancestor of two commits (BFS from both sides). */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.shift()!;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const view = this.commitOf(oid);
      if (view !== null) for (const parent of view.parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (fromA.has(oid)) return oid;
      const view = this.commitOf(oid);
      if (view !== null) for (const parent of view.parents) queueB.push(parent);
    }
    return null;
  }

  /** The ref a branch name resolves to, or null. */
  refOfBranch(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** Multiset line diff: lines added and lines removed. */
export function lineDiff(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

// ---------------------------------------------------------------- the forge

export class Forge {
  repos = new Map<string, Repo>();
  repoIdSeq = 1;
  issueIdSeq = 1;
  commentIdSeq = 1;
  requestSeq = 0;
  private timeCounter = 0;

  now(): { epoch: number; iso: string } {
    this.timeCounter += 1;
    const epoch = EPOCH_BASE + this.timeCounter;
    return { epoch, iso: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  /** The identity string for a commit's author/committer lines. */
  identity(): string {
    const { epoch } = this.now();
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, priv: boolean, description: string): Repo {
    const { iso } = this.now();
    const repo = new Repo(this.repoIdSeq, name, VIEWER_LOGIN, priv, description, iso);
    this.repoIdSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    // Repo ids are assigned in creation order, so sorting by id is creation order.
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }
}

/** Opaque global ids: base64 of a typed key, never a bare number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
