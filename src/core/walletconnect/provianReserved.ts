/**
 * provianReserved — no external dApp can obtain a wallet-key signature over a Provian
 * relay-auth or recovery message through WalletConnect, whatever the user types (,
 * the reserved service set).
 *
 * The wallet key (secp256k1, BIP-39) that WalletConnect signs with is the SAME key the relay
 * trusts for account-level acts. A signature over any of these is replayable at the relay:
 *
 * - EIP-712 `RelayRecovery{user,timestamp,purpose}` under the "Provian Relay Recovery" domain
 * → `POST /v1/users/recover` rotates the relay credentials (account takeover);
 * - `provian.promise.v1|<phase>|<id>|<digest>` → a human-promise transition;
 * - `stableStringify({action:'link_agent'|'unlink_agent'|'update_beneficiary_share', …})`
 * → a beneficiary link / unlink / share change;
 * - `provian-presentation-v1|v2\n…` → a presentation proof-of-possession;
 * - `Provian proof of control\n…` → an external-address binding;
 * - `Provian Solana proof of control\n…` → a Solana-address binding (ed25519 over the raw
 * message; the app's own Solana key signs it in solanaAddressProof.ts) — refused by an
 * explicit pattern (`provian_solana_proof`) as well as by the "provian" rule, and checked on
 * `solana_signMessage` too, so a future Solana WalletConnect namespace inherits the refusal;
 * - `Provian hire escrow id salt v1` → the depositor's private escrow salt (front-running);
 * - the EIP-712 human-wallet registration proof (`RegisterHumanWallet`, a "Provian" domain).
 *
 * Every Provian EIP-191 format carries the literal "provian" or is a JSON object keyed on the
 * link-consent keys; every Provian EIP-712 format has "Provian" in its domain name and/or a
 * Provian `verifyingContract`. The rule is therefore STRUCTURAL, not a list of today's exact
 * strings, so a format added later is covered the day it ships:
 *
 * personal_sign — every string param (either order: `[message, address]` or `[address,
 * message]`) is read as bytes (0x-hex → bytes, else UTF-8), decoded lossily, NFKC-normalized,
 * stripped of BOM / zero-width / format characters, whitespace and combining marks,
 * case-folded and homoglyph-folded; it is refused if it contains "provian", equals the hire
 * salt message, or is a JSON object carrying a link-consent key.
 *
 * eth_signTypedData(_v1/_v3/_v4) — every param (JSON string or object; the v1 array form
 * too) is refused if any domain string, type name, primaryType or field name/type contains
 * "provian" or names a Provian struct, if `verifyingContract` is a Provian contract the app
 * knows (or is not a plain address at all). (The relay pins the recovery domain name and the
 * `RelayRecovery` struct, so the name checks catch it; a generic `user`+`purpose` message
 * under another app's domain is NOT refused — review.)
 *
 * solana_signMessage — the WalletConnect Solana message param (base58 bytes, or a raw string) is
 * decoded and read exactly like a personal_sign message. TODAY the app advertises ONLY the
 * eip155 namespace (WalletConnectService SUPPORTED_METHODS), so no Solana request is ever
 * served; this classification exists so the day a Solana namespace is added it cannot sign a
 * Provian Solana proof. Solana TRANSACTION methods are not classified and fail closed.
 *
 * Any other method — except `eth_sendTransaction`, which is a transaction signature and never
 * a message signature — fails CLOSED (Unknown = Block). The guard itself never throws on
 * malformed input; an internal error is a refusal.
 *
 * WalletConnectService calls `checkProvianReserved` at the `session_request` door (the request
 * is rejected with 4001 before any prompt is shown) and `assertNotProvianReserved` at the top
 * of `handleSignRequest` as the backstop.
 */

