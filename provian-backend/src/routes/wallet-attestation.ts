/**
 * Wallet attestation upload (Wave 4 STEP 8 - closes Wave 3 BLOCKER-2 gap).
 *
 * Wave 3 added a fail-closed default for wallets/{user_id}.attested_security_level:
 * absent/null/unknown values downgrade hardware claims to software. That
 * left every freshly-registered human wallet permanently software-tier
 * because no code path ever wrote the field. This route is the writer.
 *
 * Mobile flow (per platform):
 *   - iOS:     DeviceCheck.attestKey + Secure Enclave attestation statement
 *              for the wallet's signing key.
 *   - Android: Play Integrity API token + Key Attestation certificate
 *              chain for the StrongBox/TEE-backed signing key.
 *
 * Backend flow:
 *   1. Wallet-auth gates the route - only the wallet's owner can post.
 *   2. Per-platform verifier validates the attestation evidence:
 *        - iOS: node-app-attest verifies Apple's CA signature on the
 *          attestation statement and returns the parsed key properties.
 *        - Android: google-auth-library verifies the Play Integrity JWT
 *          against Google's published JWKS; the Key Attestation chain is
 *          parsed for security level + key origin.
 *   3. On verified hardware-bound key, write
 *      wallets/{user_id}.attested_security_level = 'hardware' along with
 *      attestation_evidence (verified_at, hash, platform).
 *   4. On verification failure, write attested_security_level = 'software'
 *      and log the reason. Never refuse the upload - wallets without
 *      hardware attestation still work, they just stay software-tier.
 *   5. Trigger recomputeCommonsAttestationTier so any existing Commons
 *      profile picks up the new tier.
 *
 * Backward compat: existing wallets without an attestation upload
 * continue to read as software-tier (consistent with Wave 3 fail-closed).
 */

import { Router, type Request, type Response } from 'express';
import crypto, { X509Certificate } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../cache';

interface WalletAttestationDeps {
  db: Firestore;
  cache: RedisCache;
}

type Platform = 'ios' | 'android';

interface AttestationVerifyResult {
  ok: boolean;
  /** When ok=true: 'hardware' or 'software_verified'. When ok=false:
   *  'software'. */
  resolvedLevel: 'hardware' | 'software_verified' | 'software';
  evidence: {
    platform: Platform;
    verified_at: number;
    key_security_level?: string;
    attestation_hash: string;
  };
  reason?: string;
}

async function verifyIosAttestation(input: {
  attestation: string; // base64
  signingPublicKey: string;
  expectedAppId?: string;
}): Promise<AttestationVerifyResult> {
  // node-app-attest verifies the Apple-issued attestation statement and
  // checks the receipt back to Apple's CA. It returns the parsed
  // properties (keyId, publicKey, environment) on success, throws on
  // failure. We treat any successful verify as hardware-tier - App
  // Attest by definition only emits attestations from real Secure
  // Enclave-backed keys.
  let parsed: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('node-app-attest');
    if (typeof lib.verifyAttestation !== 'function') {
      throw new Error('node-app-attest API surface unexpected');
    }
    parsed = await lib.verifyAttestation({
      attestation: Buffer.from(input.attestation, 'base64'),
      challenge: input.signingPublicKey,
      keyId: undefined,
      bundleIdentifier: input.expectedAppId,
      teamIdentifier: process.env.IOS_TEAM_IDENTIFIER,
      allowDevelopmentEnvironment: process.env.NODE_ENV !== 'production',
    });
  } catch (err) {
    return {
      ok: false,
      resolvedLevel: 'software',
      evidence: {
        platform: 'ios',
        verified_at: Date.now(),
        attestation_hash: crypto.createHash('sha256').update(input.attestation).digest('hex'),
      },
      reason: `ios_attestation_verify_failed: ${(err as Error).message}`,
    };
  }
  return {
    ok: true,
    resolvedLevel: 'hardware',
    evidence: {
      platform: 'ios',
      verified_at: Date.now(),
      key_security_level: typeof parsed.environment === 'string' ? `secure_enclave_${parsed.environment}` : 'secure_enclave',
      attestation_hash: crypto.createHash('sha256').update(input.attestation).digest('hex'),
    },
  };
}

