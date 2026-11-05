/**
 * Agent API Key - Generation and verification
 *
 * Uses Node.js built-in crypto for all operations:
 * - crypto.randomBytes for key/secret generation
 * - crypto.scryptSync for password hashing
 * - crypto.timingSafeEqual for constant-time comparison
 *
 * API key format: pvn_live_{32 hex chars}
 * API secret format: pvns_{64 hex chars}
 *
 * Storage: Only the scrypt hash and salt are stored. The raw key/secret
 * are returned once at creation time and never persisted.
 */

import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;   // N = 2^14 - good balance of security and speed
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLEL = 1;   // p

export interface ApiCredentials {
  api_key: string;          // pvn_live_{32hex} - for identification
  api_secret: string;       // pvns_{64hex} - for authentication
  api_key_prefix: string;   // First 24 chars of api_key (for index lookup)
  api_key_hash: string;     // scrypt hash (hex)
  api_key_salt: string;     // Random salt (hex)
}

/**
 * Generate new API credentials for an agent wallet.
 * Returns the raw key/secret (return once) plus the hash/salt (store in Firestore).
 */
export function generateApiCredentials(): ApiCredentials {
  const api_key = 'pvn_live_' + crypto.randomBytes(16).toString('hex');
  const api_secret = 'pvns_' + crypto.randomBytes(32).toString('hex');
  const api_key_prefix = api_key.slice(0, 24);

  const salt = crypto.randomBytes(32).toString('hex');
  const combined = `${api_key}:${api_secret}`;
  const hash = crypto.scryptSync(combined, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
  }).toString('hex');

  return {
    api_key,
    api_secret,
    api_key_prefix,
    api_key_hash: hash,
    api_key_salt: salt,
  };
}

/**
 * Async version - uses crypto.scrypt to avoid blocking the event loop during load.
 */
export function generateApiCredentialsAsync(proposed?: { api_key: string; api_secret: string }): Promise<ApiCredentials> {
  if (proposed && (!/^pvn_live_[0-9a-f]{32}$/.test(proposed.api_key) || !/^pvns_[0-9a-f]{64}$/.test(proposed.api_secret))) {
    throw new Error('Invalid proposed rotation credentials');
  }
  const api_key = proposed?.api_key ?? 'pvn_live_' + crypto.randomBytes(16).toString('hex');
  const api_secret = proposed?.api_secret ?? 'pvns_' + crypto.randomBytes(32).toString('hex');
  const api_key_prefix = api_key.slice(0, 24);

  const salt = crypto.randomBytes(32).toString('hex');
  const combined = `${api_key}:${api_secret}`;

  return new Promise((resolve, reject) => {
    crypto.scrypt(combined, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLEL,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({
        api_key,
        api_secret,
        api_key_prefix,
        api_key_hash: derivedKey.toString('hex'),
        api_key_salt: salt,
      });
    });
  });
}

/**
 * Verify an API key:secret pair against the stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @deprecated Use verifyApiCredentialAsync instead - scryptSync blocks the event loop.
 */
export function verifyApiCredential(
  apiKey: string,
  apiSecret: string,
  storedHash: string,
  storedSalt: string,
): boolean {
  const combined = `${apiKey}:${apiSecret}`;
  const computedHash = crypto.scryptSync(combined, storedSalt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
  });

  const storedBuf = Buffer.from(storedHash, 'hex');
  if (storedBuf.length !== computedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedHash, storedBuf);
}

/**
 * Async version of verifyApiCredential - uses crypto.scrypt to avoid blocking
 * the event loop under concurrent agent request load.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyApiCredentialAsync(
  apiKey: string,
  apiSecret: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  const combined = `${apiKey}:${apiSecret}`;

  return new Promise((resolve, reject) => {
    crypto.scrypt(combined, storedSalt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLEL,
    }, (err, computedHash) => {
      if (err) return reject(err);

      const storedBuf = Buffer.from(storedHash, 'hex');
      if (storedBuf.length !== computedHash.length) {
        return resolve(false);
      }

      resolve(crypto.timingSafeEqual(computedHash, storedBuf));
    });
  });
}