import bs58 from 'bs58';
import { PROVIAN_BASE_CONTRACTS } from '../chains/evm/config';
import { SOLANA_PROOF_MESSAGE_HEADER } from '../chains/solana/solanaProofMessage';
import { PROVIAN_EVM_TREASURY } from '../fees/FeeConfig';
import { PVT9_BASE_CONFIG } from '../pvt/pvt9-base-config.generated';
import { RELAY_RECOVERY_DOMAIN } from '../relay/recoveryDomain';
import { HIRE_ESCROW_SALT_MESSAGE } from '../wallet/hireEscrowSaltMessage';
import { translate } from '../../i18n/translate';

export type ProvianReservedReason =
    | 'provian_text'
    | 'provian_hire_salt'
    | 'provian_solana_proof'
    | 'provian_link_consent_json'
    | 'provian_typed_data_domain'
    | 'provian_typed_data_type'
    | 'provian_verifying_contract'
    | 'unclassifiable_verifying_contract'
    | 'unclassifiable_params'
    | 'unclassified_method'
    | 'guard_error';

export type ProvianReservedVerdict =
    | { reserved: false }
    | { reserved: true; reason: ProvianReservedReason; detail: string };

/** What the dApp (JSON-RPC 4001) and the user are told. */
export const PROVIAN_RESERVED_USER_MESSAGE =
    'Blocked: this app asked your wallet to sign a Provian account message. Provian never asks you to sign those through another app.';

export class ProvianReservedMessageError extends Error {
    readonly code = 'PROVIAN_RESERVED_MESSAGE';
    readonly reason: ProvianReservedReason;
    readonly detail: string;
    /** English text for dApp replies and PE records; `message` is the on-screen copy. */
    readonly englishMessage = PROVIAN_RESERVED_USER_MESSAGE;
    constructor(reason: ProvianReservedReason, detail: string) {
        super(translate('walletConnect.provianReservedBlocked', PROVIAN_RESERVED_USER_MESSAGE));
        this.name = 'ProvianReservedMessageError';
        this.reason = reason;
        this.detail = detail;
    }
}

const RESERVED_WORD = 'provian';

/**
 * Top-level keys that mark the relay's link / unlink / share-change consent payloads. Every one
 * of those payloads carries BOTH `agent_wallet_id` and `human_wallet_id` (agent-wallet.ts
 * link/unlink/share routes), so either id key suffices. `action` alone is NOT reserved: generic
 * dApp sign-ins use it (`{"action" "login",…}`) — review.
 */
const RESERVED_JSON_KEYS: ReadonlySet<string> = new Set([
    'agent_wallet_id',
    'human_wallet_id',
    'operational_reserve_bps',
]);

/** Provian EIP-712 struct names (compared on the folded skeleton, `[]` stripped). */
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
    'relayrecovery',
    'recoverrelaycredentials',
    'registerhumanwallet',
    'humanwalletregistration',
    'linkagent',
    'unlinkagent',
    'linkhuman',
    'unlinkhuman',
    'updatebeneficiaryshare',
    'beneficiaryshareupdate',
]);

const TYPED_DATA_METHODS: ReadonlySet<string> = new Set([
    'eth_signTypedData',
    'eth_signTypedData_v1',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
]);

/** Transaction signatures — out of scope (see DECISIONS). */
const NON_MESSAGE_METHODS: ReadonlySet<string> = new Set(['eth_sendTransaction']);

/**
 * Every Provian contract address the app knows, lowercased: the live set, the PVT9
 * kernel from the generated runtime config, every retired PVT token on its forbidden list, the
 * recovery domain's verifyingContract (the Foundation Safe) and the Provian treasury.
 */
const RESERVED_ADDRESSES: ReadonlySet<string> = new Set(
    [
        ...Object.values(PROVIAN_BASE_CONTRACTS),
        PVT9_BASE_CONFIG.assets.pvt9.address,
        ...PVT9_BASE_CONFIG.validation.forbidden_pvt_addresses,
        RELAY_RECOVERY_DOMAIN.verifyingContract,
        PROVIAN_EVM_TREASURY,
    ].map((address) => address.toLowerCase()),
);

/** The reserved address set, for tests and diagnostics. */
export function provianReservedAddresses(): readonly string[] {
    return [...RESERVED_ADDRESSES];
}

// ── Text normalization ──────────────────────────────────────────────────────

