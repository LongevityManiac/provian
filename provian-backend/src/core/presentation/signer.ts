/**
 * Reputation-tier presentation signer — the PRODUCTION wiring of the Provian
 * JWS attestation signer.
 *
 * The Provian attestation signing machinery was, until this build, unwired: the
 * only JWS signer in the tree (`src/core/attestation/attestation.ts`, EdDSA via
 * `jose`) was imported by nothing, and the backend held only the VERIFIER
 * (`commerce-attestation.ts`) with nothing to verify. This module gives that
 * machinery a real production job — signing reputation-tier presentations — and
 * does it the backend-native way: node `crypto` Ed25519 (the backend has no
 * `jose` dependency, and the Provian private key must never reach a client), to
 * the SAME compact-JWS wire format the verifier already enforces (EdDSA, header
 * `{ alg, kid, typ }`, Provian issuer). The public half is already served as a
 * JWKS from the SAME key material.
 *
 * KEY MATERIAL — env `ATTESTATION_SIGNING_KEY` (a Secret Manager mount): JSON,
 * either a single Ed25519 JWK or a JWK Set `{ "keys": [...] }`. Signing needs an
 * entry carrying the private `d` member. FAIL CLOSED: unset / invalid / no
 * private key all refuse, so an unconfigured deployment cannot silently produce
 * unsigned or fabricated presentations.
 */

import crypto from 'crypto';
import { ATTESTATION_SIGNING_KEY_ENV } from './jws-key-material';
import {
  PRESENTATION_TYP,
  PRESENTATION_PEFACT_TYP,
  type PresentationPayload,
  type PeFactCosignPayload,
} from './types';

export interface PresentationSigningKey {
  readonly kid: string;
  readonly privateKey: crypto.KeyObject;
}

export type LoadSigningKeyResult =
  | { ok: true; key: PresentationSigningKey }
  | { ok: false; reason: 'unset' | 'invalid' | 'no_private_key' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load the FIRST usable Ed25519 private signing key from `ATTESTATION_SIGNING_KEY`.
 * Read per REQUEST, never captured at module load, so rotation and (un)configuration
 * take effect without a redeploy — the same doctrine the verifier's loader follows.
 */
export function loadPresentationSigningKey(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): LoadSigningKeyResult {
  const raw = env[ATTESTATION_SIGNING_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'unset' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  let entries: unknown[];
  if (isRecord(parsed) && Array.isArray(parsed.keys)) {
    entries = parsed.keys;
  } else if (isRecord(parsed)) {
    entries = [parsed];
  } else {
    return { ok: false, reason: 'invalid' };
  }
  if (entries.length === 0) return { ok: false, reason: 'invalid' };

  let sawEntry = false;
  for (const entry of entries) {
    if (!isRecord(entry)) return { ok: false, reason: 'invalid' };
    if (entry.kty !== 'OKP' || entry.crv !== 'Ed25519') return { ok: false, reason: 'invalid' };
    const kid = entry.kid;
    const x = entry.x;
    if (typeof kid !== 'string' || kid.length === 0) return { ok: false, reason: 'invalid' };
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]+$/.test(x)) return { ok: false, reason: 'invalid' };
    if (Buffer.from(x, 'base64url').length !== 32) return { ok: false, reason: 'invalid' };
    sawEntry = true;

    const d = entry.d;
    if (typeof d !== 'string' || d.length === 0) continue; // public-only entry — keep scanning
    if (!/^[A-Za-z0-9_-]+$/.test(d) || Buffer.from(d, 'base64url').length !== 32) {
      return { ok: false, reason: 'invalid' };
    }
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519', x, d },
        format: 'jwk',
      });
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, key: { kid, privateKey } };
  }

  // Well-formed key material, but no entry carries a private `d`. Distinct from
  // 'unset'/'invalid' so the route can say precisely why it cannot sign.
  return { ok: false, reason: sawEntry ? 'no_private_key' : 'invalid' };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as string, typeof input === 'string' ? 'utf8' : undefined)
    .toString('base64url');
}

/**
 * Sign a JSON payload as a compact-serialization JWS (EdDSA / Ed25519) with the
 * given `typ`. The payload is carried as its exact serialized bytes (standard
 * JWS), so verification decodes rather than re-serializes — no canonicalization
 * drift. Shared by every Provian presentation signature so the wire format cannot
 * diverge between the reputation JWS and the pe_fact co-sign.
 */
function signCompactJws(payload: unknown, key: PresentationSigningKey, typ: string): string {
  const header = { alg: 'EdDSA', kid: key.kid, typ };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Sign a reputation-tier presentation payload as a compact JWS, byte-identical in
 * shape to what the commerce-attestation verifier accepts, with the reputation
 * presentation `typ`.
 */
export function signReputationPresentation(
  payload: PresentationPayload,
  key: PresentationSigningKey,
): string {
  return signCompactJws(payload, key, PRESENTATION_TYP);
}

/**
 * Sign the PE-FACT Provian CO-SIGN as a compact JWS with the DISTINCT pe_fact
 * `typ`. Called at issuance (after ownership + burn are enforced) over the
 * canonical {@link PeFactCosignPayload}. The distinct `typ` is what stops a
 * reputation JWS being replayed as a pe_fact co-sign or vice-versa — every
 * verifier pins the exact `typ` for the tier it is checking.
 */
export function signPeFactCosign(
  cosign: PeFactCosignPayload,
  key: PresentationSigningKey,
): string {
  return signCompactJws(cosign, key, PRESENTATION_PEFACT_TYP);
}
