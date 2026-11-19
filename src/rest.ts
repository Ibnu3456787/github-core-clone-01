// The REST v3 API: repositories, branches, commits, contents, labels, issues, pull requests.
// Every reply is JSON with a `message` string on errors; the router and the auth check live in
// app.ts, which calls handleRest with the path segments after `/api/v3`.
//
// Serializers are shared with the MCP surface (its tool results are REST-shaped JSON), so they
// are exported. The two timed issue workloads run through here: GET /issues/{n} answers from a
// per-issue pre-serialized JSON cache, and POST /issues caches its own reply at creation.

import { parseCommit } from './objects.ts';
import { commitHistory, resolveRef } from './diff.ts';
import {
  branchTip,
  commitFile,
  deleteFile,
  dirAtCommit,
  fileAtCommit,
  pullFiles,
  squashMerge,
} from './forge.ts';
import { VIEWER, type Comment, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { b64decode, encodeGlobalId, trialNowIso, ZERO_OID } from './util.ts';

/** The query-parameter surface the REST handlers need (a lazy parser in app.ts). */
export interface QueryParams {
  get(name: string): string | null;
  /** All decoded key/value pairs, in request order (for rebuilding pagination URLs). */
  entries(): Array<[string, string]>;
}

export interface RestContext {
  store: Store;
  method: string;
  /** Decoded path segments after `/api/v3` (e.g. ['repos', owner, name, 'issues', '3']). */
  segments: string[];
  query: QueryParams;
  /** The parsed JSON body (undefined when there was no body). */
  body: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  bodyParseError: boolean;
  /** The request's Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** Pre-serialized JSON body (takes precedence over `body`). */
  json?: string;
  /** A value serialized as JSON. Undefined means an empty body. */
  body?: unknown;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const message = (status: number, text: string): RestResult => json(status, { message: text });
const notFound = (what = 'Not Found'): RestResult => message(404, what);

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: encodeGlobalId('User', String(id)), type: 'User', site_admin: false };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(repo.owner, VIEWER.id),
    description: repo.description,
    fork: false,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { id: 0, node_id: encodeGlobalId('Label', label.name), name: label.name, color: label.color, description: '' };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed' };
    }),
    user: userJson(VIEWER.login, VIEWER.id),
    assignee: null,
    assignees: [],
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: issue.state === 'closed' ? trialNowIso() : null,
  };
}

/** The cached serialization of one issue (the read workload's hot path). */
export function cachedIssueJson(store: Store, repo: Repo, issue: Issue): string {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached && cached.version === issue.version) return cached.json;
  const text = JSON.stringify(issueJson(store, repo, issue));
  repo.issueJsonCache.set(issue.number, { version: issue.version, json: text });
  return text;
}

function refJson(ref: string, sha: string, repo: Repo): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner, VIEWER.id),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    head: refJson(pull.headRef, headSha, repo),
    base: refJson(pull.baseRef, baseSha, repo),
    user: userJson(VIEWER.login, VIEWER.id),
    assignee: null,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: pull.state === 'closed' ? trialNowIso() : null,
  };
}

/** The cached serialization of one pull request. */
export function cachedPullJson(store: Store, repo: Repo, pull: Pull): string {
  const cached = repo.pullJsonCache.get(pull.number);
  if (cached && cached.version === pull.version) return cached.json;
  const text = JSON.stringify(pullJson(store, repo, pull));
  repo.pullJsonCache.set(pull.number, { version: pull.version, json: text });
  return text;
}