/**
 * Default-ignorable / format characters that render as nothing: soft hyphen, CGJ, ALM,
 * Hangul fillers, Khmer/Mongolian invisibles, ZWSP/ZWNJ/ZWJ/LRM/RLM, bidi embeddings and
 * isolates, word joiner and invisible operators, variation selectors, BOM, interlinear
 * annotation, plus the astral tag characters, musical format controls and shorthand format
 * controls (as surrogate pairs — no `u`-flag property escapes, for Hermes).
 */
const IGNORABLE =
    /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]|\uDB40[\uDC00-\uDDEF]|\uD834[\uDD73-\uDD7A]|\uD82F[\uDCA0-\uDCA3]/g;

/** Combining marks (after NFD) — "províán" folds to "provian". */
const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

/** Latin look-alikes NFKC does not fold (Cyrillic, Greek, IPA, small capitals). */
const CONFUSABLES: Readonly<Record<string, string>> = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y',
    'х': 'x', 'і': 'i', 'ј': 'j', 'ѵ': 'v', 'ԁ': 'd', 'ӏ': 'i',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k',
    'ı': 'i', 'ɑ': 'a', 'ʋ': 'v', 'ᴠ': 'v', 'ᴘ': 'p', 'ʀ': 'r',
    'ᴏ': 'o', 'ɪ': 'i', 'ᴀ': 'a', 'ɴ': 'n', 'ո': 'n', 'ռ': 'n',
    'օ': 'o', 'г': 'r',
};

function safeNormalize(value: string, form: 'NFKC' | 'NFD'): string {
    try {
        return typeof value.normalize === 'function' ? value.normalize(form) : value;
    } catch {
        return value;
    }
}

/** The folded comparison skeleton of a string. */
function skeleton(input: string): string {
    const folded = safeNormalize(safeNormalize(input, 'NFKC'), 'NFD')
        .replace(COMBINING, '')
        .replace(IGNORABLE, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    let out = '';
    for (const ch of folded) out += CONFUSABLES[ch] ?? ch;
    return out;
}

function containsProvian(value: string): boolean {
    return skeleton(value).includes(RESERVED_WORD);
}

function isReservedTypeName(value: string): boolean {
    const folded = skeleton(value).replace(/(\[\d*\])+$/, '');
    return folded.includes(RESERVED_WORD) || RESERVED_TYPE_NAMES.has(folded);
}

// ── Bytes ───────────────────────────────────────────────────────────────────

function hexToBytes(value: string): Uint8Array | null {
    const body = /^0x/i.test(value) ? value.slice(2) : value;
    if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null;
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** UTF-8 decode that never throws: every malformed sequence becomes U+FFFD. */
function utf8DecodeLossy(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i];
        let need = 0;
        let cp = 0;
        let min = 0;
        if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; continue; }
        if (b0 >= 0xC2 && b0 <= 0xDF) { need = 1; cp = b0 & 0x1F; min = 0x80; }
        else if (b0 >= 0xE0 && b0 <= 0xEF) { need = 2; cp = b0 & 0x0F; min = 0x800; }
        else if (b0 >= 0xF0 && b0 <= 0xF4) { need = 3; cp = b0 & 0x07; min = 0x10000; }
        else { out += '�'; i += 1; continue; }
        let j = 1;
        for (; j <= need; j += 1) {
            const b = bytes[i + j];
            if (b === undefined || (b & 0xC0) !== 0x80) break;
            cp = (cp << 6) | (b & 0x3F);
        }
        if (j <= need || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
            out += '�';
            i += 1;
            continue;
        }
        out += String.fromCodePoint(cp);
        i += need + 1;
    }
    return out;
}

// ── personal_sign ───────────────────────────────────────────────────────────

