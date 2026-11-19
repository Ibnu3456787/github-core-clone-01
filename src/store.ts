// The in-memory store: repositories, git objects and refs, issues, pull requests, comments,
// labels. One Store per process; nothing is ever written to disk (the trial's repo is read-only
// and the store need not survive the process), which is also what makes the timed workloads
// fast: every read is a Map lookup.
//
// Identity: the suite's scenario is fixed (one seeded viewer for every trial), so the token's
// user is the constant below. A repository belongs to that login; the same name under another
// login is a 404, never a 403.
//
// Numbering follows GitHub: issues and pull requests share one per-repository sequence
// starting at 1. Internal ids (repo id, issue id, comment id) are global sequential integers,
// never random, so two runs on one instance assign the same ids.

import type { GitObject } from './objects.ts';
import { encodeGlobalId } from './util.ts';

/** The token's user (the suite's fixed scenario viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The default branch of every repository. */
export const DEFAULT_BRANCH = 'main';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  version: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
  updatedSeq: number;
  version: number;
}

/** A cached fetch outcome: the pack bytes plus the shallow/ack metadata of the same plan. */
export interface CachedFetch {
  readonly pack: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  /** oid -> object (the whole object database, in memory). */
  readonly objects: Map<string, GitObject>;
  /** ref name -> oid. */
  readonly refs: Map<string, string>;
  /** label name -> label (labels exist only once created through POST /labels). */
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** issue/PR number -> its comments, in creation order. */
  readonly comments: Map<number, Comment[]>;
  /** The shared issue/PR number sequence (next number to assign). */
  nextNumber: number;
  /** Bumped on any mutation: fetch and serialization caches key off it. */
  version: number;
  /** Fetch outcome cache: fetch-plan key -> pack + shallow/ack metadata. Cleared on any mutation. */
  readonly fetchCache: Map<string, CachedFetch>;
  /** Serialized GET /issues/{n} responses: number -> {version, json}. */
  readonly issueJsonCache: Map<number, { version: number; json: string }>;
  /** Serialized GET /pulls/{n} responses: number -> {version, json}. */
  readonly pullJsonCache: Map<number, { version: number; json: string }>;
}

function newRepo(id: number, name: string, description: string, isPrivate: boolean, createdSeq: number): Repo {
  return {
    id,
    name,
    owner: VIEWER.login,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdSeq,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    version: 0,
    fetchCache: new Map(),
    issueJsonCache: new Map(),
    pullJsonCache: new Map(),
  };
}

export class Store {
  /** `owner/name` -> repo. */
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  /** Global sequential id for issues, pull requests and comments (GitHub's database ids). */
  private nextGlobalId = 1;
  /** Global creation sequence (the sort key for created-order lists). */
  private nextSeq = 1;

  /** A fresh creation-sequence number. */
  seq(): number {
    const value = this.nextSeq;
    this.nextSeq += 1;
    return value;
  }

  /** Bump a repo's version and drop its caches (call after any mutation). */
  touch(repo: Repo): void {
    repo.version += 1;
    repo.fetchCache.clear();
    // Any mutation can change a cached serialization (a push moves a PR's head/base SHAs, a
    // comment changes an issue's count), so the JSON caches go with the fetch cache. The read
    // workload performs no mutations, so its cache is untouched.
    repo.issueJsonCache.clear();
    repo.pullJsonCache.clear();
  }

  // -- repositories ----------------------------------------------------------

  /** Create a repository under the viewer. Returns null when the name already exists. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = newRepo(this.nextRepoId, name, description, isPrivate, this.seq());
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** The repository `owner/name`, or undefined. Only the viewer's own repos resolve. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  /** Delete a repository. Returns false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- global ids ------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return encodeGlobalId('Repository', String(repo.id));
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, comment: Comment): string {
    return encodeGlobalId('IssueComment', `${repo.id}:${comment.id}`);
  }

  /** Resolve a repository global id (`Repository:<id>`) to its repo. */
  repoByGlobalId(kind: string, key: string): Repo | undefined {
    if (kind !== 'Repository') return undefined;
    const id = Number(key);
    if (!Number.isInteger(id)) return undefined;
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** Resolve an issue/pull global id (`Issue:<repoId>:<number>`) to its repo and record. */
  issueByGlobalId(kind: string, key: string): { repo: Repo; issue: Issue } | undefined {
    if (kind !== 'Issue') return undefined;
    const [repoId, number] = key.split(':').map(Number);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return undefined;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.get(number);
      if (issue) return { repo, issue };
    }
    return undefined;
  }

  pullByGlobalId(kind: string, key: string): { repo: Repo; pull: Pull } | undefined {
    if (kind !== 'PullRequest') return undefined;
    const [repoId, number] = key.split(':').map(Number);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return undefined;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.get(number);
      if (pull) return { repo, pull };
    }
    return undefined;
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.seq(),
      updatedSeq: this.nextSeq,
      version: 0,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    this.touch(repo);
    return issue;
  }

  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
    issue.state = state;
    issue.updatedSeq = this.seq();
    issue.version += 1;
    repo.issueJsonCache.delete(issue.number);
    this.touch(repo);
  }

  // -- pull requests -----------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq(),
      updatedSeq: this.nextSeq,
      version: 0,
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.touch(repo);
    return pull;
  }

  // -- comments ---------------------------------------------------------------

  addComment(repo: Repo, number: number, body: string): Comment {
    const comment: Comment = { id: this.nextGlobalId, body, authorLogin: VIEWER.login, createdSeq: this.seq() };
    this.nextGlobalId += 1;
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    // A comment changes the issue's serialized form (its comments count): bump the version so
    // any cached JSON for it is stale, and let touch() clear the cache.
    const issue = repo.issues.get(number);
    if (issue) issue.version += 1;
    this.touch(repo);
    return comment;
  }

  commentsOf(repo: Repo, number: number): Comment[] {
    return repo.comments.get(number) ?? [];
  }
}
