/**
 * Minimal CBOR decoder (RFC 8949) — enough for COSE_Sign1 (AWS Nitro) and WebAuthn/App Attest
 * attestation objects: unsigned/negative ints, byte strings, text strings, arrays, maps, tags,
 * simple values (false/true/null) and floats. Indefinite-length items are refused (neither
 * producer emits them). Fail-closed: any malformed input throws.
 */

export class CborTag {
  constructor(public readonly tag: number, public readonly value: CborValue) {}
}

export type CborValue =
  | number
  | bigint
  | string
  | Buffer
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborTag;

const MAX_DEPTH = 32;

export function decodeCbor(input: Buffer): CborValue {
  let offset = 0;
  const readUint = (bytes: number): number | bigint => {
    if (offset + bytes > input.length) throw new Error('cbor_truncated');
    let v: bigint = 0n;
    for (let i = 0; i < bytes; i += 1) v = (v << 8n) | BigInt(input[offset + i]);
    offset += bytes;
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  const readArg = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) return readUint(1);
    if (info === 25) return readUint(2);
    if (info === 26) return readUint(4);
    if (info === 27) return readUint(8);
    throw new Error('cbor_indefinite_or_reserved');
  };
  const toLen = (n: number | bigint): number => {
    if (typeof n === 'bigint' || n > input.length) throw new Error('cbor_length_out_of_range');
    return n;
  };
  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new Error('cbor_depth');
    if (offset >= input.length) throw new Error('cbor_truncated');
    const initial = input[offset];
    offset += 1;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0: return readArg(info);
      case 1: {
        const n = readArg(info);
        return typeof n === 'bigint' ? -1n - n : -1 - n;
      }
      case 2: {
        const len = toLen(readArg(info));
        if (offset + len > input.length) throw new Error('cbor_truncated');
        const out = input.subarray(offset, offset + len);
        offset += len;
        return Buffer.from(out);
      }
      case 3: {
        const len = toLen(readArg(info));
        if (offset + len > input.length) throw new Error('cbor_truncated');
        const out = input.subarray(offset, offset + len).toString('utf8');
        offset += len;
        return out;
      }
      case 4: {
        const len = toLen(readArg(info));
        const arr: CborValue[] = [];
        for (let i = 0; i < len; i += 1) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const len = toLen(readArg(info));
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < len; i += 1) {
          const k = item(depth + 1);
          const v = item(depth + 1);
          map.set(k, v);
        }
        return map;
      }
      case 6: {
        const tag = readArg(info);
        if (typeof tag === 'bigint') throw new Error('cbor_tag_out_of_range');
        return new CborTag(tag, item(depth + 1));
      }
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) { const b = input.subarray(offset, offset + 2); offset += 2; return halfToNumber(b); }
        if (info === 26) { const v = input.readFloatBE(offset); offset += 4; return v; }
        if (info === 27) { const v = input.readDoubleBE(offset); offset += 8; return v; }
        throw new Error('cbor_simple_unsupported');
      }
      default:
        throw new Error('cbor_major_unsupported');
    }
  };
  const value = item(0);
  if (offset !== input.length) throw new Error('cbor_trailing_bytes');
  return value;
}

function halfToNumber(b: Buffer): number {
  if (b.length < 2) throw new Error('cbor_truncated');
  const half = (b[0] << 8) | b[1];
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  let val: number;
  if (exp === 0) val = mant * 2 ** -24;
  else if (exp !== 31) val = (mant + 1024) * 2 ** (exp - 25);
  else val = mant === 0 ? Infinity : NaN;
  return half & 0x8000 ? -val : val;
}

/** Minimal CBOR encoder for the handful of shapes a COSE Sig_structure needs. */
export function encodeCbor(value: CborValue): Buffer {
  const parts: Buffer[] = [];
  const head = (major: number, n: number): void => {
    if (n < 24) parts.push(Buffer.from([(major << 5) | n]));
    else if (n < 0x100) parts.push(Buffer.from([(major << 5) | 24, n]));
    else if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); parts.push(b); }
    else if (n < 0x1_0000_0000) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); parts.push(b); }
    else if (Number.isSafeInteger(n)) { const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); parts.push(b); }
    else throw new Error('cbor_encode_too_large');
  };
  const enc = (v: CborValue): void => {
    if (typeof v === 'number' && Number.isInteger(v)) {
      if (v >= 0) head(0, v); else head(1, -1 - v);
    } else if (typeof v === 'string') {
      const b = Buffer.from(v, 'utf8'); head(3, b.length); parts.push(b);
    } else if (Buffer.isBuffer(v)) {
      head(2, v.length); parts.push(v);
    } else if (Array.isArray(v)) {
      head(4, v.length); for (const x of v) enc(x);
    } else if (v instanceof Map) {
      head(5, v.size); for (const [k, x] of v) { enc(k); enc(x); }
    } else if (v === true) parts.push(Buffer.from([0xf5]));
    else if (v === false) parts.push(Buffer.from([0xf4]));
    else if (v === null) parts.push(Buffer.from([0xf6]));
    else throw new Error('cbor_encode_unsupported');
  };
  enc(value);
  return Buffer.concat(parts);
}

/** Read a string-keyed map entry (CBOR maps may use text keys). */
export function mapGet(map: CborValue, key: string | number): CborValue | undefined {
  if (!(map instanceof Map)) return undefined;
  for (const [k, v] of map) if (k === key) return v;
  return undefined;
}
