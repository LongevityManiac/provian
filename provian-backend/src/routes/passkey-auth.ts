/**
 * Passkey Authentication - Backend Endpoints (C-4)
 *
 * Server-side challenge generation and assertion verification for WebAuthn passkeys.
 *
 * Endpoints:
 *   POST /v1/auth/passkey/challenge  - Generate a cryptographic challenge
 *   POST /v1/auth/passkey/verify     - Verify assertion and return session token
 *
 * Challenge flow:
 *   1. Client requests challenge with userId
 *   2. Server generates 32-byte random challenge, stores with 5-min expiry
 *   3. Client passes challenge to Passkey.get()
 *   4. Client sends assertion to /verify
 *   5. Server verifies signature against stored public key, returns session token
 *   6. Challenge is invalidated after first use
 */

import { Router, Request, Response } from 'express';
import crypto, { webcrypto } from 'crypto';
import admin from 'firebase-admin';
import type { RedisCache } from '../cache';

// STEP 9 (Wave 4): Node webcrypto for ECDSA-P256 verification + Node's
// crypto.createHash for sha256. The previous lazy-loaded
// `@noble/curves/p256` subpath is not in @noble/curves v2's exports map
// and would throw at runtime - silently broken because no test exercised
// passkey verification before Wave 4.
function sha256Bytes(input: Uint8Array | Buffer): Buffer {
    return crypto.createHash('sha256').update(input).digest();
}
async function verifyEcdsaP256Webcrypto(input: {
    publicKeyHex: string;
    signature: Uint8Array;
    message: Uint8Array;
}): Promise<boolean> {
    const subtle = (crypto as unknown as { webcrypto: webcrypto.Crypto }).webcrypto.subtle;
    const pubKey = await subtle.importKey(
        'raw',
        Buffer.from(input.publicKeyHex, 'hex'),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
    );
    return subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        input.signature,
        input.message,
    );
}

export interface PasskeyAuthDeps {
    db: admin.firestore.Firestore;
    cache: RedisCache;
    sessionSecret: string;
    /** Expected RP ID for WebAuthn verification (e.g. "provian.ai") */
    rpId: string;
}

const CHALLENGE_EXPIRY_SECONDS = 300; // 5 minutes
const CHALLENGE_PREFIX = 'passkey_challenge:';
const PASSKEY_COLLECTION = 'passkey_credentials';

