/**
 * Base Builder Code attribution (ERC-8021).
 *
 * Every Base transaction the relay signs carries Provian's Builder Code appended to its calldata, so
 * Base credits the activity to Provian. The suffix is read backwards from the end of the calldata:
 *
 *   calldata ‖ codes (ASCII, comma-separated) ‖ codesLength (1 byte) ‖ schemaId 0x00 ‖ 16-byte marker
 *
 * A contract call never sees it: ABI decoding ignores bytes past the arguments it reads. A plain value
 * transfer carries it only to an address with no code (`attributableTransfer`), and one whose input is
 * only an attribution suffix is still a plain transfer, so every reader that classifies a transaction
 * by its input strips the suffix first (`stripAttribution`).
 *
 * The same module lives in the agent SDK, the x402 facilitator, the operator scripts and the mobile
 * app; each package is built and shipped on its own. `scripts/check-builder-code-copies.mjs` keeps
 * every copy byte-identical.
 */

/** Provian's Base Builder Code, registered on base.dev. */
export const PROVIAN_BUILDER_CODE = 'bc_z0yux7pu';

/** The ERC-8021 marker: the last 16 bytes of an attributed transaction's calldata. */
export const ERC8021_MARKER = '80218021802180218021802180218021';
const SCHEMA_CANONICAL = '00';
const CODE = /^[\x21-\x2b\x2d-\x7e]+$/; // printable ASCII without the comma separator

/** Base mainnet and Base Sepolia. */
export const BASE_CHAIN_IDS: ReadonlySet<bigint> = new Set([8453n, 84532n]);

export function isBaseChainId(chainId: bigint | number | string | null | undefined): boolean {
  if (chainId === null || chainId === undefined) return false;
  try { return BASE_CHAIN_IDS.has(BigInt(chainId)); } catch { return false; }
}

function hexBody(data: string | null | undefined): string {
  if (data === null || data === undefined || data === '' || data === '0x') return '';
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('builder_code_calldata_invalid');
  return data.slice(2);
}

function asciiHex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