export function commentJson(store: Store, repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: store.commentGlobalId(repo, comment),
    body: comment.body,
    user: userJson(comment.authorLogin, VIEWER.id),
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

/** `Name <email> timestamp tz` -> its parts, with the date as ISO-8601. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const open = line.indexOf('<');
  const close = line.indexOf('>', open + 1);
  const name = open > 0 ? line.slice(0, open).trim() : line;
  const email = open >= 0 && close > open ? line.slice(open + 1, close) : '';
  const rest = close >= 0 ? line.slice(close + 1).trim().split(' ') : [];
  const epoch = Number.parseInt(rest[0] ?? '', 10);
  const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : trialNowIso();
  return { name, email, date };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return { sha, commit: { message: '' } };
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const messageText = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha,
    node_id: encodeGlobalId('Commit', sha),
    commit: {
      message: messageText,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function bodyObject(ctx: RestContext): Record<string, unknown> {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
    return ctx.body as Record<string, unknown>;
  }
  return {};
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function numberSegment(segment: string | undefined): number | null {
  if (segment === undefined) return null;
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

function pageParams(query: QueryParams): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

/** A GitHub-style `Link` header carrying rel="next" (and only that relation). */
function nextLink(ctx: RestContext, path: string, page: number, perPage: number): Record<string, string> {
  const pairs = ctx.query.entries().filter(([key]) => key !== 'page' && key !== 'per_page');
  pairs.push(['page', String(page + 1)], ['per_page', String(perPage)]);
  const query = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  return { link: `<http://${ctx.host}${path}?${query}>; rel="next"` };
}

function sortedIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
  const issues = [...repo.issues.values()];
  const filtered = state === 'all' ? issues : issues.filter((issue) => issue.state === state);
  filtered.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return filtered;
}

function sortedPulls(repo: Repo, state: string): Pull[] {
  const pulls = [...repo.pulls.values()];
  const filtered = state === 'all' ? pulls : pulls.filter((pull) => pull.state === state);
  filtered.sort((a, b) => b.createdSeq - a.createdSeq);
  return filtered;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: RestContext): RestResult {
  if (ctx.bodyParseError) return message(400, 'Problems parsing JSON');
  const { store, method, segments: s } = ctx;

  // -- the API root and meta ------------------------------------------------------
  if (s.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, { current_user_url: 'https://api.github.com/user' }, { 'x-oauth-scopes': 'repo' });
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }
  if (s.length === 1 && s[0] === 'user') {
    if (method !== 'GET') return notFound();
    return json(200, {
      ...userJson(VIEWER.login, VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      created_at: trialNowIso(),
      updated_at: trialNowIso(),
    });
  }

  // -- POST /user/repos, GET /user/repos -------------------------------------------
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') return message(422, 'Validation Failed: name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return message(422, `Validation Failed: ${JSON.stringify(name)} is not a valid repository name`);
      const repo = store.createRepo(name, stringField(body, 'description') ?? '', body.private === true);
      if (repo === null) {
        return message(422, 'Repository creation failed. (name already exists on this account)');
      }
      return json(201, repoJson(store, repo));
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(ctx.query);
      const { items, hasNext } = paginate(store.listRepos(), page, perPage);
      const headers = hasNext ? nextLink(ctx, '/api/v3/user/repos', page, perPage) : undefined;
      return json(200, items.map((repo) => repoJson(store, repo)), headers);
    }
    return notFound();
  }

  // -- /repos/{owner}/{repo}/... ---------------------------------------------------
  if (s.length >= 3 && s[0] === 'repos') {
    const repo = store.getRepo(s[1], s[2]);
    if (!repo) return notFound();
    const rest = s.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        store.touch(repo);
        return json(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(s[1], s[2]);
        return { status: 204 };
      }
      return notFound();
    }

    const head = rest[0];

    // -- branches ----------------------------------------------------------------
    if (head === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return notFound();
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, sha]) => branchJson(name.slice('refs/heads/'.length), sha))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return json(200, branches);
      }
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound();
      if (method !== 'GET') return notFound();
      return json(200, branchJson(branch, tip));
    }

    // -- git refs -----------------------------------------------------------------
    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const refs = sortedRefList(repo);
          return json(200, refs);
        }
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const ref = stringField(body, 'ref');
          const sha = stringField(body, 'sha');
          if (ref === undefined || !ref.startsWith('refs/')) return message(422, 'Validation Failed: ref must start with refs/');
          if (sha === undefined || !repo.objects.has(sha)) return message(422, `Object does not exist: ${sha ?? ''}`);
          if (repo.refs.has(ref)) return message(422, `Reference already exists: ${ref}`);
          repo.refs.set(ref, sha);
          store.touch(repo);
          return json(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        }
        return notFound();
      }
      // GET /git/refs/<namespace...>/<name...> — the ref is the rest of the path.
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      if (method !== 'GET') return notFound();
      return json(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }

    // -- commits -------------------------------------------------------------------
    if (head === 'commits') {
      if (method !== 'GET') return notFound();
      const refParam = ctx.query.get('sha');
      const tip = refParam === null ? branchTip(repo, repo.defaultBranch) : resolveRef(repo, refParam);
      if (tip === null) return json(200, []);
      const { page, perPage } = pageParams(ctx.query);
      const history = commitHistory(repo, tip, page * perPage + 1);
      const { items, hasNext } = paginate(history, page, perPage);
      const headers = hasNext ? nextLink(ctx, `/api/v3/repos/${s[1]}/${s[2]}/commits`, page, perPage) : undefined;
      return json(200, items.map((sha) => commitJson(repo, sha)), headers);
    }

    // -- contents -------------------------------------------------------------------
    if (head === 'contents') {
      return handleContents(ctx, repo, rest.slice(1).join('/'));
    }

    // -- labels ----------------------------------------------------------------------
    if (head === 'labels') {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map(labelJson));
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const name = stringField(body, 'name');
        if (name === undefined || name === '') return message(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) return message(422, `Validation Failed: label ${JSON.stringify(name)} already exists`);
        const color = stringField(body, 'color') ?? 'ededed';
        const label = { name, color };
        repo.labels.set(name, label);
        store.touch(repo);
        return json(201, labelJson(label));
      }
      return notFound();
    }

    // -- issues -----------------------------------------------------------------------
    if (head === 'issues') {
      return handleIssues(ctx, repo, rest.slice(1));
    }

    // -- pull requests -----------------------------------------------------------------
    if (head === 'pulls') {
      return handlePulls(ctx, repo, rest.slice(1));
    }

    return notFound();
  }

  return notFound();
}