export function createPasskeyAuthRouter(deps: PasskeyAuthDeps): Router {
    const { db, cache, sessionSecret, rpId } = deps;
    const router = Router();

    // =========================================================================
    // POST /challenge - Generate a cryptographic challenge
    // =========================================================================
    router.post('/challenge', async (req: Request, res: Response) => {
        try {
            const { userId } = req.body;
            if (!userId || typeof userId !== 'string') {
                res.status(400).json({ error: 'userId is required' });
                return;
            }

            // Rate limit: 10/min per userId. Strict (fail-closed): passkey
            // challenge issuance gates authentication; brute-forcing must not
            // benefit from a Redis outage.
            const rateLimit = await cache.checkRateLimitStrict(
                `rl:passkey-challenge:${userId}`,
                10,
                60
            );
            if (!rateLimit.allowed) {
                res.status(429).json({ error: 'Rate limit exceeded', retry_after: rateLimit.retryAfter });
                return;
            }

            // Generate 32-byte cryptographically random challenge
            const challengeBytes = crypto.randomBytes(32);
            const challenge = challengeBytes.toString('base64url');

            // Store challenge with expiry, bound to userId
            const challengeKey = `${CHALLENGE_PREFIX}${challenge}`;
            await cache.set(challengeKey, JSON.stringify({
                userId,
                createdAt: Date.now(),
                used: false,
            }), CHALLENGE_EXPIRY_SECONDS);

            res.json({ challenge });
        } catch (error) {
            console.error('[PasskeyAuth] Challenge error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // =========================================================================
    // POST /verify - Verify assertion and return session token
    // =========================================================================
    router.post('/verify', async (req: Request, res: Response) => {
        try {
            const { credentialId, clientDataJSON, authenticatorData, signature } = req.body;

            if (!credentialId || typeof credentialId !== 'string') {
                res.status(400).json({ error: 'credentialId is required' });
                return;
            }
            if (!clientDataJSON || typeof clientDataJSON !== 'string') {
                res.status(400).json({ error: 'clientDataJSON is required' });
                return;
            }
            if (!authenticatorData || typeof authenticatorData !== 'string') {
                res.status(400).json({ error: 'authenticatorData is required' });
                return;
            }
            if (!signature || typeof signature !== 'string') {
                res.status(400).json({ error: 'signature is required' });
                return;
            }

            // 1. Decode clientDataJSON and extract challenge
            let clientData: { challenge?: string; origin?: string; type?: string };
            try {
                clientData = JSON.parse(
                    Buffer.from(clientDataJSON, 'base64').toString('utf8')
                );
            } catch {
                res.status(400).json({ error: 'Invalid clientDataJSON' });
                return;
            }

            if (!clientData.challenge) {
                res.status(400).json({ error: 'Missing challenge in clientDataJSON' });
                return;
            }

            // 2. Validate challenge exists and hasn't been used.
            // Phase 2.13 (Theme 8): the previous "read flag → set flag" pattern
            // had a TOCTOU race that let two parallel verifications both pass
            // the `used === false` check. We now atomically claim the
            // challenge by writing a "consumed" marker via SETNX. The first
            // verifier wins; everyone else gets a 401.
            const challengeKey = `${CHALLENGE_PREFIX}${clientData.challenge}`;
            const challengeDataStr = await cache.get<string>(challengeKey);
            if (!challengeDataStr) {
                res.status(401).json({ error: 'Challenge expired or not found' });
                return;
            }

            const challengeData = JSON.parse(String(challengeDataStr)) as {
                userId: string;
                createdAt: number;
                used: boolean;
            };

            // Atomic single-use claim. The marker key shadows the challenge
            // for 10 minutes; concurrent verifiers see SETNX fail and bail.
            const claimKey = `${CHALLENGE_PREFIX}claimed:${clientData.challenge}`;
            const claimed = await cache.setNx(claimKey, '1', 600);
            if (!claimed) {
                res.status(401).json({ error: 'Challenge already used' });
                return;
            }
            // Best-effort cleanup of the original challenge entry now that
            // we own this verification.
            await cache.del(challengeKey);

            // 4. Verify origin and type
            if (clientData.origin !== 'https://provian.ai') {
                res.status(401).json({ error: 'Invalid origin' });
                return;
            }
            if (clientData.type !== 'webauthn.get') {
                res.status(401).json({ error: 'Invalid type' });
                return;
            }

            // 5. Look up the user's registered public key
            const credDoc = await db.collection(PASSKEY_COLLECTION)
                .where('credential_id', '==', credentialId)
                .limit(1)
                .get();

            if (credDoc.empty) {
                res.status(401).json({ error: 'Credential not registered' });
                return;
            }

            const credData = credDoc.docs[0].data() as {
                credential_id: string;
                user_id: string;
                public_key_x: string;
                public_key_y: string;
                sign_count?: number;
            };

            // Verify the challenge was issued for this user
            if (credData.user_id !== challengeData.userId) {
                res.status(401).json({ error: 'Challenge/credential user mismatch' });
                return;
            }

            // 6. Validate authenticatorData per WebAuthn spec
            const authDataBytes = Buffer.from(authenticatorData, 'base64');

            // authenticatorData must be at least 37 bytes:
            //   bytes 0-31: rpIdHash (SHA-256 of RP ID)
            //   byte 32: flags (UP=bit0, UV=bit2, AT=bit6, ED=bit7)
            //   bytes 33-36: signCount (big-endian uint32)
            if (authDataBytes.length < 37) {
                res.status(401).json({ error: 'authenticatorData too short' });
                return;
            }

            // 6a. Verify RP ID hash (bytes 0-31) matches SHA-256 of expected RP ID
            const expectedRpIdHash = sha256Bytes(Buffer.from(rpId, 'utf8'));
            const actualRpIdHash = authDataBytes.subarray(0, 32);
            if (!expectedRpIdHash.equals(Buffer.from(actualRpIdHash))) {
                res.status(401).json({ error: 'RP ID hash mismatch' });
                return;
            }

            // 6b. Check UP (User Present) flag - bit 0 of byte 32. Required by WebAuthn.
            const flags = authDataBytes[32];
            if ((flags & 0x01) === 0) {
                res.status(401).json({ error: 'User presence flag not set' });
                return;
            }

            // 6c. Check UV (User Verified) flag - bit 2 of byte 32.
            // Required for Provian: passkeys must use biometric/PIN verification.
            if ((flags & 0x04) === 0) {
                res.status(401).json({ error: 'User verification flag not set' });
                return;
            }

            // 6d. Extract and validate signature counter (bytes 33-36, big-endian uint32).
            // A counter that does not advance may indicate a cloned authenticator.
            const signCount = (authDataBytes[33] << 24) |
                              (authDataBytes[34] << 16) |
                              (authDataBytes[35] << 8) |
                              authDataBytes[36];
            const storedSignCount = credData.sign_count ?? 0;

            // If both stored and incoming counters are non-zero, incoming must be greater
            if (storedSignCount > 0 || signCount > 0) {
                if (signCount <= storedSignCount) {
                    console.warn(
                        `[PasskeyAuth] Possible cloned authenticator: stored=${storedSignCount} incoming=${signCount} credentialId=${credentialId}`
                    );
                    res.status(401).json({ error: 'Signature counter did not advance - possible cloned authenticator' });
                    return;
                }
            }

            // 7. Verify P-256 ECDSA signature. webcrypto.subtle.verify
            // hashes the message internally with SHA-256, so we feed it the
            // WebAuthn signed pre-image (authData || sha256(clientData))
            // directly - same pre-image the @noble path was hashing
            // before passing to p256.verify.
            const clientDataBytes = Buffer.from(clientDataJSON, 'base64');
            const clientDataHash = sha256Bytes(clientDataBytes);
            const verificationData = new Uint8Array(authDataBytes.length + clientDataHash.length);
            verificationData.set(authDataBytes, 0);
            verificationData.set(clientDataHash, authDataBytes.length);

            const publicKeyHex = `04${credData.public_key_x}${credData.public_key_y}`;
            const signatureBytes = new Uint8Array(Buffer.from(signature, 'base64'));

            let isValid: boolean;
            try {
                isValid = await verifyEcdsaP256Webcrypto({
                    publicKeyHex,
                    signature: signatureBytes,
                    message: verificationData,
                });
            } catch {
                isValid = false;
            }

            if (!isValid) {
                res.status(401).json({ error: 'Signature verification failed' });
                return;
            }

            // 7a. Advance stored signature counter after successful verification
            await credDoc.docs[0].ref.update({ sign_count: signCount });

            // 7. Generate signed session token
            const sessionPayload = {
                userId: credData.user_id,
                credentialId: credData.credential_id,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
            };

            const sessionToken = generateHMACSessionToken(sessionPayload, sessionSecret);

            res.json({ sessionToken, userId: credData.user_id });
        } catch (error) {
            console.error('[PasskeyAuth] Verify error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

/**
 * Generate an HMAC-signed session token.
 */
function generateHMACSessionToken(
    payload: { userId: string; credentialId: string; issuedAt: number; expiresAt: number },
    secret: string
): string {
    const payloadStr = JSON.stringify(payload);
    const payloadBase64 = Buffer.from(payloadStr).toString('base64url');
    const hmac = crypto
        .createHmac('sha256', secret)
        .update(payloadBase64)
        .digest('base64url');
    return `${payloadBase64}.${hmac}`;
}