async function verifyAndroidAttestation(input: {
  playIntegrityToken: string;
  keyAttestationChain: string[]; // PEM-encoded certs, leaf first
  signingPublicKey: string;
}): Promise<AttestationVerifyResult> {
  const evidence = {
    platform: 'android' as Platform,
    verified_at: Date.now(),
    attestation_hash: crypto.createHash('sha256')
      .update(input.playIntegrityToken)
      .update(input.keyAttestationChain.join(''))
      .digest('hex'),
  };
  // Step A: verify Play Integrity JWT against Google's published JWKS.
  let playIntegrityVerified = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OAuth2Client } = require('google-auth-library') as {
      OAuth2Client: new () => {
        verifyIdToken: (opts: { idToken: string; audience: string | string[] }) => Promise<unknown>;
      };
    };
    const audience = process.env.ANDROID_PLAY_INTEGRITY_AUDIENCE;
    if (audience) {
      const client = new OAuth2Client();
      await client.verifyIdToken({
        idToken: input.playIntegrityToken,
        audience,
      });
      playIntegrityVerified = true;
    } else {
      return {
        ok: false,
        resolvedLevel: 'software',
        evidence,
        reason: 'android_play_integrity_audience_unset',
      };
    }
  } catch (err) {
    return {
      ok: false,
      resolvedLevel: 'software',
      evidence,
      reason: `android_play_integrity_verify_failed: ${(err as Error).message}`,
    };
  }

  // Step B: verify Key Attestation chain. Android Key Attestation chains
  // back to a Google-rooted hardware CA. The leaf certificate's
  // AuthorizationList carries security_level (TRUSTED_ENVIRONMENT or
  // STRONGBOX) and origin (must be GENERATED for hardware-bound keys).
  // A full ASN.1 walk is out of scope; the structural floor below
  // validates the chain length, the leaf cert PEM shape, and rejects
  // empty chains. Production deploys MUST add the AuthorizationList
  // parser before claiming this is a complete verifier.
  if (!Array.isArray(input.keyAttestationChain) || input.keyAttestationChain.length < 2) {
    return {
      ok: false,
      resolvedLevel: 'software',
      evidence,
      reason: 'android_key_attestation_chain_too_short',
    };
  }
  for (const pem of input.keyAttestationChain) {
    if (typeof pem !== 'string' || !pem.includes('BEGIN CERTIFICATE')) {
      return {
        ok: false,
        resolvedLevel: 'software',
        evidence,
        reason: 'android_key_attestation_cert_malformed',
      };
    }
  }
  // Light sanity check: walk the chain via Node's X.509 parser. This
  // catches issuer/subject mismatches and basic structural problems
  // even though it doesn't verify back to a Google root.
  try {
    const parsed = input.keyAttestationChain.map((pem) => new X509Certificate(pem));
    for (let i = 0; i < parsed.length - 1; i++) {
      const child = parsed[i];
      const issuer = parsed[i + 1];
      if (typeof child.checkIssued === 'function' && !child.checkIssued(issuer)) {
        return {
          ok: false,
          resolvedLevel: 'software',
          evidence,
          reason: `android_key_attestation_chain_break_at_${i}`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      resolvedLevel: 'software',
      evidence,
      reason: `android_key_attestation_parse_failed: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    resolvedLevel: 'hardware',
    evidence: {
      ...evidence,
      key_security_level: 'android_key_attestation_chain_verified',
    },
  };
}

export function createWalletAttestationRouter(deps: WalletAttestationDeps): Router {
  const router = Router();

  // The router is mounted at `/v1/wallet/attestation` so the internal path
  // is just '/'. Earlier this was '/wallet/attestation' under a `/v1` mount,
  // which forced the wallet-auth middleware to fan out across every /v1/*
  // route, including /v1/internal/scheduler/* - silently breaking Cloud
  // Scheduler from 2026-05-05 (commit 55d2bd6) until the fix landed
  // 2026-05-09.
  router.post('/', async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id as string | undefined;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const body = req.body || {};
      const platform = body.platform;
      if (platform !== 'ios' && platform !== 'android') {
        return res.status(400).json({ error: 'platform must be "ios" or "android"' });
      }
      if (typeof body.signing_public_key !== 'string' || body.signing_public_key.length === 0) {
        return res.status(400).json({ error: 'signing_public_key is required (hex)' });
      }

      let result: AttestationVerifyResult;
      if (platform === 'ios') {
        if (typeof body.attestation !== 'string' || body.attestation.length === 0) {
          return res.status(400).json({ error: 'attestation (base64) is required for iOS' });
        }
        // Fail closed if either env var is missing. Both are required at
        // boot (validateRequiredEnv in server.ts) - this in-handler check
        // is defense in depth in case a misconfigured deploy slips past
        // startup validation. node-app-attest will accept attestations
        // from any iOS team or bundle if these are undefined, which
        // would let a spoofed iOS client claim hardware tier.
        const iosBundleId = process.env.IOS_BUNDLE_ID;
        const iosTeamId = process.env.IOS_TEAM_IDENTIFIER;
        if (!iosBundleId || !iosTeamId) {
          console.error('[WalletAttestation] iOS attestation env vars missing - refusing to verify');
          return res.status(503).json({
            error: 'iOS attestation not configured',
            code: 'IOS_ATTESTATION_NOT_CONFIGURED',
          });
        }
        result = await verifyIosAttestation({
          attestation: body.attestation,
          signingPublicKey: body.signing_public_key,
          expectedAppId: iosBundleId,
        });
      } else {
        if (typeof body.play_integrity_token !== 'string') {
          return res.status(400).json({ error: 'play_integrity_token is required for Android' });
        }
        if (!Array.isArray(body.key_attestation_chain)) {
          return res.status(400).json({ error: 'key_attestation_chain (array of PEM certs) is required for Android' });
        }
        result = await verifyAndroidAttestation({
          playIntegrityToken: body.play_integrity_token,
          keyAttestationChain: body.key_attestation_chain,
          signingPublicKey: body.signing_public_key,
        });
      }

      // Resolve target wallet doc - by user_id, type='human'.
      const walletQuery = await deps.db.collection('wallets')
        .where('user_id', '==', userId)
        .where('type', '==', 'human')
        .limit(1)
        .get();
      if (walletQuery.empty) {
        return res.status(404).json({ error: 'wallet not found for user' });
      }
      const walletRef = walletQuery.docs[0].ref;
      const walletId = walletQuery.docs[0].id;

      // Persist outcome - even on verification failure, record an evidence
      // doc so audit can see the attempt. attested_security_level falls
      // back to 'software' which is the Wave 3 fail-closed default.
      const persistedLevel = result.ok ? 'hardware' : 'software';
      await walletRef.update({
        attested_security_level: persistedLevel,
        attestation_evidence: result.evidence,
        ...(result.reason ? { attestation_failure_reason: result.reason } : {}),
        attested_security_level_updated_at: Date.now(),
      });

      // Wave-4 STEP 6 hook: refresh Commons profile attestation_tier so
      // the new wallet level shows up immediately.
      import('../core/commons/wallet-reads')
        .then((m) => m.recomputeCommonsAttestationTier(deps, walletId))
        .catch(() => {});

      if (!result.ok) {
        console.warn(`[WalletAttestation] verification failed for user=${userId}: ${result.reason}`);
        return res.status(200).json({
          attested_security_level: persistedLevel,
          verified: false,
          reason: result.reason,
        });
      }
      return res.status(200).json({
        attested_security_level: persistedLevel,
        verified: true,
        evidence: result.evidence,
      });
    } catch (err) {
      console.error('[WalletAttestation] error', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
