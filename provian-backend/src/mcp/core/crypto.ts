/**
 * Agent-key crypto for the MCP tool core.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into
 * `provian-backend/src/mcp/core/`. Edit only the canonical copy.
 *
 * Line-for-line ports of the SDK's key handling so the relay accepts
 * signatures from either package interchangeably:
 *   - generateAgentKeyPair / signPoPChallenge ← provian-agent-sdk/src/wallet.ts
 *     (Node crypto secp256k1 keygen; PoP challenge signed with
 *     createSign('SHA256') → DER hex, exactly what
 *     POST /v1/agent/wallet/create verifies)
 *
 * Deliberately Node-crypto-only (zero npm deps beyond the vendored keccak):
 * the mirror compiles inside the relay with no new dependencies. EIP-191
 * signing (external-address one-shot linking, local mode only) is NOT here —
 * it is injected by the local stdio server via ToolContext.signEip191; the
 * remote endpoint refuses private-key material by design.
 */

import { generateKeyPairSync, createSign, createPrivateKey, createPublicKey } from 'crypto';
import { keccak256 } from './keccak256';

export interface AgentKeyPair {
  /** 32-byte private key, hex, no 0x prefix. */
  privateKey: string;
  /** 64-byte uncompressed public key (no 04 prefix), hex. */
  publicKey: string;
  /** EIP-55 checksummed EVM address. */
  address: string;
}

/**
 * Generate a new secp256k1 key pair using Node.js crypto and derive the
 * EVM address (keccak256 of the raw public key, last 20 bytes).
 */
export function generateAgentKeyPair(): AgentKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
  });

  const privKeyDer = privateKey.export({ type: 'sec1', format: 'der' });
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });

  // SEC1 DER: private key OCTET STRING starts at offset 7 (30 xx 02 01 01 04 20)
  const privKeyHex = privKeyDer.subarray(7, 7 + 32).toString('hex');

  // Uncompressed public key = last 65 bytes of SPKI DER; skip the 04 prefix
  const pubKeyRaw = pubKeyDer.subarray(pubKeyDer.length - 65);
  const pubKeyHex = pubKeyRaw.subarray(1).toString('hex');

  const addressHash = keccak256(Buffer.from(pubKeyRaw.subarray(1)));
  const address = toChecksumAddress('0x' + addressHash.subarray(12).toString('hex'));

  return { privateKey: privKeyHex, publicKey: pubKeyHex, address };
}

/**
 * Sign a wallet-create proof-of-possession challenge with the agent's
 * private key. Plain ECDSA-SHA256 over the challenge string, DER-encoded
 * hex — byte-identical to the SDK's `signMessage` and exactly what the
 * relay's challenge verifier expects.
 */
export function signPoPChallenge(privateKeyHex: string, challenge: string): string {
  const privKeyBuf = Buffer.from(stripHexPrefix(privateKeyHex), 'hex');
  const privKey = createPrivateKey({
    key: buildSec1Der(privKeyBuf),
    format: 'der',
    type: 'sec1',
  });

  const signer = createSign('SHA256');
  signer.update(challenge);
  return signer.sign(privKey, 'hex');
}

/** Derive the EIP-55 checksummed EVM address for a hex private key. */
export function deriveAddressFromPrivateKey(privateKeyHex: string): string {
  const pubKeyRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(derivePublicKeyFromPrivateKey(privateKeyHex), 'hex'),
  ]);
  const addressHash = keccak256(Buffer.from(pubKeyRaw.subarray(1)));
  return toChecksumAddress('0x' + addressHash.subarray(12).toString('hex'));
}

/** Derive the 64-byte uncompressed public key (without the 04 prefix). */
export function derivePublicKeyFromPrivateKey(privateKeyHex: string): string {
  const clean = stripHexPrefix(privateKeyHex.trim().toLowerCase());
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('Private key must be 32 bytes (64 hex chars)');
  }
  const privKeyBuf = Buffer.from(clean, 'hex');

  const ecPrivKey = createPrivateKey({
    key: buildSec1Der(privKeyBuf),
    format: 'der',
    type: 'sec1',
  });
  const ecPubKey = createPublicKey(ecPrivKey);
  const pubKeyDer = ecPubKey.export({ type: 'spki', format: 'der' });
  const pubKeyRaw = pubKeyDer.subarray(pubKeyDer.length - 65);
  if (pubKeyRaw[0] !== 0x04) {
    throw new Error('Unexpected public key format (expected uncompressed)');
  }
  return pubKeyRaw.subarray(1).toString('hex');
}

/** Build a SEC1 DER encoding for a secp256k1 private key. */
function buildSec1Der(privKeyBytes: Buffer): Buffer {
  // OID for secp256k1: 1.3.132.0.10
  const oid = Buffer.from('06052b8104000a', 'hex');
  const privKeyOctetString = Buffer.concat([
    Buffer.from([0x04, privKeyBytes.length]),
    privKeyBytes,
  ]);
  const oidWrapped = Buffer.concat([Buffer.from([0xa0, oid.length]), oid]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const innerLength = version.length + privKeyOctetString.length + oidWrapped.length;
  return Buffer.concat([
    Buffer.from([0x30, innerLength]),
    version,
    privKeyOctetString,
    oidWrapped,
  ]);
}

/** EIP-55 checksum address encoding. */
function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace('0x', '');
  const hash = keccak256(Buffer.from(addr, 'utf8')).toString('hex');

  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return checksummed;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}
