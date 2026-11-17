// app.ts — the HTTP server: one node:http server, no framework.
//
// Routes:
//   /{owner}/{repo}.git/info/refs?service=...   git advertisement (v2/v0)
//   /{owner}/{repo}.git/git-upload-pack         POST upload-pack
//   /{owner}/{repo}.git/git-receive-pack        POST receive-pack
//   /api/v3/...                                 REST v3 (token required)
//   /api/graphql                                GraphQL v4 (token required)
//   /mcp                                        MCP (token required)
//   /healthz                                    liveness probe, no auth
//
// Git endpoints do not require authentication (public reads); the API
// surfaces do. A missing repository answers 404 and the process stays alive
// for the next request — a malformed git body must never crash the server.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisement,
  handleUploadPack,
  handleReceivePack,
} from './gitproto.ts';

export interface AppOptions {
  token: string;
}

export function createApp(options: AppOptions): { forge: Forge; listen: (port: number) => Promise<number> } {
  const forge = new Forge();
  const token = options.token;

  const server = createServer((req, res) => {
    void handleRequest(forge, token, req, res).catch((error: unknown) => {
      // Never let one request kill the process.
      try {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[forge] request failed: ${message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
        } else {
          res.end();
        }
      } catch {
        // Nothing left to do.
      }
    });
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not bind'));
      });
    });

  return { forge, listen };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void {
  res.writeHead(status, headers);
  res.end(body);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const presented = auth.slice(7);
  if (presented === '') return false;
  if (token !== '' && presented !== token) return false;
  return true;
}

async function handleRequest(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/healthz') {
    send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
    return;
  }

  // ---- git smart HTTP -----------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const action = gitMatch[3];
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      send(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (action === 'info/refs') {
      if (method !== 'GET') {
        send(res, 405, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Method Not Allowed' }));
        return;
      }
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Bad Request' }));
        return;
      }
      const version2 =
        service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = advertisement(repo, service, version2);
      send(res, 200, { 'content-type': `application/x-${service}-advertisement` }, body);
      return;
    }
    if (method !== 'POST') {
      send(res, 405, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const body = await readBody(req);
    if (action === 'git-upload-pack') {
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const result = handleUploadPack(repo, body, version2);
      send(res, result.status, { 'content-type': result.contentType }, result.body);
      return;
    }
    const result = handleReceivePack(repo, body);
    send(res, result.status, { 'content-type': result.contentType }, result.body);
    return;
  }

  // ---- REST -----------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const restReq: RestRequest = {
      method,
      pathname,
      query: url.searchParams,
      headers: req.headers as Record<string, string | undefined>,
      rawBody,
      baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
    };
    const result = handleRest(forge, restReq, token);
    send(res, result.status, result.headers, result.body);
    return;
  }

  // ---- GraphQL --------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      send(res, 405, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const rawBody = await readBody(req);
    const result = handleGraphQL(forge, rawBody, authorized(req, token));
    send(res, result.status, { 'content-type': 'application/json; charset=utf-8' }, result.body);
    return;
  }

  // ---- MCP ------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      send(res, 405, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const rawBody = await readBody(req);
    const result = handleMcp(forge, rawBody, authorized(req, token));
    send(res, result.status, { 'content-type': 'application/json; charset=utf-8' }, result.body);
    return;
  }

  send(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Not Found' }));
}
