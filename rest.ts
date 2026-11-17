// rest.ts — the GitHub REST v3 surface at /api/v3.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id; unknown routes
// answer JSON 404 and malformed bodies JSON 400. Authentication is one bearer
// token (MAKEFUN_SHOP_TOKEN when set): no token is 401, and a repository
// under any owner other than the token owner is 404, never 403.
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  DEFAULT_BRANCH,
  ZERO_OID,
  buildCommit,
  buildTree,
  parseCommit,
  globalId,
  type Forge,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

function json(forge: Forge, status: number, value: unknown, extra: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { ...JSON_HEADERS, 'x-github-request-id': forge.nextRequestId(), ...extra },
    body: JSON.stringify(value),
  };
}

function err(forge: Forge, status: number, message: string): RestResponse {
  return json(forge, status, { message });
}

function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (req.rawBody.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(req.rawBody.toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    has_issues: true,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- git writes

/** Recursively set (or delete, when blobOid is null) one path in a tree. */
export function updateTree(repo: Repo, baseTreeOid: string | null, parts: string[], blobOid: string | null): string {
  const entries = baseTreeOid === null ? [] : (repo.treeOf(baseTreeOid) ?? []);
  const [head, ...rest] = parts;
  const out = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) out.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const child = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = updateTree(repo, child?.oid ?? null, rest, blobOid);
    const childEntries = repo.treeOf(childOid);
    if (childEntries !== null && childEntries.length > 0) {
      out.push({ mode: '40000', name: head, oid: childOid });
    }
  }
  return repo.putObject('tree', buildTree(out));
}

/** Build a tree from a flat path map (used by squash merges). */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  const build = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Set<string>();
    for (const [path, value] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: value.mode, name: rest, oid: value.oid });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of dirs) {
      entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    }
    return repo.putObject('tree', buildTree(entries));
  };
  return build('');
}

/** Create a commit on a branch from a tree oid. Returns the commit oid. */
export function commitOnBranch(
  forge: Forge,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const tip = repo.refOfBranch(branch);
  const identity = forge.identity();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const oid = repo.putObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedAt = forge.now().iso;
  return oid;
}