function sortedRefList(repo: Repo): Array<Record<string, unknown>> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(ctx: RestContext, repo: Repo, path: string): RestResult {
  const { store, method } = ctx;
  if (method === 'GET') {
    const refParam = ctx.query.get('ref');
    const tip = refParam === null ? branchTip(repo, repo.defaultBranch) : resolveRef(repo, refParam);
    if (tip === null) return notFound();
    if (path === '') {
      const entries = dirAtCommit(repo, tip, '') ?? [];
      return json(200, entries.map((entry) => dirEntryJson(repo, tip, entry)));
    }
    const file = fileAtCommit(repo, tip, path);
    if (file) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: file.oid,
        content: file.data.toString('base64'),
      });
    }
    const entries = dirAtCommit(repo, tip, path);
    if (entries) {
      return json(200, entries.map((entry) => dirEntryJson(repo, tip, entry)));
    }
    return notFound();
  }

  if (method === 'PUT') {
    const body = bodyObject(ctx);
    const contentB64 = stringField(body, 'content');
    if (contentB64 === undefined) return message(422, 'Validation Failed: content is required');
    const content = b64decode(contentB64);
    const messageText = stringField(body, 'message') ?? `Update ${path}`;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(body, 'sha');
    const tip = branchTip(repo, branch);
    const current = tip === null ? null : fileAtCommit(repo, tip, path);
    if (sha !== undefined) {
      if (current === null) return message(422, `Validation Failed: ${path} does not exist on ${branch}`);
      if (current.oid.toLowerCase() !== sha.toLowerCase()) {
        return message(409, `The sha ${sha} does not match the current blob sha ${current.oid}`);
      }
    } else if (current !== null) {
      return message(422, `Validation Failed: ${path} already exists; send its sha to update it`);
    }
    const result = commitFile(store, repo, { branch, path, content, message: messageText });
    if (result === null) return message(422, `Validation Failed: branch ${branch} cannot be created here`);
    const isCreate = current === null;
    return json(isCreate ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobSha,
        size: content.length,
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: result.commitSha, message: messageText },
    });
  }

  if (method === 'DELETE') {
    const body = bodyObject(ctx);
    const messageText = stringField(body, 'message') ?? `Delete ${path}`;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(body, 'sha');
    const tip = branchTip(repo, branch);
    if (tip === null) return notFound();
    const current = fileAtCommit(repo, tip, path);
    if (current === null) return notFound();
    if (sha !== undefined && current.oid.toLowerCase() !== sha.toLowerCase()) {
      return message(409, `The sha ${sha} does not match the current blob sha ${current.oid}`);
    }
    const result = deleteFile(store, repo, { branch, path, message: messageText });
    if (result === null) return notFound();
    return json(200, { commit: { sha: result.commitSha, message: messageText } });
  }

  return notFound();
}

