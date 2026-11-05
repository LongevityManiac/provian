/**
 * Seller registration — sellers are identified by wallet signature, never by an account.
 *
 * The seller signs ONE canonical message naming its chain, its address, a hash of the profile it is
 * registering, a single-use nonce and the time (±5 minutes):
 *
 *   Provian x402 seller registration
 *   chain: base
 *   address: 0xabc…
 *   profile_sha256: <hex sha256 of the canonical profile JSON>
 *   nonce: <8–64 chars [A-Za-z0-9_-]>
 *   issued_at_ms: <unix ms>
 *
 * EVM: EIP-191 personal_sign (an ERC-1271 contract wallet verifies through the chain client).
 * Solana: ed25519 over the UTF-8 bytes of the same message, signature base58.
 *
 * PVT prices are stored as PVT atomic amounts only — Provian never quotes PVT in dollars.
 */
import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { getBase58Encoder, getPublicKeyFromAddress, isAddress as isSolanaAddress, verifySignature, address as solAddress } from '@solana/kit';
import { z } from 'zod';
import { BASE_NETWORK, SOLANA_NETWORK, type ChainName } from './constants.js';
import type { FacilitatorStore, SellerRecord } from './store.js';

export const REGISTRATION_WINDOW_MS = 5 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

const predicateSchema = z
  .object({
    field: z.string().min(1).max(64).regex(/^[a-z0-9_.]+$/),
    op: z.enum(['gte', 'gt', 'lte', 'lt', 'eq', 'in']),
    threshold: z.number().finite().optional(),
    set: z.array(z.number().finite()).max(32).optional(),
  })
  .strict()
  .refine((p) => (p.op === 'in' ? Array.isArray(p.set) && p.threshold === undefined : typeof p.threshold === 'number' && p.set === undefined), {
    message: 'predicate needs threshold (or set for op "in")',
  });

const httpsUrl = z
  .string()
  .max(300)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
    } catch {
      return false;
    }
  }, 'resource URLs must be https');

export const profileSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    resource_urls: z.array(httpsUrl).max(20).default([]),
    require_presentation: z
      .object({ tier: z.enum(['pe_fact', 'reputation']), predicates: z.array(predicateSchema).max(8).optional() })
      .strict()
      .nullable()
      .default(null),
    pvt_prices: z
      .array(
        z
          .object({
            resource: z.string().min(1).max(300),
            amount_atomic: z.string().regex(/^[1-9]\d{0,59}$/, 'PVT amount must be a positive atomic integer'),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();

export type SellerProfile = z.infer<typeof profileSchema>;

export const registrationSchema = z
  .object({
    chain: z.enum(['base', 'solana']),
    address: z.string().min(32).max(64),
    profile: profileSchema,
    nonce: z.string().regex(NONCE_RE),
    issued_at_ms: z.number().int().positive(),
    signature: z.string().min(16).max(4096),
  })
  .strict();

export type RegistrationRequest = z.infer<typeof registrationSchema>;

/** Deterministic JSON (sorted keys) — the profile hash both sides compute. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function profileHash(profile: SellerProfile): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}

/** The canonical seller id (`chain:address`, EVM lowercased). */
export function sellerIdOf(chain: ChainName, address: string): string {
  return `${chain}:${chain === 'base' ? address.toLowerCase() : address}`;
}

export function registrationMessage(chain: ChainName, address: string, profile: SellerProfile, nonce: string, issuedAtMs: number): string {
  return [
    'Provian x402 seller registration',
    `chain: ${chain}`,
    `address: ${chain === 'base' ? address.toLowerCase() : address}`,
    `profile_sha256: ${profileHash(profile)}`,
    `nonce: ${nonce}`,
    `issued_at_ms: ${issuedAtMs}`,
  ].join('\n');
}

export type EvmMessageVerifier = (address: `0x${string}`, message: string, signature: `0x${string}`) => Promise<boolean>;

export async function verifySolanaMessage(address: string, message: string, signatureBase58: string): Promise<boolean> {
  try {
    if (!isSolanaAddress(address)) return false;
    const sig = getBase58Encoder().encode(signatureBase58);
    if (sig.length !== 64) return false;
    const key = await getPublicKeyFromAddress(solAddress(address));
    return await verifySignature(key, sig as Parameters<typeof verifySignature>[1], new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export class RegistrationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export interface RegisterDeps {
  readonly store: FacilitatorStore;
  readonly verifyEvm: EvmMessageVerifier | null;
  readonly now: () => number;
}

/** Validate, verify the signature, burn the nonce, upsert. Throws RegistrationError. */
export async function registerSeller(body: unknown, deps: RegisterDeps): Promise<SellerRecord> {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) throw new RegistrationError('invalid_registration', 400);
  const req = parsed.data;
  const now = deps.now();
  if (Math.abs(now - req.issued_at_ms) > REGISTRATION_WINDOW_MS) throw new RegistrationError('registration_expired', 400);

  let address: string;
  if (req.chain === 'base') {
    if (!isAddress(req.address)) throw new RegistrationError('invalid_address', 400);
    address = getAddress(req.address);
  } else {
    if (!isSolanaAddress(req.address)) throw new RegistrationError('invalid_address', 400);
    address = req.address;
    // PVT lives on Base only.
    if (req.profile.pvt_prices.length > 0) throw new RegistrationError('pvt_prices_base_only', 400);
  }

  const message = registrationMessage(req.chain, address, req.profile, req.nonce, req.issued_at_ms);
  let ok = false;
  if (req.chain === 'base') {
    if (!deps.verifyEvm) throw new RegistrationError('chain_unavailable', 503);
    if (!/^0x[0-9a-fA-F]+$/.test(req.signature)) throw new RegistrationError('invalid_signature', 401);
    ok = await deps.verifyEvm(address as `0x${string}`, message, req.signature as `0x${string}`);
  } else {
    ok = await verifySolanaMessage(address, message, req.signature);
  }
  if (!ok) throw new RegistrationError('invalid_signature', 401);

  // The nonce is burned only after the signature checks, so an attacker cannot burn a seller's nonce.
  const fresh = await deps.store.consumeNonce(`${sellerIdOf(req.chain, address)}~${req.nonce}`.replace(/[:/]/g, '_'), now + 2 * REGISTRATION_WINDOW_MS);
  if (!fresh) throw new RegistrationError('nonce_reused', 409);

  const sellerId = sellerIdOf(req.chain, address);
  const record: SellerRecord = {
    seller_id: sellerId,
    chain: req.chain,
    network: req.chain === 'base' ? BASE_NETWORK : SOLANA_NETWORK,
    address: req.chain === 'base' ? address.toLowerCase() : address,
    display_name: req.profile.display_name,
    description: req.profile.description,
    resource_urls: req.profile.resource_urls,
    require_presentation: req.profile.require_presentation,
    pvt_prices: req.profile.pvt_prices,
    status: 'active',
    registered_at_ms: now,
    updated_at_ms: now,
  };
  return deps.store.upsertSeller(record);
}

/** The public face of a seller (what GET /sellers/:chain/:address returns). */
export function publicSeller(s: SellerRecord): Record<string, unknown> {
  return {
    seller_id: s.seller_id,
    chain: s.chain,
    network: s.network,
    address: s.address,
    display_name: s.display_name,
    description: s.description,
    resource_urls: s.resource_urls,
    require_presentation: s.require_presentation,
    pvt_prices: s.pvt_prices,
    status: s.status,
    registered_at_ms: s.registered_at_ms,
    updated_at_ms: s.updated_at_ms,
  };
}