/** Write (or delete) one file through the contents API's commit. */
export function commitFile(
  forge: Forge,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const tip = repo.refOfBranch(branch);
  const baseTree = tip === null ? null : (repo.commitOf(tip)?.tree ?? null);
  let blobSha: string | null = null;
  if (content !== null) blobSha = repo.putObject('blob', content);
  const treeOid = updateTree(repo, baseTree, path.split('/'), blobSha);
  const commitSha = commitOnBranch(forge, repo, branch, treeOid, message);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- merge logic (shared with GraphQL)

export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refOfBranch(pull.headRef);
  const baseTip = repo.refOfBranch(pull.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const base = repo.mergeBase(headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  return mergeConflict(repo, base, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

/** True when the head and the base both changed a path differently since the merge-base. */
export function mergeConflict(repo: Repo, mergeBaseOid: string, headTip: string, baseTip: string): boolean {
  const baseView = repo.commitOf(mergeBaseOid);
  const headView = repo.commitOf(headTip);
  const baseTipView = repo.commitOf(baseTip);
  if (baseView === null || headView === null || baseTipView === null) return true;
  const ancestor = repo.flatTree(baseView.tree);
  const head = repo.flatTree(headView.tree);
  const current = repo.flatTree(baseTipView.tree);
  const paths = new Set<string>([...ancestor.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path)?.oid;
    const h = head.get(path)?.oid;
    const c = current.get(path)?.oid;
    const headChanged = h !== a;
    const baseChanged = c !== a;
    if (headChanged && baseChanged && h !== c) return true;
  }
  return false;
}

/** Squash-merge an open pull request onto its base branch. */
export function squashMerge(
  forge: Forge,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull request has already been merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  const headTip = repo.refOfBranch(pull.headRef);
  const baseTip = repo.refOfBranch(pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, status: 422, message: 'Head or base branch not found' };
  const base = repo.mergeBase(headTip, baseTip);
  if (base === null) return { ok: false, status: 405, message: 'No merge base' };
  if (mergeConflict(repo, base, headTip, baseTip)) {
    return { ok: false, status: 405, message: 'Merge conflict' };
  }
  const baseView = repo.commitOf(base)!;
  const headView = repo.commitOf(headTip)!;
  const baseTipView = repo.commitOf(baseTip)!;
  const merged = repo.flatTree(baseTipView.tree);
  const ancestor = repo.flatTree(baseView.tree);
  const head = repo.flatTree(headView.tree);
  const paths = new Set<string>([...ancestor.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const h = head.get(path);
    if (h === undefined) merged.delete(path);
    else if (a === undefined || a.oid !== h.oid) merged.set(path, h);
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const { iso } = forge.now();
  const sha = commitOnBranch(forge, repo, pull.baseRef, treeOid, `Merge pull request #${pull.number} — ${pull.title}`);
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.headSha = headTip;
  pull.baseSha = sha;
  pull.updatedAt = iso;
  return { ok: true, sha };
}

// ---------------------------------------------------------------- pagination

function paginate<T>(req: RestRequest, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(req.baseUrl);
    url.pathname = req.pathname;
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------- the router

export function handleRest(forge: Forge, req: RestRequest, token: string): RestResponse {
  const seg = req.pathname.split('/').filter((part) => part !== '');
  // All /api/v3 routes need a bearer token.
  const auth = req.headers.authorization ?? req.headers.Authorization;
  const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (presented === '' || (token !== '' && presented !== token)) {
    return err(forge, 401, 'Requires authentication');
  }
  if (seg[0] !== 'api' || seg[1] !== 'v3') return err(forge, 404, 'Not Found');

  // GET /api/v3/ — root.
  if (seg.length === 2) {
    if (req.method !== 'GET') return err(forge, 404, 'Not Found');
    return json(forge, 200, {
      current_user_url: `${req.baseUrl}/api/v3/user`,
      rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[2] === 'meta') {
    if (req.method !== 'GET') return err(forge, 404, 'Not Found');
    return json(forge, 200, { installed_version: '1.0.0' });
  }
  if (seg[2] === 'user' && seg.length === 3) {
    if (req.method === 'GET') {
      return json(forge, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
      });
    }
    return err(forge, 404, 'Not Found');
  }
  if (seg[2] === 'user' && seg[3] === 'repos') {
    if (req.method === 'GET') {
      const { page, link } = paginate(req, forge.listRepos());
      const extra: Record<string, string> = link === null ? {} : { link };
      return json(forge, 200, page.map(repoJson), extra);
    }
    if (req.method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return err(forge, 422, 'Invalid repository name');
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return err(forge, 422, 'Repository already exists');
      }
      const repo = forge.createRepo(
        name,
        asBool(parsed.value.private, false),
        asString(parsed.value.description),
      );
      return json(forge, 201, repoJson(repo));
    }
    return err(forge, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodeURIComponent(seg[3]);
    const name = decodeURIComponent(seg[4]);
    const rest = seg.slice(5);
    // A repository under any other owner is 404 for this token, never 403.
    if (owner !== VIEWER_LOGIN) return err(forge, 404, 'Not Found');
    const repo = forge.getRepo(owner, name);
    if (rest.length === 0) {
      if (repo === undefined) return err(forge, 404, 'Not Found');
      if (req.method === 'GET') return json(forge, 200, repoJson(repo));
      if (req.method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        repo.updatedAt = forge.now().iso;
        return json(forge, 200, repoJson(repo));
      }
      if (req.method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, headers: { 'x-github-request-id': forge.nextRequestId() }, body: '' };
      }
      return err(forge, 404, 'Not Found');
    }
    if (repo === undefined) return err(forge, 404, 'Not Found');
    return handleRepoSub(forge, req, repo, rest, token);
  }
  return err(forge, 404, 'Not Found');
}

function handleRepoSub(
  forge: Forge,
  req: RestRequest,
  repo: Repo,
  rest: string[],
  _token: string,
): RestResponse {
  const [first, second, ...tail] = rest;

  // --- branches -----------------------------------------------------------
  if (first === 'branches') {
    if (second === undefined) {
      if (req.method !== 'GET') return err(forge, 404, 'Not Found');
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) },
          protected: false,
        }));
      return json(forge, 200, list);
    }
    if (req.method === 'GET' && tail.length === 0) {
      const sha = repo.refOfBranch(decodeURIComponent(second));
      if (sha === null) return err(forge, 404, 'Not Found');
      return json(forge, 200, { name: decodeURIComponent(second), commit: { sha }, protected: false });
    }
    return err(forge, 404, 'Not Found');
  }

  // --- commits ------------------------------------------------------------
  if (first === 'commits') {
    if (req.method !== 'GET' || second !== undefined) return err(forge, 404, 'Not Found');
    const shaParam = req.query.get('sha');
    let tip: string | null = null;
    if (shaParam !== null && shaParam !== '') {
      tip = repo.refOfBranch(shaParam) ?? (isSha(shaParam) ? shaParam : null);
    } else {
      tip = repo.refOfBranch(repo.defaultBranch);
    }
    if (tip === null) return json(forge, 200, []);
    const list = repo.commitList(tip).map((oid) => {
      const view = repo.commitOf(oid)!;
      return {
        sha: oid,
        commit: {
          // Git stores the message with a trailing newline; the API returns
          // it without.
          message: view.message.replace(/\n+$/, ''),
          author: parseIdentity(view.author),
          committer: parseIdentity(view.committer),
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
      };
    });
    return json(forge, 200, list);
  }

  // --- git data -----------------------------------------------------------
  if (first === 'git' && second === 'refs') {
    if (req.method === 'POST' && tail.length === 0) {
      const parsed = parseBody(req);
      if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref.startsWith('refs/heads/') || !isSha(sha)) return err(forge, 422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(forge, 422, 'Reference already exists');
      if (repo.getObject(sha) === undefined) return err(forge, 422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return json(forge, 201, { ref, object: { sha, type: 'commit' } });
    }
    if (req.method === 'GET' && tail.length === 2 && tail[0] === 'heads') {
      const branch = decodeURIComponent(tail[1]);
      const sha = repo.refOfBranch(branch);
      if (sha === null) return err(forge, 404, 'Not Found');
      return json(forge, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return err(forge, 404, 'Not Found');
  }

  // --- contents -----------------------------------------------------------
  if (first === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    return handleContents(forge, req, repo, path);
  }

  // --- labels -------------------------------------------------------------
  if (first === 'labels') {
    if (req.method === 'GET' && second === undefined) {
      return json(forge, 200, [...repo.labels.values()]);
    }
    if (req.method === 'POST' && second === undefined) {
      const parsed = parseBody(req);
      if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (name === '') return err(forge, 422, 'Invalid label name');
      const label = { name, color: asString(parsed.value.color) || 'ededed' };
      repo.labels.set(name, label);
      return json(forge, 201, label);
    }
    return err(forge, 404, 'Not Found');
  }

  // --- issues -------------------------------------------------------------
  if (first === 'issues') {
    if (second === undefined) {
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        const direction = req.query.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return json(forge, 200, list.map((issue) => issueJson(repo, issue)));
      }
      if (req.method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
        const title = asString(parsed.value.title);
        if (title === '') return err(forge, 422, 'Invalid title');
        const labels = Array.isArray(parsed.value.labels)
          ? (parsed.value.labels as unknown[]).map(String)
          : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(forge, 422, `Label "${label}" does not exist`);
        }
        const issue = createIssue(forge, repo, title, asString(parsed.value.body), labels);
        return json(forge, 201, issueJson(repo, issue));
      }
      return err(forge, 404, 'Not Found');
    }
    const number = parseInt(second, 10);
    if (Number.isNaN(number)) return err(forge, 404, 'Not Found');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) return err(forge, 404, 'Not Found');
    if (tail.length === 0) {
      if (req.method === 'GET') return json(forge, 200, issueJson(repo, issue));
      if (req.method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        issue.updatedAt = forge.now().iso;
        return json(forge, 200, issueJson(repo, issue));
      }
      return err(forge, 404, 'Not Found');
    }
    if (tail[0] === 'comments' && tail.length === 1) {
      if (req.method === 'GET') {
        return json(forge, 200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: globalId('IssueComment', String(comment.id)),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        })));
      }
      if (req.method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
        const body = asString(parsed.value.body);
        if (body === '') return err(forge, 422, 'Invalid body');
        const { iso } = forge.now();
        const comment = { id: forge.commentIdSeq, body, createdAt: iso };
        forge.commentIdSeq += 1;
        issue.comments.push(comment);
        return json(forge, 201, {
          id: comment.id,
          node_id: globalId('IssueComment', String(comment.id)),
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        });
      }
      return err(forge, 404, 'Not Found');
    }
    return err(forge, 404, 'Not Found');
  }

  // --- pulls --------------------------------------------------------------
  if (first === 'pulls') {
    if (second === undefined) {
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.seq - a.seq);
        return json(forge, 200, list.map((pull) => pullJson(repo, pull)));
      }
      if (req.method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
        const head = asString(parsed.value.head);
        const base = asString(parsed.value.base);
        const headSha = repo.refOfBranch(head);
        const baseSha = repo.refOfBranch(base);
        if (headSha === null || baseSha === null) return err(forge, 422, 'Head or base branch not found');
        const pull = createPull(
          forge,
          repo,
          asString(parsed.value.title),
          asString(parsed.value.body),
          head,
          base,
          headSha,
          baseSha,
        );
        return json(forge, 201, pullJson(repo, pull));
      }
      return err(forge, 404, 'Not Found');
    }
    const number = parseInt(second, 10);
    if (Number.isNaN(number)) return err(forge, 404, 'Not Found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return err(forge, 404, 'Not Found');
    if (tail.length === 0) {
      if (req.method === 'GET') {
        // Refresh head/base shas from the live branches.
        pull.headSha = repo.refOfBranch(pull.headRef) ?? pull.headSha;
        pull.baseSha = repo.refOfBranch(pull.baseRef) ?? pull.baseSha;
        return json(forge, 200, pullJson(repo, pull));
      }
      return err(forge, 404, 'Not Found');
    }
    if (tail[0] === 'files' && tail.length === 1) {
      if (req.method !== 'GET') return err(forge, 404, 'Not Found');
      const headTip = repo.refOfBranch(pull.headRef) ?? pull.headSha;
      const baseTip = repo.refOfBranch(pull.baseRef) ?? pull.baseSha;
      const mergeBaseOid = repo.mergeBase(headTip, baseTip);
      const baseTree = mergeBaseOid === null ? null : (repo.commitOf(mergeBaseOid)?.tree ?? null);
      const headTree = repo.commitOf(headTip)?.tree ?? null;
      const changes = repo.diffTrees(baseTree, headTree);
      return json(forge, 200, changes.map((change) => ({
        filename: change.path,
        status: change.status === 'removed' ? 'removed' : change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      })));
    }
    if (tail[0] === 'merge' && tail.length === 1) {
      if (req.method !== 'PUT') return err(forge, 404, 'Not Found');
      const parsed = parseBody(req);
      if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
      const method = asString(parsed.value.merge_method) || 'squash';
      if (method !== 'squash') return err(forge, 422, 'Only squash merges are supported');
      const result = squashMerge(forge, repo, pull);
      if (!result.ok) return err(forge, result.status, result.message);
      return json(forge, 200, {
        merged: true,
        sha: result.sha,
        message: `Merge pull request #${pull.number}`,
      });
    }
    return err(forge, 404, 'Not Found');
  }

  return err(forge, 404, 'Not Found');
}

