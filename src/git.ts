// Git smart HTTP: protocol v0 and v2 upload-pack (advertise, ls-refs, fetch) and v0
// receive-pack (push). An independent implementation of git's smart-HTTP wire protocol
// (Documentation/technical/protocol-v2.txt, protocol-v0.txt, http-protocol.txt in git's
// own tree): pkt-line framing, v2 capability advertisement, ls-refs with symrefs/peel/unborn,
// fetch negotiation with haves, shallow boundaries and deepen, and receive-pack with
// report-status in sideband band 1.
//
// The fetch planner is the subtle part, so its contract is stated here:
//   - covered: everything reachable from the wants, cut at the depth limit (a commit at
//     distance >= depth is excluded, with the subtree only it reaches).
//   - held: everything the client already has — reachable from its haves, cut at the shallow
//     boundaries it sent (a shallow boundary commit's parents are NOT held).
//   - sent: covered minus held. Exactly the objects the client lacks, no more, no less.
//   - shallow-info: `shallow` for each commit of the new boundary (an included commit whose
//     parent fell outside the depth limit), `unshallow` for each old boundary that no longer
//     is one.

import { parseCommit, parseTag, parseTree, readPack, writePack } from './objects.ts';
import { isAncestor } from './diff.ts';
import { peelToCommit } from './forge.ts';
import { DEFAULT_BRANCH, type CachedFetch, type Repo, type Store } from './store.ts';
import {
  decodePktLines,
  isOid,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  SIDEBAND_CHUNK,
  ZERO_OID,
} from './util.ts';

const AGENT = 'muse-forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** v0 upload-pack capabilities (the first advertisement line carries them after a NUL). */
const UPLOAD_V0_CAPS = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
  `agent=${AGENT}`,
].join(' ');

/** v0 receive-pack capabilities. */
const RECEIVE_V0_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');

/** The most fetch outcomes cached per repo (FIFO eviction; the clone workload needs one). */
const FETCH_CACHE_MAX = 64;

export interface GitHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function notFound(repoName: string): GitHttpResponse {
  return { status: 404, contentType: 'text/plain', body: Buffer.from(`repository ${repoName} not found\n`, 'utf8') };
}

