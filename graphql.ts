// graphql.ts — a small GraphQL executor for the v4 surface at /api/graphql.
//
// It covers exactly the document shapes the suite sends (see
// sdk/conformance/checks-graphql.ts: viewer/repository lookups, issue and pull
// request connections with cursor pagination, the five mutations, node(id:),
// __type introspection, and batched operations), plus the unknown-field error
// contract: HTTP 200 with an errors array whose message names the field.
// No token is a 401; the token owner is the viewer.
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  parseGlobalId,
  globalId,
  type Forge,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import {
  createIssue,
  createPull,
  pullMergeable,
  squashMerge,
} from './rest.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<[string, Value]>;
  selection: FieldNode[] | null;
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selection: FieldNode[];
}

class ParseError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]=$'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num !== null) {
      tokens.push(num[0]);
      i += num[0].length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '{' && maybeName !== '(') {
      name = this.next();
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const dollar = this.next();
        if (dollar !== '$') throw new ParseError('expected $ in variable definition');
        const varName = this.next();
        this.expect(':');
        let type = '';
        while (this.peek() !== ')' && this.peek() !== '$') {
          const part = this.next();
          if (part === ',' ) continue;
          type += part;
        }
        variables.push({ name: varName, type });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selection, fragmentType };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<[string, Value]> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selection: FieldNode[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection, fragmentType: null };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.push([key, this.parseValue()]);
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: parseFloat(token) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'];
const PULL_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'updatedAt'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'USER', 'REPOSITORY'];

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: REPO_FIELDS,
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'pageInfo', 'totalCount'],
  File: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  __Type: ['name', 'fields', 'enumValues', 'kind'],
  SearchType: ['name', 'enumValues', 'kind'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
}

type AnyObj =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'User' }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; total: number; endCursor: string | null; hasNext: boolean }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; total: number; endCursor: string | null; hasNext: boolean }
  | { __type: 'FileConnection'; files: Array<{ __type: 'File'; path: string }>; total: number; endCursor: string | null; hasNext: boolean }
  | { __type: 'File'; path: string }
  | { __type: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: '__Type'; name: string };

class GraphQLError extends Error {}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return -1;
    return parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

function pageOf<T>(items: T[], first: number | undefined, after: string | null | undefined): {
  slice: T[];
  hasNext: boolean;
  endCursor: string | null;
} {
  const start = decodeCursor(after) + 1;
  const limit = first === undefined ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + limit);
  const hasNext = start + limit < items.length;
  const endCursor = slice.length === 0 ? null : encodeCursor(start + slice.length - 1);
  return { slice, hasNext, endCursor };
}

function findRepo(ctx: Ctx, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function decodeId(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string') return null;
  return parseGlobalId(id);
}

function repoFromId(ctx: Ctx, id: unknown): Repo | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = parseInt(decoded.key, 10);
  if (Number.isNaN(repoId)) return null;
  for (const repo of ctx.forge.listRepos()) if (repo.id === repoId) return repo;
  return null;
}

