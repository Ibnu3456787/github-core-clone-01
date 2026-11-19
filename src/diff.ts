// Tree diffs, line diffs, ancestry and merge-conflict detection — the pure functions behind
// pull-request files, merges and fast-forward checks. All histories the suite builds are
// linear (squash merges are single-parent commits), but the walks follow every parent, so a
// merge commit's second parent would not break them.

import { parseCommit, parseTag, parseTree, type GitObject } from './objects.ts';
import type { Repo } from './store.ts';

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function objectOf(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Flatten a tree (recursively) into path -> {oid, mode} for blob entries. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = objectOf(repo, oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree oid of a commit, or null when the commit is unknown. */
export function treeOfCommit(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const object = objectOf(repo, commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Count added/removed lines between two blob contents (LCS over lines). */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldText = oldData.toString('utf8');
  const newText = newData.toString('utf8');
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes split() report one phantom empty line; drop it on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length * newLines.length > 1_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // LCS length table, two rows.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/**
 * The file-level diff between two trees: every path added, removed or changed, with line
 * counts. `baseTree`/`headTree` are tree oids (null for an empty tree).
 */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const blob = objectOf(repo, after.oid);
      const lines = blob ? lineDiff(Buffer.alloc(0), blob.data) : { additions: 0, deletions: 0 };
      files.push({ filename: path, status: 'added', additions: lines.additions, deletions: 0, changes: lines.additions });
    } else if (before !== undefined && after === undefined) {
      const blob = objectOf(repo, before.oid);
      const lines = blob ? lineDiff(blob.data, Buffer.alloc(0)) : { additions: 0, deletions: 0 };
      files.push({ filename: path, status: 'removed', additions: 0, deletions: lines.deletions, changes: lines.deletions });
    } else if (before !== undefined && after !== undefined) {
      const oldBlob = objectOf(repo, before.oid);
      const newBlob = objectOf(repo, after.oid);
      const lines = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'modified', additions: lines.additions, deletions: lines.deletions, changes: lines.additions + lines.deletions });
    }
  }
  return files;
}

/** True when `ancestor` is reachable from `descendant` by following parents (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objectOf(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * The merge-base of two commits: the closest common ancestor to `b`. Exact for the linear
 * histories the suite builds; a closest-common-ancestor approximation otherwise.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = objectOf(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = objectOf(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/**
 * A squash merge conflicts when some path changed on both sides of the merge-base with
 * different results (including one side deleting what the other modified).
 */
export function hasMergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return true; // unrelated histories cannot merge cleanly
  if (base === headTip) return false; // the head is already contained in the base
  const mbTree = flattenTree(repo, treeOfCommit(repo, base));
  const baseTree = flattenTree(repo, treeOfCommit(repo, baseTip));
  const headTree = flattenTree(repo, treeOfCommit(repo, headTip));
  const paths = new Set<string>([...mbTree.keys(), ...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const mb = mbTree.get(path)?.oid;
    const onBase = baseTree.get(path)?.oid;
    const onHead = headTree.get(path)?.oid;
    const baseChanged = onBase !== mb;
    const headChanged = onHead !== mb;
    if (baseChanged && headChanged && onBase !== onHead) return true;
  }
  return false;
}

/**
 * The commits reachable from `tip`, newest first (depth-first over parents, in order).
 * Linear histories come out as the plain first-parent chain.
 */
export function commitHistory(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objectOf(repo, oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/** Resolve a ref name (branch, full ref, or commit oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  const branch = `refs/heads/${ref}`;
  if (repo.refs.has(branch)) return repo.refs.get(branch) ?? null;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) {
    const oid = repo.refs.get(tag)!;
    const object = objectOf(repo, oid);
    if (object?.type === 'tag') {
      try {
        return parseTag(object.data).object;
      } catch {
        return oid;
      }
    }
    return oid;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}