function badRequest(detail: string): GitHttpResponse {
  return { status: 400, contentType: 'text/plain', body: Buffer.from(`bad request: ${detail}\n`, 'utf8') };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** A v0 ref advertisement (HEAD first, carrying the capabilities; peeled tag lines follow). */
function v0Advertisement(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
    parts.push(pktLine(`${headTip} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement. The body starts with `version 2` (no service preamble). */
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', `agent=${AGENT}\n`, 'object-format=sha1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'flush']);
}

/**
 * GET /info/refs?service=<service>. v2 is served only when the request asked for it with
 * `Git-Protocol: version=2`; receive-pack is always v0.
 */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitHttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(repoName);
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_ADVERTISEMENT, body: v2Advertisement() };
    }
    const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), pktFlush(), v0Advertisement(repo, UPLOAD_V0_CAPS)]);
    return { status: 200, contentType: UPLOAD_ADVERTISEMENT, body };
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), pktFlush(), v0Advertisement(repo, RECEIVE_V0_CAPS)]);
    return { status: 200, contentType: RECEIVE_ADVERTISEMENT, body };
  }
  return badRequest(`unknown service ${JSON.stringify(service)}`);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  /** The client's current shallow boundaries (its `shallow` lines). */
  shallow: string[];
  depth: number | null;
}

interface FetchOutcome {
  pack: Buffer | null;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Commit distances from the wants (peeling tags), recorded up to `depth` (inclusive) when a
 * depth limit is set, fully otherwise. A commit is covered when its distance is < depth.
 */
function commitDistances(repo: Repo, wants: readonly string[], depth: number | null): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  let head = 0;
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (!distances.has(commit)) {
      distances.set(commit, 0);
      queue.push([commit, 0]);
    }
  }
  while (head < queue.length) {
    const [oid, dist] = queue[head];
    head += 1;
    if (depth !== null && dist >= depth) continue; // recorded, but not expanded
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) {
        distances.set(parent, dist + 1);
        queue.push([parent, dist + 1]);
      }
    }
  }
  return distances;
}

/**
 * Reachability with a cut: from `roots`, follow commit->tree, tree->entries, tag->target.
 * A commit is only *entered* (included, with its tree) when `enter(commit)` is true; its
 * parents are only followed when `followParents(commit)` is true. Used for the depth-limited
 * covered set (enter/follow only covered commits) and for the client's held set (enter every
 * have, but never follow a shallow boundary's parents).
 */
function collectWithCut(
  repo: Repo,
  roots: readonly string[],
  enter: (commitOid: string) => boolean,
  followParents: (commitOid: string) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    // An excluded commit is never part of the set — not even as a bare object.
    if (object.type === 'commit' && !enter(oid)) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (followParents(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (!targetObject) continue;
      // The target is pushed unconditionally; a commit target is admitted only by `enter`
      // when it is popped, so a tag to an excluded commit leaks nothing.
      queue.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function planFetch(repo: Repo, request: FetchRequest): FetchOutcome {
  const { wants, haves, shallow, depth } = request;
  const distances = commitDistances(repo, wants, depth);
  const coveredCommits = new Set<string>();
  const boundary = new Set<string>();
  for (const [oid, dist] of distances) {
    if (depth !== null && dist >= depth) continue;
    coveredCommits.add(oid);
    if (depth === null) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      const parentDist = distances.get(parent);
      if (parentDist !== undefined && parentDist >= depth) boundary.add(oid);
    }
  }
  // The covered set: everything reachable from the covered commits (plus non-commit wants,
  // i.e. tag objects), without crossing into excluded parents.
  const coveredRoots = [...coveredCommits];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type !== 'commit') coveredRoots.push(want);
  }
  const covered = collectWithCut(repo, coveredRoots, (commit) => coveredCommits.has(commit), (commit) => coveredCommits.has(commit));
  // The held set: everything reachable from the haves, except the parents of the client's
  // shallow boundaries (a shallow clone does not hold those).
  const oldBoundary = new Set(shallow);
  const held = collectWithCut(repo, haves, () => true, (commit) => !oldBoundary.has(commit));
  const send: string[] = [];
  for (const oid of covered) if (!held.has(oid)) send.push(oid);
  send.sort();
  const objects = send.map((oid) => repo.objects.get(oid)!).filter(Boolean);
  const pack = objects.length === 0 ? null : writePack(objects);
  const unshallow: string[] = [];
  for (const oid of oldBoundary) if (!boundary.has(oid)) unshallow.push(oid);
  unshallow.sort();
  // Acknowledged haves: ones that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (wants.some((want) => isAncestor(repo, have, peelToCommit(repo, want)))) acks.push(have);
  }
  return { pack, shallow: [...boundary].sort(), unshallow, acks };
}

function fetchCacheKey(request: FetchRequest): string {
  const sorted = (values: readonly string[]): string[] => [...values].sort();
  return JSON.stringify({
    w: sorted(request.wants),
    h: sorted(request.haves),
    s: sorted(request.shallow),
    d: request.depth,
  });
}

function cachedFetch(repo: Repo, request: FetchRequest): FetchOutcome {
  const key = fetchCacheKey(request);
  const cached: CachedFetch | undefined = repo.fetchCache.get(key);
  if (cached) return { pack: cached.pack.length === 0 ? null : cached.pack, shallow: cached.shallow, unshallow: cached.unshallow, acks: cached.acks };
  const outcome = planFetch(repo, request);
  if (repo.fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, {
    pack: outcome.pack ?? Buffer.alloc(0),
    shallow: outcome.shallow,
    unshallow: outcome.unshallow,
    acks: outcome.acks,
  });
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

/** Split `data` into sideband band-1 packets (each a pkt-line: band byte + <=32 KiB of data). */
function sidebandPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, offset + SIDEBAND_CHUNK);
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    packets.push(pktLine(payload));
  }
  return packets;
}

/** The v2 fetch response: acknowledgments, shallow-info, packfile — each section delim-ended. */
function v2FetchResponse(outcome: FetchOutcome): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (outcome.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of outcome.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktDelim());
  if (outcome.shallow.length > 0 || outcome.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of outcome.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of outcome.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (outcome.pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(outcome.pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response: shallow/unshallow lines, NAK/ACK, then the sideband pack. */
function v0FetchResponse(outcome: FetchOutcome): Buffer {
  const parts: Buffer[] = [];
  for (const oid of outcome.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of outcome.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (outcome.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of outcome.acks) parts.push(pktLine(`ACK ${ack}\n`));
  if (outcome.pack !== null) parts.push(...sidebandPackets(outcome.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    // An empty repo reports only its unborn HEAD (when the client asked for unborn refs).
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    }
  } else {
    if (args.symrefs && keep('HEAD')) {
      const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
      if (headTip !== undefined) {
        parts.push(pktLine(`${headTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
      } else if (args.unborn) {
        parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
      }
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const object = repo.objects.get(ref.oid);
        if (object?.type === 'tag') line += ` peeled:${peelToCommit(repo, ref.oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/** Parse a v2 upload-pack request: `command=<name>`, preamble lines, delim, arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) lines.push(text);
    else args.push(text);
  }
  const commandLine = lines[0] ?? '';
  if (!commandLine.startsWith('command=')) throw new Error(`v2 request has no command line (saw ${JSON.stringify(commandLine.slice(0, 40))})`);
  return { command: commandLine.slice('command='.length), args };
}

/** Parse a v0 upload-pack request: wants (+shallow/deepen) before the flush, haves after it. */
function parseV0FetchRequest(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0];
        if (isOid(oid)) wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isOid(oid)) shallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const value = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isInteger(value) && value > 0) depth = value;
      }
      // deepen-since / deepen-not / filter are not offered; ignore them if sent.
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    }
    // 'done' ends the negotiation; nothing to record.
  }
  return { wants, haves, shallow, depth };
}

function parseV2FetchArgs(args: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(value) && value > 0) depth = value;
    }
    // thin-pack / no-progress / ofs-delta / done are instructions, not data.
  }
  return { wants, haves, shallow, depth };
}

/**
 * POST /git-upload-pack. v2 when the request asked for it (or its first line is a v2 command),
 * v0 otherwise. A malformed body is a 400 — never a crash.
 */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  gitProtocol: string | undefined,
  body: Buffer,
): GitHttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(repoName);
  let parsed: { command: string; args: string[] } | null = null;
  const looksV2 = gitProtocol === 'version=2';
  if (looksV2) {
    try {
      parsed = parseV2Request(body);
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'unparsable v2 request');
    }
  } else {
    // Defensive sniff: a v2-shaped body without the header is still a v2 request.
    try {
      const { packets } = decodePktLines(body);
      const first = packets.find((packet) => packet.kind === 'data');
      if (first && first.kind === 'data' && first.payload.toString('utf8').startsWith('command=')) {
        parsed = parseV2Request(body);
      }
    } catch {
      return badRequest('unparsable pkt-line stream');
    }
  }
  if (parsed !== null) {
    if (parsed.command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of parsed.args) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, args) };
    }
    if (parsed.command === 'fetch') {
      const request = parseV2FetchArgs(parsed.args);
      if (request.wants.length === 0) return badRequest('fetch has no wants');
      const outcome = cachedFetch(repo, request);
      return { status: 200, contentType: UPLOAD_RESULT, body: v2FetchResponse(outcome) };
    }
    return badRequest(`unsupported v2 command ${JSON.stringify(parsed.command)}`);
  }
  let request: FetchRequest;
  try {
    request = parseV0FetchRequest(body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'unparsable v0 request');
  }
  if (request.wants.length === 0) return badRequest('fetch has no wants');
  const outcome = cachedFetch(repo, request);
  return { status: 200, contentType: UPLOAD_RESULT, body: v0FetchResponse(outcome) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: pkt-lined commands + flush, then the pack bytes. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, offset } = decodePktLines(body, { stopAtRaw: true });
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul); // the first command carries the capabilities
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('push has no commands');
  return { commands, pack: body.subarray(offset) };
}

/** The report-status stream, pkt-lined, inside sideband band 1. */
function pushReportResponse(lines: string[]): Buffer {
  const inner = pktLines([...lines.map((line) => `${line}\n`), 'flush']);
  return Buffer.concat([...sidebandPackets(inner), pktFlush()]);
}

/**
 * POST /git-receive-pack. The pack is unpacked (and its objects stored) even when every ref
 * update is refused; each command is then judged in order against the refs as they stand, and
 * only the accepted ones move. A refused non-fast-forward carries the exact reason
 * `non-fast-forward`.
 */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitHttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(repoName);
  let commands: PushCommand[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parsePush(body));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'unparsable push');
  }
  // Unpack first: a refused update must still unpack, and its objects stay in the store.
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unparsable pack';
      const lines = [`unpack error ${detail}`, ...commands.map((command) => `ng ${command.ref} unpack failed`)];
      return { status: 200, contentType: RECEIVE_RESULT, body: pushReportResponse(lines) };
    }
  }
  const report: string[] = ['unpack ok'];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${command.ref} no such ref`);
      } else if (current !== command.oldOid) {
        report.push(`ng ${command.ref} stale info`);
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      report.push(`ng ${command.ref} object not found`);
      continue;
    }
    // A branch tip must be a commit; an annotated tag pushed to a branch peels to its commit.
    let newTip = command.newOid;
    if (command.ref.startsWith('refs/heads/')) {
      if (target.type === 'tag') newTip = peelToCommit(repo, command.newOid);
      else if (target.type !== 'commit') {
        report.push(`ng ${command.ref} not a commit`);
        continue;
      }
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push(`ng ${command.ref} stale info`);
        continue;
      }
      repo.refs.set(command.ref, newTip);
      changed = true;
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (!isAncestor(repo, current, newTip)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, newTip);
    changed = true;
    report.push(`ok ${command.ref}`);
  }
  if (changed) store.touch(repo);
  return { status: 200, contentType: RECEIVE_RESULT, body: pushReportResponse(report) };
}
