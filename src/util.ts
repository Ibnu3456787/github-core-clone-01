// Small shared helpers: hashing, base64, pkt-line framing, deterministic time and ids.
//
// Determinism rule (the trial replays every scored run): no wall clock and no
// unseeded randomness anywhere a response can carry it. Every timestamp comes
// from MAKEFUN_TRIAL_NOW (or a fixed fallback when the variable is absent, e.g.
// a local run), and request ids are a plain counter.

import { createHash } from 'node:crypto';

/** SHA-1 of `data`, lowercase hex. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True for a lowercase 40-hex object id. */
const OID_RE = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0'.repeat(40);

/** Base64 (standard alphabet) of a UTF-8 string. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64, ignoring the whitespace GitHub wraps it with. */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------------------------
// deterministic time
// ---------------------------------------------------------------------------------------------

/** The trial's opening time, the only "now" a response may carry. */
const FALLBACK_NOW = '2026-11-21T06:30:00.000Z';

function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.parse(FALLBACK_NOW);
}

const NOW_MS = trialNowMs();

/** The trial now as an ISO-8601 string (created_at/updated_at/merged_at). */
/** The trial now as an ISO string (a module constant: NOW_MS never changes). */
const NOW_ISO = new Date(NOW_MS).toISOString();

export function trialNowIso(): string {
  return NOW_ISO;
}

/** The trial now as Unix seconds (commit author/committer lines). */
export function trialNowEpochSec(): number {
  return Math.floor(NOW_MS / 1000);
}

// ---------------------------------------------------------------------------------------------
// request ids (deterministic: a per-process counter, never random)
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

/** A non-empty, deterministic request id for X-GitHub-Request-Id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing (git's wire format: 4 hex length bytes, then the payload)
// ---------------------------------------------------------------------------------------------

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte header. */
export const PKT_LINE_MAX = 65520;
/** The largest sideband data chunk: header (4) + band byte (1) + payload. */
export const SIDEBAND_CHUNK = 32768;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet (0002). */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** One decoded pkt-line. */
export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the head of `buffer`. Stops at the first flush (returning it) or at
 * `stopAtRaw` when the next bytes are not a pkt-line header (a raw pack follows a flush in
 * receive-pack). Returns the packets and the offset just past the last one consumed.
 */
export function decodePktLines(
  buffer: Buffer,
  options: { stopAtRaw?: boolean } = {},
): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) {
      if (options.stopAtRaw === true) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// opaque cursors (GraphQL pagination): base64 of a plain "c:<seq>" token
// ---------------------------------------------------------------------------------------------

export function encodeCursor(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    if (match === null) return null;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// opaque global ids (GraphQL Relay): base64 of "Type:key" — never the plain database id
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    const key = text.slice(colon + 1);
    if (!/^[A-Za-z]+$/.test(kind) || key === '') return null;
    // Round-trip check: the id must be exactly this encoding (rejects lookalikes).
    if (encodeGlobalId(kind, key) !== id) return null;
    return { kind, key };
  } catch {
    return null;
  }
}