/** Details can carry dApp-controlled strings (type names) into a sealed PE — keep them short. */
function clip(value: string): string {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reservedJsonKey(text: string): string | null {
    const trimmed = text.replace(IGNORABLE, '').trim();
    if (!trimmed.startsWith('{')) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    for (const key of Object.keys(parsed)) {
        if (RESERVED_JSON_KEYS.has(skeleton(key))) return key;
    }
    return null;
}

/**
 * The Solana proof-of-control header with its brand word dropped, folded: "solanaproofofcontrol".
 * Matching on this (not on the full header) refuses the Solana proof even if the brand word were
 * somehow disguised past the "provian" fold.
 */
const SOLANA_PROOF_PATTERN = skeleton(SOLANA_PROOF_MESSAGE_HEADER.replace(/^Provian\s+/, ''));

function inspectMessageText(text: string): ProvianReservedVerdict {
    if (skeleton(text).includes(SOLANA_PROOF_PATTERN)) {
        return { reserved: true, reason: 'provian_solana_proof', detail: 'Solana proof-of-control message' };
    }
    if (text === HIRE_ESCROW_SALT_MESSAGE || skeleton(text) === skeleton(HIRE_ESCROW_SALT_MESSAGE)) {
        return { reserved: true, reason: 'provian_hire_salt', detail: 'hire escrow salt message' };
    }
    if (containsProvian(text)) {
        return { reserved: true, reason: 'provian_text', detail: 'message names Provian' };
    }
    const key = reservedJsonKey(text);
    if (key !== null) {
        return { reserved: true, reason: 'provian_link_consent_json', detail: clip(`JSON message carries "${key}"`) };
    }
    return { reserved: false };
}

function checkPersonalSign(params: unknown): ProvianReservedVerdict {
    if (!Array.isArray(params)) {
        return { reserved: true, reason: 'unclassifiable_params', detail: 'personal_sign params are not an array' };
    }
    for (const param of params) {
        if (param === null || param === undefined) continue;
        if (typeof param !== 'string') {
            return { reserved: true, reason: 'unclassifiable_params', detail: 'personal_sign param is not a string' };
        }
        // The raw string (what a non-hex message signs), and its bytes decoded (what a hex
        // message signs) — whichever order the dApp sent message and address in.
        const texts = [param];
        const bytes = hexToBytes(param);
        if (bytes) texts.push(utf8DecodeLossy(bytes));
        for (const text of texts) {
            const verdict = inspectMessageText(text);
            if (verdict.reserved) return verdict;
        }
    }
    return { reserved: false };
}

// ── solana_signMessage ──────────────────────────────────────────────────────

const SOLANA_MESSAGE_METHODS: ReadonlySet<string> = new Set(['solana_signMessage']);

/** WalletConnect Solana: `{ message: <base58 bytes>, pubkey }`. A raw-string message is read too. */
function checkSolanaSignMessage(params: unknown): ProvianReservedVerdict {
    const message = isPlainObject(params) ? params.message : undefined;
    if (typeof message !== 'string') {
        return { reserved: true, reason: 'unclassifiable_params', detail: 'solana_signMessage message is not a string' };
    }
    const texts = [message];
    try {
        texts.push(utf8DecodeLossy(bs58.decode(message)));
    } catch {
        // Not base58 — only the raw string can be what is signed.
    }
    for (const text of texts) {
        const verdict = inspectMessageText(text);
        if (verdict.reserved) return verdict;
    }
    return { reserved: false };
}

// ── typed data ──────────────────────────────────────────────────────────────

function inspectVerifyingContract(value: unknown): ProvianReservedVerdict {
    if (value === undefined || value === null) return { reserved: false };
    if (typeof value !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/i.test(value.trim())) {
        // An ICAP / non-address form a signer might still coerce — refuse rather than guess.
        return { reserved: true, reason: 'unclassifiable_verifying_contract', detail: 'verifyingContract is not a plain address' };
    }
    const body = value.trim().replace(/^0x/i, '').toLowerCase();
    if (RESERVED_ADDRESSES.has(`0x${body}`)) {
        return { reserved: true, reason: 'provian_verifying_contract', detail: `verifyingContract 0x${body}` };
    }
    return { reserved: false };
}

function inspectTypedDataObject(td: Record<string, unknown>): ProvianReservedVerdict {
    const domain = td.domain;
    if (isPlainObject(domain)) {
        for (const [field, value] of Object.entries(domain)) {
            if (typeof value === 'string' && field !== 'verifyingContract' && containsProvian(value)) {
                return { reserved: true, reason: 'provian_typed_data_domain', detail: clip(`domain.${field} names Provian`) };
            }
        }
        const contract = inspectVerifyingContract(domain.verifyingContract);
        if (contract.reserved) return contract;
    }
    if (typeof td.primaryType === 'string' && isReservedTypeName(td.primaryType)) {
        return { reserved: true, reason: 'provian_typed_data_type', detail: clip(`primaryType ${td.primaryType}`) };
    }
    const types = td.types;
    if (isPlainObject(types)) {
        for (const [typeName, fields] of Object.entries(types)) {
            if (isReservedTypeName(typeName)) {
                return { reserved: true, reason: 'provian_typed_data_type', detail: clip(`type ${typeName}`) };
            }
            if (!Array.isArray(fields)) continue;
            for (const field of fields) {
                if (!isPlainObject(field)) continue;
                for (const part of [field.name, field.type]) {
                    if (typeof part === 'string' && isReservedTypeName(part)) {
                        return { reserved: true, reason: 'provian_typed_data_type', detail: clip(`field ${typeName}.${String(field.name)}`) };
                    }
                }
            }
        }
    }
    return { reserved: false };
}

/** eth_signTypedData v1: `[{ type, name, value }, …]` — no domain, so the values count too. */
function inspectTypedDataV1(entries: unknown[]): ProvianReservedVerdict {
    for (const entry of entries) {
        if (!isPlainObject(entry)) continue;
        for (const part of [entry.name, entry.type]) {
            if (typeof part === 'string' && isReservedTypeName(part)) {
                return { reserved: true, reason: 'provian_typed_data_type', detail: clip(`v1 field ${String(entry.name)}`) };
            }
        }
        if (typeof entry.value === 'string') {
            const verdict = inspectMessageText(entry.value);
            if (verdict.reserved) return verdict;
        }
    }
    return { reserved: false };
}

function inspectTypedDataParam(param: unknown): ProvianReservedVerdict {
    let value = param;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            // Not JSON (e.g. the address param). The signer parses the same string with
            // JSON.parse, so an unparseable param can never be signed as typed data.
            return { reserved: false };
        }
    }
    if (Array.isArray(value)) return inspectTypedDataV1(value);
    if (isPlainObject(value)) return inspectTypedDataObject(value);
    return { reserved: false };
}