function hexAscii(hex: string): string {
  let text = '';
  for (let i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return text;
}

/** The ERC-8021 schema-0 suffix for `codes`, as hex without 0x. */
export function attributionSuffix(codes: readonly string[]): string {
  if (codes.length === 0) throw new Error('builder_code_codes_empty');
  for (const code of codes) if (!CODE.test(code)) throw new Error('builder_code_invalid');
  const joined = asciiHex(codes.join(','));
  const length = joined.length / 2;
  if (length > 255) throw new Error('builder_code_codes_too_long');
  return `${joined}${length.toString(16).padStart(2, '0')}${SCHEMA_CANONICAL}${ERC8021_MARKER}`;
}

/**
 * Parse a trailing ERC-8021 schema-0 attribution. Returns the calldata before the suffix and the
 * codes, or null when the input carries no well-formed schema-0 suffix.
 */
export function parseAttribution(data: string | null | undefined): { calldata: string; codes: string[] } | null {
  if (data !== null && data !== undefined && typeof data !== 'string') return null;
  if (typeof data === 'string' && data !== '' && !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return null; // not calldata: no attribution
  const body = hexBody(data).toLowerCase();
  const fixed = ERC8021_MARKER.length + 4; // marker + schema byte + length byte
  if (body.length < fixed + 2 || !body.endsWith(ERC8021_MARKER)) return null;
  const schema = body.slice(body.length - ERC8021_MARKER.length - 2, body.length - ERC8021_MARKER.length);
  if (schema !== SCHEMA_CANONICAL) return null;
  const length = parseInt(body.slice(body.length - fixed, body.length - fixed + 2), 16);
  if (length === 0 || body.length < fixed + length * 2) return null;
  const codesHex = body.slice(body.length - fixed - length * 2, body.length - fixed);
  const codes = hexAscii(codesHex).split(',');
  if (codes.some((code) => !CODE.test(code))) return null;
  const original = hexBody(data);
  return { calldata: `0x${original.slice(0, original.length - fixed - length * 2)}`, codes };
}

/** The calldata with any trailing ERC-8021 schema-0 attribution removed (`0x` for an attribution-only input). */
export function stripAttribution(data: string): string {
  return parseAttribution(data)?.calldata ?? data;
}

/** True when the input is empty or carries nothing but an attribution suffix: a plain transfer. */
export function isPlainTransferInput(data: string): boolean {
  const input = data.toLowerCase();
  return input === '0x' || stripAttribution(input) === '0x';
}

/**
 * The calldata carrying Provian's Builder Code. Idempotent: calldata that already carries it is
 * returned unchanged; calldata that carries other schema-0 codes keeps them and gains Provian's.
 */
export function withBuilderCode(data: string | null | undefined, code: string = PROVIAN_BUILDER_CODE): string {
  const parsed = parseAttribution(data ?? '0x');
  if (parsed?.codes.includes(code)) return data as string;
  const calldata = parsed ? parsed.calldata : `0x${hexBody(data)}`;
  return `${calldata}${attributionSuffix(parsed ? [...parsed.codes, code] : [code])}`;
}

/** True when the calldata carries Provian's Builder Code. */
export function carriesBuilderCode(data: string | null | undefined, code: string = PROVIAN_BUILDER_CODE): boolean {
  return parseAttribution(data ?? '0x')?.codes.includes(code) ?? false;
}

/**
 * Signed calldata is exactly the planned call: either the planned bytes themselves (a record signed
 * before attribution) or the planned bytes carrying Provian's Builder Code. Nothing else matches.
 */
export function matchesPlannedCall(signed: string | null | undefined, planned: string): boolean {
  if (typeof signed !== 'string') return false;
  const s = signed.toLowerCase();
  return s === planned.toLowerCase() || s === withBuilderCode(planned).toLowerCase();
}

/** EIP-7623 calldata tokens: one per zero byte, four per non-zero byte. */
function calldataTokens(hex: string): bigint {
  let tokens = 0n;
  for (let i = 0; i < hex.length; i += 2) tokens += hex.slice(i, i + 2) === '00' ? 1n : 4n;
  return tokens;
}

/**
 * The gas a fixed limit must add when the Builder Code is appended to `data`. Base runs Prague with
 * EIP-7623: a transaction's limit must cover both 4 gas per calldata token plus execution and the
 * calldata floor of 21,000 + 10 gas per token. A limit that was valid for `data` is at least its
 * floor, so adding 10 gas per added token keeps it above both. A limit fixed rather than estimated —
 * a 21,000-gas nonce cancellation, a dApp's own gas field — adds this.
 */
export function builderCodeGas(data: string | null | undefined = '0x'): bigint {
  return 10n * (calldataTokens(hexBody(withBuilderCode(data))) - calldataTokens(hexBody(data)));
}

/** A self-send that only burns a nonce, carrying the Builder Code: exactly its EIP-7623 calldata floor. */
export const ATTRIBUTED_CANCELLATION_GAS = 21_000n + builderCodeGas('0x');

/** The planned call behind calldata Provian signed: its Builder Code removed, anything else left as is. */
export function withoutBuilderCode(data: string, code: string = PROVIAN_BUILDER_CODE): string {
  const parsed = parseAttribution(data);
  return parsed && parsed.codes.length === 1 && parsed.codes[0] === code ? parsed.calldata : data;
}

/**
 * Targets that consume calldata raw instead of ABI-decoding it. The CREATE2 deployers treat every
 * byte after the salt as init code, so a suffix would change the deployed address.
 */
const RAW_CALLDATA_TARGETS: ReadonlySet<string> = new Set([
  '0x4e59b44847b379578588920ca78fbf26c0b4956c', // deterministic deployment proxy
  '0x914d7fec6aac8cd542e72bca78b30650d45643d7', // Safe singleton factory
]);

/**
 * True when a transaction to `to` can carry the Builder Code without changing what it does: a call
 * to an address. A contract creation (no `to`) appends nothing to init code, and a raw-calldata
 * target such as the CREATE2 deployer is sent exactly as planned.
 */
export function attributableTarget(to: string | null | undefined): boolean {
  return typeof to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(to) && !RAW_CALLDATA_TARGETS.has(to.toLowerCase());
}

/** `withBuilderCode` for a call to `to`, or the data unchanged when the target cannot carry it. */
export function withBuilderCodeFor(to: string | null | undefined, data: string | null | undefined): string {
  return attributableTarget(to) ? withBuilderCode(data) : (data ?? '0x');
}

/**
 * True when a call with `data` to a recipient whose code is `recipientCode` can carry the Builder
 * Code. A plain value transfer (no calldata) to a contract cannot: Solidity runs `receive()` only for
 * empty calldata, so a suffix would send the payment to `fallback()` instead, which a receive-only
 * or non-payable-fallback contract refuses. It is attributed only to an address with no code. An
 * unknown recipient code is treated as a contract.
 */
export function attributableTransfer(data: string | null | undefined, recipientCode: string | null | undefined): boolean {
  return hexBody(data) !== '' || (typeof recipientCode === 'string' && hexBody(recipientCode) === '');
}
