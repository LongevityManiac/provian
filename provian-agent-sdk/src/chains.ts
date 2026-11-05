/**
 * EVM address derivation for agent wallets.
 *
 * Derives an EVM checksummed address from a secp256k1 private key.
 * This module relies only on Node.js built-in crypto and the local keccak256
 * (no runtime deps of its own); the SDK as a whole has minimal runtime deps
 * (@noble/curves + @scure/base for crypto; viem for the EVM signer/bond paths).
 */
import { createHash, createPrivateKey, createPublicKey } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { keccak256 } from './keccak256';

// ---------------------------------------------------------------------------
// Internal: extract secp256k1 public key from private key hex
// ---------------------------------------------------------------------------

function buildSec1Der(privKeyBytes: Buffer): Buffer {
  const oid = Buffer.from('06052b8104000a', 'hex');
  const privOctet = Buffer.concat([Buffer.from([0x04, 32]), privKeyBytes]);
  const oidWrapped = Buffer.concat([Buffer.from([0xa0, oid.length]), oid]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const inner = Buffer.concat([version, privOctet, oidWrapped]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}

function extractUncompressedPublicKey(privKeyHex: string): Buffer {
  const privKeyBuf = Buffer.from(privKeyHex, 'hex');
  const ecPrivKey = createPrivateKey({ key: buildSec1Der(privKeyBuf), format: 'der', type: 'sec1' });
  const pubKeyDer = createPublicKey(ecPrivKey).export({ type: 'spki', format: 'der' });
  const raw = pubKeyDer.subarray(pubKeyDer.length - 65);
  return Buffer.from(raw.subarray(1)); // 64 bytes: x || y
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Domain-separated ed25519 seed for the agent's Solana keypair, derived from
 * its existing secp256k1 secret. Deterministic — the same keystore always
 * yields the same Solana address, so there is no new key to persist or back up.
 * Single source of truth for the KDF (x402-signer-svm.ts feeds this to
 * Keypair.fromSeed for signing; this module uses it for the address).
 */
export function deriveSolanaEd25519Seed(privKeyHex: string): Uint8Array {
  const clean = privKeyHex.startsWith('0x') ? privKeyHex.slice(2) : privKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('Invalid private key (expected 32-byte hex)');
  }
  const privBytes = Uint8Array.from(Buffer.from(clean, 'hex'));
  const domain = new TextEncoder().encode('provian:solana:x402:v1');
  const material = new Uint8Array(privBytes.length + domain.length);
  material.set(privBytes, 0);
  material.set(domain, privBytes.length);
  return sha512(material).slice(0, 32);
}

/**
 * Derive the agent's Solana address (base58) from its secp256k1 private key.
 * noble/scure only — no @solana/web3.js — so this stays on the light path used
 * by wallet.ts. Byte-identical to Keypair.fromSeed(seed).publicKey.toBase58().
 */
export function deriveSolanaAddress(privKeyHex: string): string {
  const seed = deriveSolanaEd25519Seed(privKeyHex);
  const pub = ed25519.getPublicKey(seed);
  return base58.encode(pub);
}

/**
 * Derive an EVM address from a secp256k1 private key.
 */
export function deriveEVMAddress(privKeyHex: string): string {
  const uncompressed = extractUncompressedPublicKey(privKeyHex);
  const hash = keccak256(uncompressed);
  const addr = hash.subarray(12).toString('hex');
  // EIP-55 checksum
  const addrHash = keccak256(Buffer.from(addr)).toString('hex');
  let checksummed = '0x';
  for (let i = 0; i < addr.length; i++) {
    checksummed += parseInt(addrHash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return checksummed;
}
