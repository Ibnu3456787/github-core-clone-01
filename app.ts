// The HTTP server: one process, one in-memory store, four surfaces on one port.
//   GET  /healthz                 the harness's boot probe (no auth)
//   /{owner}/{repo}.git/...       git smart HTTP (info/refs, upload-pack, receive-pack)
//   /api/v3/...                   the REST v3 API
//   POST /api/graphql             GraphQL
//   POST /mcp                     MCP (Streamable HTTP, JSON-RPC 2.0)
//
// Auth: every surface except /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
// (when the variable is set; an unset variable means no credential is configured, so local
// runs skip the check). A missing or wrong token is a JSON 401. Every reply carries a
// non-empty X-GitHub-Request-Id. No handler may throw out of the server: a per-request catch
// turns an unexpected failure into a 500 and the server keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitHttpResponse } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type RestResult } from './src/rest.ts';
import { Store } from './src/store.ts';
import { nextRequestId } from './src/util.ts';

/** The largest request body accepted (packs and JSON bodies in this suite are kilobytes). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const SHOP_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${SHOP_TOKEN}`;
}

function decodeSegment(segment: string): string {
  // The fast path: most segments carry no escapes at all.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The query string, parsed lazily: the hot paths (GET /issues/{n}, the git fetch) never read a
 * query parameter, so building a URLSearchParams for every request is pure waste. `get` matches
 * URLSearchParams.get semantics (first value, '+' decoded as a space).
 */
class LazyQuery {
  private parsed: Map<string, string> | null = null;
  private readonly raw: string;

  constructor(raw: string) {
    this.raw = raw;
  }

  get(name: string): string | null {
    return this.parsedMap().get(name) ?? null;
  }

  entries(): Array<[string, string]> {
    return [...this.parsedMap().entries()];
  }

  private parsedMap(): Map<string, string> {
    if (this.parsed === null) {
      const map = new Map<string, string>();
      if (this.raw !== '') {
        for (const pair of this.raw.split('&')) {
          if (pair === '') continue;
          const eq = pair.indexOf('=');
          const key = decodeSegment((eq === -1 ? pair : pair.slice(0, eq)).replaceAll('+', ' '));
          if (map.has(key)) continue;
          map.set(key, decodeSegment((eq === -1 ? '' : pair.slice(eq + 1)).replaceAll('+', ' ')));
        }
      }
      this.parsed = map;
    }
    return this.parsed;
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '').map(decodeSegment);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = value === undefined ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  if (body !== '') headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
  res.writeHead(status, headers);
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function json404(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function sendRest(res: ServerResponse, result: RestResult): void {
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) };
  if (result.status === 204 || (result.json === undefined && result.body === undefined)) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  const body = result.json ?? JSON.stringify(result.body);
  res.writeHead(result.status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    ...headers,
  });
  res.end(body);
}

function sendGit(res: ServerResponse, result: GitHttpResponse): void {
  sendBuffer(res, result.status, result.contentType, result.body);
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Manual split instead of `new URL`: the harness sends clean absolute paths, and a full URL
  // parse on every request is the single most expensive thing this router does.
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = new LazyQuery(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));
  const method = (req.method ?? 'GET').toUpperCase();

  // -- the boot probe: no auth, no body -----------------------------------------
  if (pathname === '/healthz') {
    if (method !== 'GET') {
      json404(res);
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- git smart HTTP -------------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const owner = decodeSegment(gitMatch[1]);
    const repoName = decodeSegment(gitMatch[2]);
    const endpoint = gitMatch[3];
    const gitProtocol = req.headers['git-protocol'];
    if (endpoint === 'info/refs') {
      if (method !== 'GET') {
        json404(res);
        return;
      }
      const service = query.get('service') ?? '';
      sendGit(res, handleInfoRefs(store, owner, repoName, service, gitProtocol));
      return;
    }
    if (method !== 'POST') {
      json404(res);
      return;
    }
    const body = await readBody(req);
    if (endpoint === 'git-upload-pack') {
      sendGit(res, handleUploadPack(store, owner, repoName, gitProtocol, body));
    } else {
      sendGit(res, handleReceivePack(store, owner, repoName, body));
    }
    return;
  }

  // -- REST v3 ---------------------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const remainder = pathname.slice('/api/v3'.length);
    const segments = splitPath(remainder);
    let body: unknown;
    let bodyParseError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyParseError = true;
        }
      }
    } else {
      // Drain a body a GET may carry so the connection stays reusable — but only when one
      // could exist; the read workload's GETs carry none.
      if (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
        req.resume();
      }
    }
    const result = handleRest({
      store,
      method,
      segments,
      query,
      body,
      bodyParseError,
      host: req.headers.host ?? '127.0.0.1',
    });
    sendRest(res, result);
    return;
  }

  // -- GraphQL ----------------------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      json404(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const raw = await readBody(req);
    const result = handleGraphQL(store, raw.toString('utf8'));
    sendJson(res, result.status, result.body);
    return;
  }

  // -- MCP ---------------------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      // A legacy session DELETE (the client's close) is a no-op acknowledgement.
      if (method === 'DELETE') {
        res.writeHead(200, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      json404(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'));
    if (result.body === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  json404(res);
}

/** Build the server. main.ts binds it, registers it with the env and waits for /done. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    // A client aborting mid-response must not surface an unhandled 'error' event.
    res.on('error', () => {});
    handleRequest(store, req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.destroy();
      }
    });
  });
  return server;
}
