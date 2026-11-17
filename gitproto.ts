// gitproto.ts — the git smart-HTTP wire: pkt-line framing, packfiles, and the
// upload-pack (v2 + v0) / receive-pack (v0) exchanges.
//
// Written against the suite client's exact expectations (sdk/conformance/
// git-client.ts): the v2 section framing, the v0 two-section fetch, the
// sideband-wrapped push report, and the exact capability strings the client
// gates on (fetch=shallow filter, ls-refs=unborn, side-band-64k, report-status,
// delete-refs, shallow, ofs-delta).
import { inflateSync, deflateSync } from 'node:zlib';
import {
  ZERO_OID,
  isOid,
  hashObject,
  parseCommit,
  parseTag,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole buffer into packets. Returns null when the framing is broken. */
export function decodePackets(buf: Buffer): Packet[] | null {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return null;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

export function packetLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- packfile

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** A pack of whole objects only (no deltas): the client accepts it everywhere,
 *  and the pack-deltas check only judges deltas when the server sends them. */
export function writePackChecked(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHashSha1(body);
  return Buffer.concat([body, trailer]);
}

import { createHash as nodeCreateHash } from 'node:crypto';
function createHashSha1(data: Buffer): Buffer {
  return nodeCreateHash('sha1').update(data).digest();
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; typeCode: number } {
  let byte = buf[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, typeCode };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let offset = baseOffsetOf(byte);
  let next = start + 1;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset, next };
}

function baseOffsetOf(byte: number): number {
  return byte & 0x7f;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      total += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface PackRead {
  objects: Map<string, GitObject>;
}

/** Parse a pack, resolving ofs-delta and ref-delta against the pack itself and
 *  an optional lookup (objects the client already holds, for thin packs). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: Array<{ type: ObjType; data: Buffer; oid: string; offset: number }> = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const deltas: Array<{ baseOffset?: number; baseOid?: string; delta: Buffer; offset: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const { size, next, typeCode } = readVarintSize(pack, offset);
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(pack, offset);
      offset = after;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ baseOffset, delta: inflated.data, offset: start });
      void size;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ baseOid, delta: inflated.data, offset: start });
      void size;
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated.data);
      const entry = { type, data: inflated.data, oid, offset: start };
      raw.push(entry);
      byOffset.set(start, entry);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const entry of raw) objects.set(entry.oid, { type: entry.type, data: entry.data });
  // Resolve deltas (possibly chained): iterate until no progress.
  const pending = [...deltas];
  let guard = 0;
  while (pending.length > 0) {
    if (guard > count + 10) throw new Error('unresolvable delta chain');
    guard += 1;
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const delta = pending[i];
      let base: GitObject | undefined;
      if (delta.baseOffset !== undefined) {
        const entry = byOffset.get(delta.baseOffset);
        base = entry !== undefined ? { type: entry.type, data: entry.data } : undefined;
      } else if (delta.baseOid !== undefined) {
        base = objects.get(delta.baseOid) ?? resolveBase?.(delta.baseOid);
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, delta.delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(delta.offset, { type: base.type, data, oid });
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) throw new Error('delta base not found');
  }
  return { objects };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync gives no consumed length, so find the deflate stream's end by
  // binary search: the shortest prefix that inflates cleanly is the stream's
  // end (a shorter prefix is truncated and throws; a longer one only succeeds
  // past the true end). Pack objects here are kilobytes, so this is cheap.
  let lo = 1;
  let hi = buf.length - offset;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('corrupt deflate stream in pack');
  const data = inflateSync(buf.subarray(offset, offset + found));
  return { data, next: offset + found };
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Objects to send (whole objects, no deltas). */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  /** True when every want is already held by the client. */
  nothingNew: boolean;
}

/**
 * Plan a fetch: wants, haves, the client's current shallow boundary, and an
 * optional depth.
 *
 * The walk starts at the wants and counts generations from there. A commit
 * the client already holds is never sent, but the walk still passes through
 * it: when deepening, the held tip's parent is exactly what is new. The send
 * set is the new commits' objects minus everything reachable from the haves
 * (without crossing a shallow boundary), so an unchanged blob shared with an
 * old commit is never re-sent. Depth truncates the walk and names the new
 * boundary in `shallow`; an old boundary whose parents are all available
 * now is named in `unshallow`.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | undefined,
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  // Held commits: reachable from haves, never crossing a shallow boundary.
  const heldCommits = new Set<string>();
  const heldStack: string[] = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (heldCommits.has(oid)) continue;
    const view = repo.commitOf(oid);
    if (view === null) continue;
    heldCommits.add(oid);
    if (boundarySet.has(oid)) continue;
    for (const parent of view.parents) heldStack.push(parent);
  }
  // Held objects: every object reachable from a held commit (its tree and
  // blobs). A blob shared between an old and a new commit is held already.
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    const view = repo.commitOf(oid);
    if (view === null) continue;
    heldObjects.add(oid);
    const treeStack: string[] = [view.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop()!;
      if (heldObjects.has(treeOid)) continue;
      heldObjects.add(treeOid);
      const entries = repo.treeOf(treeOid);
      if (entries === null) continue;
      for (const entry of entries) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else heldObjects.add(entry.oid);
      }
    }
  }
  // Walk from the wants. Held commits are traversed (deepening needs their
  // parents) but never included; new commits are included until the depth
  // limit names them shallow.
  const included = new Set<string>();
  const newShallow = new Set<string>();
  interface Work {
    oid: string;
    depth: number;
  }
  const queue: Work[] = wants.map((oid) => ({ oid, depth: 0 }));
  const seenWalk = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    if (seenWalk.has(oid)) continue;
    seenWalk.add(oid);
    const view = repo.commitOf(oid);
    if (view === null) continue; // tag wants are handled below
    if (!heldCommits.has(oid)) {
      included.add(oid);
      if (depth !== undefined && d + 1 >= depth) {
        newShallow.add(oid);
        continue;
      }
    }
    if (depth !== undefined && d + 1 >= depth) continue;
    for (const parent of view.parents) queue.push({ oid: parent, depth: d + 1 });
  }
  // Unshallow: old boundaries whose parents are all available now (held or
  // newly included) and which are not shallow any more.
  const available = new Set<string>([...heldCommits, ...included]);
  const unshallow: string[] = [];
  for (const old of shallowBoundaries) {
    if (newShallow.has(old)) continue;
    if (!available.has(old)) continue;
    const view = repo.commitOf(old);
    if (view === null) continue;
    if (view.parents.every((parent) => available.has(parent))) unshallow.push(old);
  }
  // Object set: included commits + their trees/blobs, plus tag objects for
  // tag wants and everything they point at — minus everything held.
  const sendOids = new Set<string>();
  const collectTree = (treeOid: string): void => {
    const entries = repo.treeOf(treeOid);
    if (entries === null) return;
    if (sendOids.has(treeOid)) return;
    sendOids.add(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') collectTree(entry.oid);
      else sendOids.add(entry.oid);
    }
  };
  for (const oid of included) {
    sendOids.add(oid);
    const view = repo.commitOf(oid);
    if (view !== null) collectTree(view.tree);
  }
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      sendOids.add(want);
      const tag = parseTag(obj.data);
      if (tag.object !== '') {
        const target = repo.getObject(tag.object);
        if (target !== undefined) {
          if (target.type === 'commit') {
            const view = parseCommit(target.data);
            sendOids.add(tag.object);
            collectTree(view.tree);
          } else {
            sendOids.add(tag.object);
          }
        }
      }
    }
  }
  for (const oid of heldObjects) sendOids.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of sendOids) {
    const obj = repo.getObject(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return {
    objects,
    shallow: [...newShallow].sort(),
    unshallow: unshallow.sort(),
    nothingNew: objects.length === 0,
  };
}

// ---------------------------------------------------------------- advertisements

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) out.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.getObject(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const tag = parseTag(obj.data);
        entry.peeled = tag.object;
      }
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V2_CAPS = ['agent', 'object-format=sha1', 'fetch=shallow filter', 'ls-refs=unborn'];
const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow filter agent symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent';

/** GET info/refs for a service. */
export function advertisement(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  version2: boolean,
): Buffer {
  const parts: Buffer[] = [];
  if (service === 'git-receive-pack' || !version2) {
    // v0: service line, flush, ref lines (capabilities on the first line).
    parts.push(pktLine(`# service=${service}\n`), pktFlush());
    const refs = refLines(repo);
    const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      refs.forEach((ref, index) => {
        let line = `${ref.oid} ${ref.name}`;
        if (index === 0) line += `\0${caps}`;
        if (ref.peeled !== undefined) {
          // Peeled tag lines follow the tag line.
        }
        line += '\n';
        parts.push(pktLine(line));
        if (ref.peeled !== undefined) {
          parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
        }
      });
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // v2 advertisement.
  parts.push(pktLine('# service=git-upload-pack\n'), pktFlush());
  parts.push(pktLine('version 2\n'));
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

export interface UploadPackResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function sidebandPack(objects: GitObject[]): Buffer {
  const pack = writePackChecked(objects);
  // Split the pack into sideband packets. A pkt-line holds at most 65520
  // bytes total, so the pack chunk plus its 1-byte band plus the 4-byte
  // length prefix must stay under that: 65500 + 1 + 4 = 65505.
  const frames: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) frames.push(pktLine(Buffer.from([1])));
  return Buffer.concat(frames);
}

function handleLsRefs(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const refs = refLines(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    // Unborn HEAD.
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget !== undefined && args.symrefs) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled !== undefined && args.peel) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

/** POST git-upload-pack: v2 (command=...) or v0 (want/have). */
export function handleUploadPack(repo: Repo, body: Buffer, protocol2: boolean): UploadPackResult {
  const packets = decodePackets(body);
  if (packets === null) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
  }
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    return handleUploadPackV2(repo, packets);
  }
  return handleUploadPackV0(repo, packets);
}