function issueFromId(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repoId = parseInt(repoIdText, 10);
  const number = parseInt(numberText, 10);
  if (Number.isNaN(repoId) || Number.isNaN(number)) return null;
  for (const repo of ctx.forge.listRepos()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function pullFromId(ctx: Ctx, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [repoIdText, numberText] = decoded.key.split(':');
  const repoId = parseInt(repoIdText, 10);
  const number = parseInt(numberText, 10);
  if (Number.isNaN(repoId) || Number.isNaN(number)) return null;
  for (const repo of ctx.forge.listRepos()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function resolveField(ctx: Ctx, obj: AnyObj, field: FieldNode): unknown {
  const args = argsOf(field, ctx.variables);
  switch (obj.__type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User' } as AnyObj;
      if (field.name === 'repository') {
        const repo = findRepo(ctx, args.owner, args.name);
        return repo === null ? null : ({ __type: 'Repository', repo } as AnyObj);
      }
      if (field.name === 'node') {
        const decoded = decodeId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoFromId(ctx, args.id);
          return repo === null ? null : ({ __type: 'Repository', repo } as AnyObj);
        }
        if (decoded.kind === 'Issue') {
          const found = issueFromId(ctx, args.id);
          return found === null ? null : ({ __type: 'Issue', ...found } as AnyObj);
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullFromId(ctx, args.id);
          return found === null ? null : ({ __type: 'PullRequest', ...found } as AnyObj);
        }
        return null;
      }
      throw new GraphQLError(`unknown Query field ${field.name}`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromId(ctx, input.repositoryId);
        if (repo === null) throw new GraphQLError('repository not found');
        const issue = createIssue(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', repo, issue } as AnyObj;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromId(ctx, input.issueId);
        if (found === null) throw new GraphQLError('issue not found');
        found.issue.state = 'closed';
        found.issue.updatedAt = ctx.forge.now().iso;
        return { __type: 'CloseIssuePayload', ...found } as AnyObj;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromId(ctx, input.repositoryId);
        if (repo === null) throw new GraphQLError('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refOfBranch(head);
        const baseSha = repo.refOfBranch(base);
        if (headSha === null || baseSha === null) throw new GraphQLError('head or base branch not found');
        const pull = createPull(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), head, base, headSha, baseSha);
        return { __type: 'CreatePullRequestPayload', repo, pull } as AnyObj;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromId(ctx, input.pullRequestId);
        if (found === null) throw new GraphQLError('pull request not found');
        const result = squashMerge(ctx.forge, found.repo, found.pull);
        if (!result.ok) throw new GraphQLError(result.message);
        return { __type: 'MergePullRequestPayload', ...found } as AnyObj;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromId(ctx, input.subjectId);
        if (found === null) throw new GraphQLError('issue not found');
        const { iso } = ctx.forge.now();
        const comment = { id: ctx.forge.commentIdSeq, body: String(input.body ?? ''), createdAt: iso };
        ctx.forge.commentIdSeq += 1;
        found.issue.comments.push(comment);
        return { __type: 'AddCommentPayload', ...found, comment } as AnyObj;
      }
      throw new GraphQLError(`unknown Mutation field ${field.name}`);
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __type: 'User' } as AnyObj;
        case 'defaultBranchRef':
          return { __type: 'Ref', name: repo.defaultBranch } as AnyObj;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : ({ __type: 'Issue', repo, issue } as AnyObj);
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          if (orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
          else list.sort((a, b) => a.number - b.number);
          const page = pageOf(list, args.first as number | undefined, (args.after as string | null) ?? null);
          return {
            __type: 'IssueConnection',
            repo,
            issues: page.slice,
            total: list.length,
            endCursor: page.endCursor,
            hasNext: page.hasNext,
          } as AnyObj;
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } as AnyObj);
        }
        case 'pullRequests': {
          const list = [...repo.pulls].sort((a, b) => a.number - b.number);
          const page = pageOf(list, args.first as number | undefined, (args.after as string | null) ?? null);
          return {
            __type: 'PullRequestConnection',
            repo,
            pulls: page.slice,
            total: list.length,
            endCursor: page.endCursor,
            hasNext: page.hasNext,
          } as AnyObj;
        }
        default:
          throw new GraphQLError(`unknown Repository field ${field.name}`);
      }
    }
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', String(VIEWER_ID));
      if (field.name === 'name') return 'ada iversen';
      throw new GraphQLError(`unknown User field ${field.name}`);
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      throw new GraphQLError(`unknown Ref field ${field.name}`);
    }
    case 'Issue': {
      const issue = obj.issue;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${obj.repo.id}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `https://github.com/${obj.repo.fullName}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return { __type: 'User' } as AnyObj;
        case 'comments':
          return {
            __type: 'FileConnection',
            files: issue.comments.map((comment) => ({ __type: 'File' as const, path: String(comment.id) })),
            total: issue.comments.length,
            endCursor: null,
            hasNext: false,
          } as AnyObj;
        case 'labels':
          return issue.labels.map((name) => ({ name }));
        default:
          throw new GraphQLError(`unknown Issue field ${field.name}`);
      }
    }
    case 'PullRequest': {
      const pull = obj.pull;
      const repo = obj.repo;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          if (pull.merged) return 'MERGED';
          return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'merged':
          return pull.merged;
        case 'url':
          return `https://github.com/${repo.fullName}/pull/${pull.number}`;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'files': {
          const headTip = repo.refOfBranch(pull.headRef) ?? pull.headSha;
          const baseTip = repo.refOfBranch(pull.baseRef) ?? pull.baseSha;
          const mergeBaseOid = repo.mergeBase(headTip, baseTip);
          const baseTree = mergeBaseOid === null ? null : (repo.commitOf(mergeBaseOid)?.tree ?? null);
          const headTree = repo.commitOf(headTip)?.tree ?? null;
          const changes = repo.diffTrees(baseTree, headTree);
          const page = pageOf(
            changes.map((change) => ({ __type: 'File' as const, path: change.path })),
            args.first as number | undefined,
            (args.after as string | null) ?? null,
          );
          return {
            __type: 'FileConnection',
            files: page.slice,
            total: changes.length,
            endCursor: page.endCursor,
            hasNext: page.hasNext,
          } as AnyObj;
        }
        default:
          throw new GraphQLError(`unknown PullRequest field ${field.name}`);
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection': {
      if (field.name === 'nodes') {
        if (obj.__type === 'IssueConnection') return obj.issues.map((issue) => ({ __type: 'Issue', repo: obj.repo, issue }) as AnyObj);
        if (obj.__type === 'PullRequestConnection') return obj.pulls.map((pull) => ({ __type: 'PullRequest', repo: obj.repo, pull }) as AnyObj);
        return obj.files.map((file) => file);
      }
      if (field.name === 'pageInfo') {
        return { __type: 'PageInfo', hasNext: obj.hasNext, endCursor: obj.endCursor } as AnyObj;
      }
      if (field.name === 'totalCount') return obj.total;
      throw new GraphQLError(`unknown connection field ${field.name}`);
    }
    case 'File': {
      if (field.name === 'path') return (obj as { path: string }).path;
      throw new GraphQLError(`unknown File field ${field.name}`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNext;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      throw new GraphQLError(`unknown PageInfo field ${field.name}`);
    }
    case 'IssueComment': {
      if (field.name === 'id') return globalId('IssueComment', String(obj.comment.id));
      if (field.name === 'body') return obj.comment.body;
      if (field.name === 'author') return { __type: 'User' } as AnyObj;
      throw new GraphQLError(`unknown IssueComment field ${field.name}`);
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return { __type: 'IssueComment', repo: obj.repo, issue: obj.issue, comment: obj.comment } as AnyObj;
      if (field.name === 'cursor') return encodeCursor(0);
      throw new GraphQLError(`unknown IssueCommentEdge field ${field.name}`);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as AnyObj;
      if (field.name === 'clientMutationId') return null;
      throw new GraphQLError(`unknown payload field ${field.name}`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pull: obj.pull } as AnyObj;
      if (field.name === 'clientMutationId') return null;
      throw new GraphQLError(`unknown payload field ${field.name}`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __type: 'IssueCommentEdge', repo: obj.repo, issue: obj.issue, comment: obj.comment } as AnyObj;
      if (field.name === 'clientMutationId') return null;
      throw new GraphQLError(`unknown payload field ${field.name}`);
    }
    case '__Type': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'kind') return obj.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        return names.map((name) => ({ __type: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        if (obj.name === 'SearchType') return SEARCH_ENUM.map((name) => ({ __type: '__EnumValue', name }));
        return [];
      }
      throw new GraphQLError(`unknown __Type field ${field.name}`);
    }
    default:
      throw new GraphQLError(`cannot resolve fields on ${(obj as { __type?: string }).__type ?? 'Unknown'}`);
  }
}

