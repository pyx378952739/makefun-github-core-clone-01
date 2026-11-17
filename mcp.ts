// mcp.ts — the Model Context Protocol endpoint at /mcp (Streamable HTTP,
// JSON-RPC 2.0), speaking the modern 2026-07-28 era: server/discover first,
// every request declaring its revision in _meta, no handshake, no session.
// The legacy initialize handshake is answered too, so a pre-discover client
// can still connect.
//
// Six tools, named after github-mcp-server: create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request. Each
// tool's inputSchema only requires what the suite can fill (see
// checks-mcp.ts's argument mapping): anything else required would fail the
// check with the property named. Tool results carry both a text JSON block and
// structuredContent, so the suite reads them either way.
//
// Authentication: no Authorization header is a 401 on every method. A body
// that is not JSON is HTTP 400 with JSON-RPC -32700. An unknown tool is
// JSON-RPC -32602, never HTTP 500. Missing required arguments are isError:true.
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  globalId,
  type Forge,
  type Repo,
} from './store.ts';
import { createIssue, createPull, pullJson, repoJson, issueJson, squashMerge } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const SERVER_NAME = 'makefun-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): Array<Record<string, unknown>> {
  // Fixed order and fixed content: two tools/list answers must be identical.
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner === '' || repo === '') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, repo) ?? null;
}

function callTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { ok: false, error: `unknown tool ${name}` };
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return { ok: false, error: `missing required arguments: ${missing.join(', ')}` };

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      const existing = forge.getRepo(VIEWER_LOGIN, repoName);
      if (existing !== undefined) {
        return { ok: true, value: repoJson(existing) };
      }
      const repo = forge.createRepo(
        repoName,
        args.private === true,
        asString(args.description),
      );
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const issue = createIssue(forge, repo, asString(args.title), asString(args.body), []);
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const state = asString(args.state) || 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return {
        ok: true,
        value: { issues: list.map((issue) => issueJson(repo, issue)) },
      };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const head = asString(args.head);
      const base = asString(args.base);
      const headSha = repo.refOfBranch(head);
      const baseSha = repo.refOfBranch(base);
      if (headSha === null || baseSha === null) return { ok: false, error: 'head or base branch not found' };
      const pull = createPull(forge, repo, asString(args.title), asString(args.body), head, base, headSha, baseSha);
      return { ok: true, value: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const number = asNumber(args.pull_number);
      if (number === null) return { ok: false, error: 'invalid pull_number' };
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { ok: false, error: 'pull request not found' };
      const result = squashMerge(forge, repo, pull);
      if (!result.ok) return { ok: false, error: result.message };
      return { ok: true, value: pullJson(repo, pull) };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

export interface McpResponse {
  status: number;
  body: string;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/** POST /mcp. `authorized` is false when no (or a wrong) bearer token was sent. */
export function handleMcp(forge: Forge, rawBody: Buffer, authorized: boolean): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';

  // Notifications (no id) need no answer.
  if (req.id === undefined) {
    return { status: 202, body: '' };
  }
  if (!authorized) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [MCP_REVISION, '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: toolsList() });
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) {
      return rpcError(id, -32602, `unknown tool ${name}`);
    }
    const tool = TOOLS.find((entry) => entry.name === name)!;
    const missing = missingArgs(tool, args);
    if (missing.length > 0) {
      return rpcResult(id, toolError(`missing required arguments: ${missing.join(', ')}`));
    }
    const result = callTool(forge, name, args);
    if (!result.ok) return rpcResult(id, toolError(result.error));
    return rpcResult(id, toolResult(result.value));
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export { VIEWER_ID };