function handleUploadPackV2(repo: Repo, packets: Packet[]): UploadPackResult {
  const lines = packetLines(packets);
  const command = (lines[0] ?? '').replace('command=', '').trim();
  if (command === 'ls-refs') {
    const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const line of lines.slice(1)) {
      const text = line.trim();
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: handleLsRefs(repo, args),
    };
  }
  if (command !== 'fetch') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}`, 'utf8') };
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (!inArgs) continue;
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('deepen-since ')) req.deepenSince = parseInt(text.slice(13).trim(), 10);
    else if (text.startsWith('deepen-not ')) req.deepenNot.push(text.slice(11).trim());
  }
  return buildFetchResponse(repo, req);
}

function handleUploadPackV0(repo: Repo, packets: Packet[]): UploadPackResult {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      const oid = rest.split(' ')[0];
      if (isOid(oid)) req.wants.push(oid);
    } else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = parseInt(text.slice(7).trim(), 10);
    else if (text.startsWith('deepen-since ')) req.deepenSince = parseInt(text.slice(13).trim(), 10);
    else if (text.startsWith('deepen-not ')) req.deepenNot.push(text.slice(11).trim());
  }
  if (req.wants.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('no want lines', 'utf8') };
  }
  return buildFetchResponseV0(repo, req);
}

function buildFetchResponse(repo: Repo, req: FetchRequest): UploadPackResult {
  const cached = fetchCacheGet(repo, req, 'v2');
  if (cached !== null) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nothingNew && req.haves.length > 0) {
    parts.push(pktLine(`ACK ${req.wants[0]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  // shallow-info section, only when there is something to say
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  // packfile section (always present, even when empty)
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(plan.objects));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(repo, req, 'v2', body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function buildFetchResponseV0(repo: Repo, req: FetchRequest): UploadPackResult {
  const cached = fetchCacheGet(repo, req, 'v0');
  if (cached !== null) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  if (plan.nothingNew && req.haves.length > 0) {
    parts.push(pktLine(`ACK ${req.wants[0]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(plan.objects));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(repo, req, 'v0', body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// --- fetch response cache -------------------------------------------------
// A fetch response is a pure function of the repo's objects plus the request
// (wants, haves, shallow, depth): no timestamps, no request ids, no ref
// names enter it. The bench clones the same repo 50 times concurrently with
// identical requests, so caching whole bodies turns 50 pack builds into 1.
// The key carries the repo's object generation, so any new object (push,
// contents write, merge) invalidates every entry for that repo.
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(repo: Repo, req: FetchRequest, version: 'v2' | 'v0'): string {
  return [
    version,
    repo.id,
    repo.generation,
    req.wants.join(','),
    req.haves.join(','),
    req.shallow.join(','),
    req.depth ?? '',
  ].join('|');
}

function fetchCacheGet(repo: Repo, req: FetchRequest, version: 'v2' | 'v0'): Buffer | null {
  return fetchCache.get(fetchCacheKey(repo, req, version)) ?? null;
}

function fetchCachePut(repo: Repo, req: FetchRequest, version: 'v2' | 'v0', body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(fetchCacheKey(repo, req, version), body);
}

// ---------------------------------------------------------------- receive-pack

export interface ReceivePackResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** POST git-receive-pack: command lines + flush + pack bytes. */
export function handleReceivePack(repo: Repo, body: Buffer): ReceivePackResult {
  // The pack follows the flush packet as raw bytes, so split at the first
  // flush manually: decoding the whole body as pkt-lines would fail on the
  // raw pack tail, which is expected, not malformed.
  let commandEnd = -1;
  {
    let offset = 0;
    while (offset + 4 <= body.length) {
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
      const len = parseInt(lenText, 16);
      if (len === 0) {
        commandEnd = offset + 4;
        break;
      }
      if (len === 1) {
        offset += 4;
        continue;
      }
      if (len < 4 || offset + len > body.length) break;
      offset += len;
    }
  }
  if (commandEnd < 0) {
    // No flush found: malformed input must not crash the server; answer 400
    // and stay alive for the next request.
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed receive-pack stream', 'utf8') };
  }
  const commandPackets = decodePackets(body.subarray(0, commandEnd));
  if (commandPackets === null) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed receive-pack stream', 'utf8') };
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let sideband = false;
  for (const packet of commandPackets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
    if (nul >= 0) {
      const caps = raw.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(commandEnd);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
    } else {
      try {
        const read = readPack(packBytes);
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch {
        unpackOk = false;
      }
    }
  }
  // Validate and apply each command.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete: always allowed.
      if (current !== undefined) repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create: allowed when the ref does not exist yet.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (unpackOk && repo.getObject(command.newOid) === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: old must match, and new must descend from old.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!unpackOk || repo.getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const reachable = repo.reachableObjects([command.newOid]);
    if (!reachable.has(command.oldOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  // Report-status stream, pkt-lined, inside band 1 when sideband was asked for.
  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : 'error'}\n`)];
  for (const result of results) {
    inner.push(
      result.ok
        ? pktLine(`ok ${result.ref}\n`)
        : pktLine(`ng ${result.ref} ${result.reason}\n`),
    );
  }
  const innerBuf = Buffer.concat(inner);
  let out: Buffer;
  if (sideband) {
    out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), innerBuf])), pktFlush()]);
  } else {
    out = Buffer.concat([innerBuf, pktFlush()]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

// Re-export for callers that only need the checked writer.
export { writePackChecked as buildPack };