function checkTypedData(params: unknown): ProvianReservedVerdict {
    if (!Array.isArray(params)) {
        return { reserved: true, reason: 'unclassifiable_params', detail: 'typed-data params are not an array' };
    }
    for (const param of params) {
        const verdict = inspectTypedDataParam(param);
        if (verdict.reserved) return verdict;
    }
    return { reserved: false };
}

// ── entry points ────────────────────────────────────────────────────────────

/**
 * Classify a WalletConnect request. Never throws: a guard error is itself a refusal.
 */
export function checkProvianReserved(method: string, params: unknown): ProvianReservedVerdict {
    try {
        if (NON_MESSAGE_METHODS.has(method)) return { reserved: false };
        if (method === 'personal_sign') return checkPersonalSign(params);
        if (SOLANA_MESSAGE_METHODS.has(method)) return checkSolanaSignMessage(params);
        if (TYPED_DATA_METHODS.has(method)) return checkTypedData(params);
        return { reserved: true, reason: 'unclassified_method', detail: clip(`method ${String(method)} is not classified`) };
    } catch {
        return { reserved: true, reason: 'guard_error', detail: 'reserved-message guard failed' };
    }
}

/** Throw `ProvianReservedMessageError` if the request would sign a Provian-reserved message. */
export function assertNotProvianReserved(method: string, params: unknown): void {
    const verdict = checkProvianReserved(method, params);
    if (verdict.reserved) throw new ProvianReservedMessageError(verdict.reason, verdict.detail);
}
