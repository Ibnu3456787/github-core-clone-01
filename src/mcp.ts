// The MCP endpoint (POST /mcp): Streamable HTTP, JSON-RPC 2.0, plain JSON answers (no SSE).
// The modern era (2026-07-28) is the intended path — `server/discover` returns the identity,
// capabilities and supported revisions in one request — with the legacy `initialize` handshake
// kept for a client that predates discover. Six tools, the canonical names the suite maps to,
// all backed by the same store as REST and GraphQL.
//
// JSON-RPC errors: -32700 parse error (HTTP 400), -32601 method not found, -32602 invalid
// params (an unknown tool name or missing required arguments). A tool that runs and fails
// (an unknown repository, an unmergeable pull request) answers isError:true, HTTP 200.

import { squashMerge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Store } from './store.ts';

const SERVER_NAME = 'muse-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface McpResult {
  status: number;
  /** Undefined means an empty body (a notification's 202). */
  body?: unknown;
}

type JsonRpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tool list, built once and reused verbatim: two tools/list answers must be
 * byte-identical, and a shared constant is the simplest way to guarantee it.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function result(id: JsonRpcId, value: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    // The dispatcher turns this into a JSON-RPC error; this branch is unreachable through it.
    return toolError(`Unknown tool: ${name}`);
  }
  const missing = def.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null);
  if (missing.length > 0) {
    return { __invalidParams: `Missing required argument(s): ${missing.join(', ')}` };
  }

  if (name === 'create_repo') {
    const repoName = asString(args.name);
    if (repoName === null || repoName === '') return { __invalidParams: 'create_repo needs name as a non-empty string.' };
    const description = asString(args.description) ?? '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(repoName, description, isPrivate);
    if (repo === null) return toolError(`Repository creation failed. (name already exists on this account)`);
    return toolResult(repoJson(store, repo));
  }

  // Every other tool names a repository.
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  const repo = owner === null || repoName === null ? undefined : store.getRepo(owner, repoName);
  if (!repo) return toolError(`Repository not found: ${owner ?? ''}/${repoName ?? ''}`);

  if (name === 'get_repo') return toolResult(repoJson(store, repo));

  if (name === 'create_issue') {
    const title = asString(args.title) ?? '';
    const body = asString(args.body) ?? '';
    const issue = store.createIssue(repo, title, body, []);
    return toolResult(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    const state = asString(args.state) ?? 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.createdSeq - a.createdSeq)
      .map((issue) => issueJson(store, repo, issue));
    return toolResult(issues);
  }

  if (name === 'create_pull_request') {
    const title = asString(args.title) ?? '';
    const body = asString(args.body) ?? '';
    const head = asString(args.head) ?? '';
    const base = asString(args.base) ?? '';
    if ((repo.refs.get(`refs/heads/${head}`) ?? null) === null) return toolError(`Head branch ${JSON.stringify(head)} does not exist`);
    if ((repo.refs.get(`refs/heads/${base}`) ?? null) === null) return toolError(`Base branch ${JSON.stringify(base)} does not exist`);
    const pull = store.createPull(repo, title, body, head, base);
    return toolResult(pullJson(store, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const number = asInt(args.pull_number);
    const pull = number === null ? undefined : repo.pulls.get(number);
    if (!pull) return toolError(`Pull request not found: ${number ?? ''}`);
    const outcome = squashMerge(store, repo, pull);
    if (!outcome.ok) {
      return toolError(outcome.conflict ? 'Pull Request is not mergeable' : outcome.error);
    }
    return toolResult(pullJson(store, repo, pull));
  }

  return toolError(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------------------------

export function handleMcp(store: Store, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400);
  }
  const request = asRecord(parsed);
  if (request === null) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request: the body must be a JSON-RPC object');
  }
  const method = asString(request.method);
  if (method === null) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request: no method');
  }
  const hasId = 'id' in request;
  const id = (request.id as JsonRpcId | undefined) ?? null;
  const params = asRecord(request.params) ?? {};

  // A notification (no id) is acknowledged with an empty 202 and no JSON-RPC response.
  if (!hasId) return { status: 202 };

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return result(id, {
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    const negotiated = offered !== null && (offered === MODERN_REVISION || LEGACY_REVISIONS.includes(offered)) ? offered : LEGACY_REVISIONS[0];
    return result(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = asString(params.name);
    if (toolName === null) {
      return rpcError(id, INVALID_PARAMS, 'tools/call needs a tool name');
    }
    if (!TOOLS_BY_NAME.has(toolName)) {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${toolName}`);
    }
    const args = asRecord(params.arguments) ?? {};
    const outcome = callTool(store, toolName, args);
    if ('__invalidParams' in outcome) {
      return rpcError(id, INVALID_PARAMS, String(outcome.__invalidParams));
    }
    return result(id, outcome);
  }

  if (method === 'ping') {
    return result(id, {});
  }

  return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}