function dirEntryJson(
  repo: Repo,
  tip: string,
  entry: { name: string; path: string; type: 'file' | 'dir'; sha: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: entry.type, name: entry.name, path: entry.path, sha: entry.sha };
  if (entry.type === 'file') {
    const file = fileAtCommit(repo, tip, entry.path);
    out.size = file?.data.length ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return message(422, 'Validation Failed: title is required');
      const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const entry of labelsRaw) {
        const name = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.name;
        if (typeof name !== 'string') continue;
        if (!repo.labels.has(name)) return message(422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
        labels.push(name);
      }
      const issue = store.createIssue(repo, title, stringField(body, 'body') ?? '', labels);
      return { status: 201, json: cachedIssueJson(store, repo, issue) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const { page, perPage } = pageParams(ctx.query);
      const { items, hasNext } = paginate(sortedIssues(repo, state, direction), page, perPage);
      const headers = hasNext ? nextLink(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, page, perPage) : undefined;
      return json(200, items.map((issue) => issueJson(store, repo, issue)), headers);
    }
    return notFound();
  }

  const number = numberSegment(rest[0]);
  if (number === null) return notFound();
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, json: cachedIssueJson(store, repo, issue) };
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') store.setIssueState(repo, issue, state);
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      if (title !== undefined || bodyText !== undefined) {
        issue.updatedSeq = store.seq();
        issue.version += 1;
        repo.issueJsonCache.delete(issue.number);
        store.touch(repo);
      }
      return { status: 200, json: cachedIssueJson(store, repo, issue) };
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const text = stringField(body, 'body');
      if (text === undefined) return message(422, 'Validation Failed: body is required');
      const comment = store.addComment(repo, number, text);
      return json(201, commentJson(store, repo, comment));
    }
    if (method === 'GET') {
      return json(200, store.commentsOf(repo, number).map((comment) => commentJson(store, repo, comment)));
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const { store, method } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base') ?? repo.defaultBranch;
      if (title === undefined || title === '') return message(422, 'Validation Failed: title is required');
      if (head === undefined || head === '') return message(422, 'Validation Failed: head is required');
      if (branchTip(repo, head) === null) return message(422, `Validation Failed: head branch ${JSON.stringify(head)} does not exist`);
      if (branchTip(repo, base) === null) return message(422, `Validation Failed: base branch ${JSON.stringify(base)} does not exist`);
      if (head === base) return message(422, 'Validation Failed: head and base are the same branch');
      const pull = store.createPull(repo, title, stringField(body, 'body') ?? '', head, base);
      return { status: 201, json: cachedPullJson(store, repo, pull) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const { page, perPage } = pageParams(ctx.query);
      const { items, hasNext } = paginate(sortedPulls(repo, state), page, perPage);
      const headers = hasNext ? nextLink(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, page, perPage) : undefined;
      return json(200, items.map((pull) => pullJson(store, repo, pull)), headers);
    }
    return notFound();
  }

  const number = numberSegment(rest[0]);
  if (number === null) return notFound();
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (!pull) return notFound();
    if (method !== 'GET') return notFound();
    return { status: 200, json: cachedPullJson(store, repo, pull) };
  }

  if (rest[1] === 'files') {
    if (!pull) return notFound();
    if (method !== 'GET') return notFound();
    return json(200, pullFiles(repo, pull));
  }

  if (rest[1] === 'merge') {
    if (!pull) return notFound();
    if (method !== 'PUT') return notFound();
    const outcome = squashMerge(store, repo, pull);
    if (!outcome.ok) {
      if (outcome.conflict) return message(405, 'Pull Request is not mergeable');
      return message(405, outcome.error);
    }
    return json(200, { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' });
  }

  return notFound();
}
