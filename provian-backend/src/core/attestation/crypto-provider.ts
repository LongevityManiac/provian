/**
 * Wire @peculiar/x509 to Node's built-in WebCrypto so certificate signature
 * verification works server-side without an ESM-only crypto dependency. Mirrors
 * the webcrypto usage already established in device-signature-binding.ts.
 *
 * Importing this module for its side effect is idempotent and safe.
 */
import { webcrypto } from 'crypto';
import { cryptoProvider } from '@peculiar/x509';

// Derive the provider's expected crypto type from its own signature rather than
// naming the DOM `Crypto` global (this tsconfig has no DOM lib). `webcrypto`
// satisfies the structural interface @peculiar/x509 needs (subtle.verify /
// subtle.digest). Set once at module load; idempotent.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0];

cryptoProvider.set(webcrypto as unknown as PeculiarCrypto);

/** Node's WebCrypto, used for SPKI/raw key import-export in the verifier. */
export const nodeCrypto = webcrypto;