function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1],
    email: match[2],
    date: new Date(parseInt(match[3], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function createIssue(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): Issue {
  const { iso } = forge.now();
  repo.counter += 1;
  repo.seq += 1;
  const issue: Issue = {
    id: forge.issueIdSeq,
    number: repo.counter,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: repo.seq,
    createdAt: iso,
    updatedAt: iso,
    comments: [],
  };
  forge.issueIdSeq += 1;
  repo.issues.push(issue);
  return issue;
}

export function createPull(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
  headSha: string,
  baseSha: string,
): Pull {
  const { iso } = forge.now();
  repo.counter += 1;
  repo.seq += 1;
  const pull: Pull = {
    id: forge.issueIdSeq,
    number: repo.counter,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: repo.seq,
    createdAt: iso,
    updatedAt: iso,
  };
  forge.issueIdSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

// ---------------------------------------------------------------- contents

function handleContents(forge: Forge, req: RestRequest, repo: Repo, path: string): RestResponse {
  if (path === '') return err(forge, 404, 'Not Found');
  const refParam = req.query.get('ref');
  const branch = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;
  if (req.method === 'GET') {
    const tip = repo.refOfBranch(branch);
    if (tip === null) return err(forge, 404, 'Not Found');
    const view = repo.commitOf(tip);
    if (view === null) return err(forge, 404, 'Not Found');
    const flat = repo.flatTree(view.tree);
    const file = flat.get(path);
    if (file !== undefined) {
      const content = repo.blobText(file.oid);
      return json(forge, 200, {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha: file.oid,
        size: Buffer.byteLength(content, 'utf8'),
        name: path.split('/').pop(),
        path,
      });
    }
    // Directory: entries directly under path.
    const prefix = `${path}/`;
    const entries: Array<{ type: string; name: string; path: string; sha: string }> = [];
    const seen = new Set<string>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          seen.add(dir);
          entries.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: '' });
        }
      }
    }
    if (entries.length === 0) return err(forge, 404, 'Not Found');
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return json(forge, 200, entries);
  }
  if (req.method === 'PUT') {
    const parsed = parseBody(req);
    if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
    const message = asString(parsed.value.message);
    const contentB64 = asString(parsed.value.content);
    if (message === '' || contentB64 === '') return err(forge, 422, 'Invalid message or content');
    const putBranch = asString(parsed.value.branch) || repo.defaultBranch;
    let branchTip = repo.refOfBranch(putBranch);
    if (branchTip === null) {
      // A write on a branch that does not exist yet starts it at the default
      // branch tip (the MCP setup's fallback path for creating a branch).
      const defaultTip = repo.refOfBranch(repo.defaultBranch);
      if (defaultTip === null) {
        // Unborn repository: the write creates the first commit.
        branchTip = null;
      } else {
        repo.refs.set(`refs/heads/${putBranch}`, defaultTip);
        branchTip = defaultTip;
      }
    }
    const content = Buffer.from(contentB64, 'base64');
    const tipView = branchTip === null ? null : repo.commitOf(branchTip);
    const flat = tipView === null ? new Map() : repo.flatTree(tipView.tree);
    const existing = flat.get(path);
    const shaParam = asString(parsed.value.sha);
    if (existing !== undefined) {
      if (shaParam === '') return err(forge, 409, 'sha is required to update a file');
      if (shaParam !== existing.oid) return err(forge, 409, 'sha does not match the current blob');
      const { commitSha, blobSha } = commitFile(forge, repo, putBranch, path, content, message);
      return json(forge, 200, {
        content: { sha: blobSha, encoding: 'base64', name: path.split('/').pop(), path },
        commit: { sha: commitSha },
      });
    }
    const { commitSha, blobSha } = commitFile(forge, repo, putBranch, path, content, message);
    return json(forge, 201, {
      content: { sha: blobSha, encoding: 'base64', name: path.split('/').pop(), path },
      commit: { sha: commitSha },
    });
  }
  if (req.method === 'DELETE') {
    const parsed = parseBody(req);
    if (!parsed.ok) return err(forge, 400, 'Problems parsing JSON');
    const message = asString(parsed.value.message);
    const shaParam = asString(parsed.value.sha);
    const tip = repo.refOfBranch(branch);
    if (tip === null) return err(forge, 404, 'Not Found');
    const view = repo.commitOf(tip);
    if (view === null) return err(forge, 404, 'Not Found');
    const flat = repo.flatTree(view.tree);
    const existing = flat.get(path);
    if (existing === undefined) return err(forge, 404, 'Not Found');
    if (shaParam !== '' && shaParam !== existing.oid) return err(forge, 409, 'sha does not match the current blob');
    const { commitSha } = commitFile(forge, repo, branch, path, null, message === '' ? 'Delete file' : message);
    return json(forge, 200, { commit: { sha: commitSha } });
  }
  return err(forge, 404, 'Not Found');
}