/** The __Field / __EnumValue pseudo-objects are plain records, resolved here. */
function resolvePseudo(obj: { __type: string; name: string }, field: FieldNode): unknown {
  if (field.name === 'name') return obj.name;
  throw new GraphQLError(`unknown field ${field.name}`);
}

function typeNameOf(obj: AnyObj | Record<string, unknown> | null): string {
  if (obj === null || typeof obj !== 'object') return 'Unknown';
  const type = (obj as { __type?: string }).__type;
  if (typeof type === 'string') {
    if (type === '__Field') return '__Field';
    if (type === '__EnumValue') return '__EnumValue';
    return type;
  }
  return 'Unknown';
}

function executeSelection(
  ctx: Ctx,
  obj: AnyObj | Record<string, unknown> | null,
  selection: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentType !== null) {
      // Inline fragment: apply only when the type matches.
      const typeName = typeNameOf(obj as AnyObj);
      if (field.fragmentType !== typeName) continue;
      if (field.selection === null) continue;
      Object.assign(out, executeSelection(ctx, obj, field.selection));
      continue;
    }
    const typeName = typeNameOf(obj as AnyObj);
    const allowed = TYPE_FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
    const key = field.alias ?? field.name;
    if (obj === null) {
      out[key] = null;
      continue;
    }
    let value: unknown;
    const pseudo = obj as { __type?: string; name?: string };
    if (pseudo.__type === '__Field' || pseudo.__type === '__EnumValue') {
      value = resolvePseudo(obj as { __type: string; name: string }, field);
    } else if (field.name === '__type') {
      const typeArg = argsOf(field, ctx.variables).name as string | undefined;
      const known = typeArg !== undefined && TYPE_FIELDS[typeArg] !== undefined;
      value =
        typeArg === undefined || !known
          ? null
          : ({ __type: '__Type', name: typeArg } as AnyObj);
    } else {
      value = resolveField(ctx, obj as AnyObj, field);
    }
    if (field.selection !== null) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((entry) =>
          typeof entry === 'object' && entry !== null && '__type' in (entry as Record<string, unknown>)
            ? executeSelection(ctx, entry as AnyObj, field.selection!)
            : entry,
        );
      } else if (typeof value === 'object') {
        out[key] = executeSelection(ctx, value as AnyObj, field.selection);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(forge: Forge, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { forge, variables };
  try {
    const root: AnyObj = op.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
    const data = executeSelection(ctx, root, op.selection);
    return { data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, errors: [{ message }] };
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResponse {
  status: number;
  body: string;
}

/** POST /api/graphql. Returns 401 without a token, 400 for a malformed body. */
export function handleGraphQL(forge: Forge, rawBody: Buffer, authorized: boolean): GraphQLResponse {
  if (!authorized) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ message: 'Problems parsing JSON' }) };
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null) return { data: null, errors: [{ message: 'Invalid request' }] };
    const record = doc as Record<string, unknown>;
    if (typeof record.query !== 'string') return { data: null, errors: [{ message: 'No query provided' }] };
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    try {
      const op = new Parser(record.query).parseOperation();
      return executeOperation(forge, op, variables);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { data: null, errors: [{ message }] };
    }
  };
  const result = Array.isArray(parsed) ? parsed.map(runOne) : runOne(parsed);
  return { status: 200, body: JSON.stringify(result) };
}
