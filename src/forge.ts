// The forge's shared operations: contents commits (PUT/DELETE /contents), squash merges,
// pull-request file lists, branch creation. REST, GraphQL and MCP all go through here, so the
// three surfaces always agree on the same objects.
//
// Commits the forge itself writes (contents, merges) carry the viewer's identity and the
// trial's now — deterministic across the live pass and its replay.

import { buildCommit, buildTree, hashObject, parseCommit, parseTag, parseTree } from './objects.ts';
import { diffTrees, flattenTree, hasMergeConflict, mergeBase, treeOfCommit } from './diff.ts';
import type { PullFile } from './diff.ts';
import { VIEWER, type Pull, type Repo, type Store } from './store.ts';
import { trialNowEpochSec, trialNowIso, ZERO_OID } from './util.ts';

const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** Rebuild a tree from a flat path->blob map, storing every new tree object. */
function rebuildTree(repo: Repo, files: Map<string, string>): string {
  // Group paths by directory, deepest first, so each subtree is built before its parent.
  interface Node {
    files: Map<string, string>; // basename -> blob oid
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      let child = node.dirs.get(name);
      if (!child) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) {
      // An empty directory holds no files: git trees never name one.
      if (child.files.size === 0 && child.dirs.size === 0) continue;
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store a commit object and return its oid. */
function storeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const data = buildCommit({
    tree,
    parents,
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: IDENTITY,
    committer: IDENTITY,
    timestamp: trialNowEpochSec(),
  });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

export interface FileCommitResult {
  commitSha: string;
  blobSha: string;
}

/**
 * Commit one file on `branch` (creating the branch from the default tip when it does not
 * exist yet — the contents route is a branch-creation path too). The caller has already
 * validated the `sha` precondition for updates. Returns null when the branch cannot be
 * resolved and the repository is not empty.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  options: { branch: string; path: string; content: Buffer; message: string },
): FileCommitResult | null {
  const ref = `refs/heads/${options.branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A new branch starts at the default branch's tip (or nowhere, in an empty repo).
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined && repo.refs.size > 0) return null;
  }
  const blobSha = hashObject('blob', options.content);
  if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: options.content });
  const files = flattenTree(repo, tip === undefined ? null : treeOfCommit(repo, tip));
  files.set(options.path, { oid: blobSha, mode: '100644' });
  const flat = new Map<string, string>();
  for (const [path, entry] of files) flat.set(path, entry.oid);
  const tree = rebuildTree(repo, flat);
  const commitSha = storeCommit(repo, tree, tip === undefined ? [] : [tip], options.message);
  repo.refs.set(ref, commitSha);
  store.touch(repo);
  return { commitSha, blobSha };
}

/** Delete one file on `branch` with a commit. Returns null when the file is not there. */
export function deleteFile(
  store: Store,
  repo: Repo,
  options: { branch: string; path: string; message: string },
): { commitSha: string } | null {
  const ref = `refs/heads/${options.branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const files = flattenTree(repo, treeOfCommit(repo, tip));
  if (!files.has(options.path)) return null;
  files.delete(options.path);
  const flat = new Map<string, string>();
  for (const [path, entry] of files) flat.set(path, entry.oid);
  const tree = rebuildTree(repo, flat);
  const commitSha = storeCommit(repo, tree, [tip], options.message);
  repo.refs.set(ref, commitSha);
  store.touch(repo);
  return { commitSha };
}

/** The blob at `path` as of `commitOid`, or null. */
export function fileAtCommit(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
  const files = flattenTree(repo, treeOfCommit(repo, commitOid));
  const entry = files.get(path);
  if (!entry) return null;
  const object = repo.objects.get(entry.oid);
  if (!object || object.type !== 'blob') return null;
  return { oid: entry.oid, data: object.data };
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  sha: string;
}

/**
 * The entries of the directory at `dirPath` as of `commitOid` ('' is the root). Returns null
 * when the path is not a directory (or does not exist).
 */
export function dirAtCommit(repo: Repo, commitOid: string, dirPath: string): DirEntry[] | null {
  const treeOid = treeOfCommit(repo, commitOid);
  if (treeOid === null) return null;
  let current = treeOid;
  if (dirPath !== '') {
    const segments = dirPath.split('/');
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  const out: DirEntry[] = [];
  for (const entry of parseTree(object.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    out.push({ name: entry.name, path, type: entry.mode === '40000' ? 'dir' : 'file', sha: entry.oid });
  }
  return out;
}

/** The tip of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a branch at `sha`. Returns an error string, or null on success. */
export function createBranch(store: Store, repo: Repo, name: string, sha: string): string | null {
  const ref = `refs/heads/${name}`;
  if (repo.refs.has(ref)) return `Reference already exists: ${ref}`;
  const object = repo.objects.get(sha);
  if (!object) return `Object does not exist: ${sha}`;
  if (object.type !== 'commit') return `Object is not a commit: ${sha}`;
  repo.refs.set(ref, sha);
  store.touch(repo);
  return null;
}

/** The changed files of a pull request (merge-base of base/head vs the head tip). */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headTip);
  return diffTrees(repo, baseTree, headTree);
}

/** Whether a pull request can merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  return !hasMergeConflict(repo, baseTip, headTip);
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; error: string };

/**
 * Squash-merge a pull request onto its base branch: one commit carrying the head's tree on
 * top of the base tip, then the pull request closes as merged.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, conflict: false, error: 'Pull request is already closed' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null) return { ok: false, conflict: false, error: `Head branch ${pull.headRef} does not exist` };
  if (baseTip === null) return { ok: false, conflict: false, error: `Base branch ${pull.baseRef} does not exist` };
  if (hasMergeConflict(repo, baseTip, headTip)) return { ok: false, conflict: true };
  const headTree = treeOfCommit(repo, headTip);
  if (headTree === null) return { ok: false, conflict: false, error: 'Head commit has no tree' };
  const sha = storeCommit(repo, headTree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = sha;
  pull.updatedSeq = store.seq();
  pull.version += 1;
  repo.pullJsonCache.delete(pull.number);
  store.touch(repo);
  return { ok: true, sha };
}

/** Peel a tag object (or a plain oid) to the commit it names. */
export function peelToCommit(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object?.type === 'tag') {
    try {
      const target = parseTag(object.data).object;
      return peelToCommit(repo, target);
    } catch {
      return oid;
    }
  }
  return oid;
}

export { ZERO_OID };
