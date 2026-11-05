import * as crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalParentAuthorizationMessage,
  signParentAuthorization,
  fetchParentAuthorization,
} from './parent-pop';
import { generateAgentKeyPair } from './wallet';

// ---------------------------------------------------------------------------
// Independent re-implementation of the RELAY's verifier
// (provian-backend core/agent-wallet/proof-of-possession.ts:
// uncompressedHexToSpkiPem + crypto.createVerify('SHA256')). This is NOT a copy
// of anything in the SDK under test — the SDK only SIGNS; the counterparty that
// VERIFIES is the relay. Verifying the SDK's signature against this independent
// re-derivation of the relay contract is the real assertion; a signature that
// only verifies against the SDK's own logic would prove nothing.
// ---------------------------------------------------------------------------
function spkiPemFromUncompressedHex(pubKeyHexNoPrefix: string): string {
  let cleaned = pubKeyHexNoPrefix.toLowerCase().replace(/^0x/, '');
  if (cleaned.length === 130 && cleaned.startsWith('04')) cleaned = cleaned.slice(2);
  if (cleaned.length !== 128) throw new Error(`expected 64-byte pubkey, got ${cleaned.length / 2}`);
  const pubKeyBytes = Buffer.from('04' + cleaned, 'hex');
  const spkiHeaderHex = '3056301006072a8648ce3d020106052b8104000a034200';
  const der = Buffer.concat([Buffer.from(spkiHeaderHex, 'hex'), pubKeyBytes]);
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

function relayVerifies(message: string, signatureHex: string, pubKeyHex: string): boolean {
  const v = crypto.createVerify('SHA256');
  v.update(message);
  return v.verify(spkiPemFromUncompressedHex(pubKeyHex), Buffer.from(signatureHex, 'hex'));
}

const CHALLENGE = 'a'.repeat(64);
const PARENT_WALLET_ID = 'wallet_aw_parent0001';
const CHILD_ADDRESS = '0xAbCdEf0123456789012345678901234567890123';

it('keeps an X coordinate beginning with 04 for prefixless and SEC1 keys', () => {
  // Fixed synthetic scalar 45 has a public X coordinate beginning with 04.
  const scalar = Buffer.alloc(32); scalar.writeUInt32BE(45, 28);
  const ec = crypto.createECDH('secp256k1'); ec.setPrivateKey(scalar);
  const sec1 = ec.getPublicKey(undefined, 'uncompressed');
  const raw = sec1.subarray(1).toString('hex');
  expect(raw.slice(0, 2)).toBe('04');
  const key = crypto.createPrivateKey({format:'jwk',key:{kty:'EC',crv:'secp256k1',d:scalar.toString('base64url'),x:sec1.subarray(1,33).toString('base64url'),y:sec1.subarray(33).toString('base64url')}});
  const message = 'parent test key control';
  const signature = crypto.sign('sha256',Buffer.from(message),key).toString('hex');
  for (const value of [raw, sec1.toString('hex'), '0x'+raw]) {
    expect(relayVerifies(message,signature,value)).toBe(true);
    expect(relayVerifies(message+' changed',signature,value)).toBe(false);
  }
});

describe('canonicalParentAuthorizationMessage', () => {
  it('produces the exact backend wire format (purpose\\nchallenge\\nsorted-claims)', () => {
    // Claims are sorted by key: child_address < parent_wallet_id.
    const msg = canonicalParentAuthorizationMessage(CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      child_address: 'lower',
    });
    expect(msg).toBe(
      `parent_authorization\n${CHALLENGE}\nchild_address=lower|parent_wallet_id=${PARENT_WALLET_ID}`,
    );
  });

  it('sorts claim keys deterministically regardless of insertion order', () => {
    const a = canonicalParentAuthorizationMessage(CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      child_address: 'x',
    });
    // Same claims, reversed literal order — must serialize identically.
    const b = canonicalParentAuthorizationMessage(CHALLENGE, {
      child_address: 'x',
      parent_wallet_id: PARENT_WALLET_ID,
    } as { parent_wallet_id: string; child_address: string });
    expect(a).toBe(b);
  });
});

describe('signParentAuthorization', () => {
  it('produces a signature the relay verifier accepts over the canonical message', () => {
    const parent = generateAgentKeyPair();
    const sig = signParentAuthorization(parent.privateKey, CHALLENGE, PARENT_WALLET_ID, CHILD_ADDRESS);
    const expectedMessage = canonicalParentAuthorizationMessage(CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      // The signer lowercases child_address to match the relay's stored claim.
      child_address: CHILD_ADDRESS.toLowerCase(),
    });
    expect(relayVerifies(expectedMessage, sig, parent.publicKey)).toBe(true);
  });

  it('lowercases child_address so it byte-matches the relay claim (not the mixed-case input)', () => {
    const parent = generateAgentKeyPair();
    const sig = signParentAuthorization(parent.privateKey, CHALLENGE, PARENT_WALLET_ID, CHILD_ADDRESS);
    // RED CONTROL: the mixed-case address must NOT verify (the relay stores and
    // expects the lowercased form). If the signer stopped lowercasing, the
    // lowercased-message assertion above would fail and this would pass — the
    // pair pins the exact casing the relay verifies.
    const mixedCaseMessage = canonicalParentAuthorizationMessage(CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      child_address: CHILD_ADDRESS, // NOT lowercased
    });
    expect(relayVerifies(mixedCaseMessage, sig, parent.publicKey)).toBe(false);
  });

  it('RED CONTROL: verification fails when any bound field is tampered', () => {
    const parent = generateAgentKeyPair();
    const sig = signParentAuthorization(parent.privateKey, CHALLENGE, PARENT_WALLET_ID, CHILD_ADDRESS);
    const base = { parent_wallet_id: PARENT_WALLET_ID, child_address: CHILD_ADDRESS.toLowerCase() };

    // Wrong challenge.
    expect(relayVerifies(
      canonicalParentAuthorizationMessage('b'.repeat(64), base), sig, parent.publicKey,
    )).toBe(false);
    // Wrong parent_wallet_id (a different parent claiming this child).
    expect(relayVerifies(
      canonicalParentAuthorizationMessage(CHALLENGE, { ...base, parent_wallet_id: 'wallet_aw_attacker01' }),
      sig, parent.publicKey,
    )).toBe(false);
    // Wrong child_address (re-binding the parent's signature to a different child).
    expect(relayVerifies(
      canonicalParentAuthorizationMessage(CHALLENGE, { ...base, child_address: `0x${'9'.repeat(40)}` }),
      sig, parent.publicKey,
    )).toBe(false);
    // Wrong purpose (an agent_connect PoP replayed as parent authorization).
    expect(relayVerifies(
      `agent_connect\n${CHALLENGE}\nchild_address=${base.child_address}|parent_wallet_id=${PARENT_WALLET_ID}`,
      sig, parent.publicKey,
    )).toBe(false);
    // Wrong key (a different parent's key over the correct message).
    const other = generateAgentKeyPair();
    expect(relayVerifies(
      canonicalParentAuthorizationMessage(CHALLENGE, base), sig, other.publicKey,
    )).toBe(false);
  });
});

describe('fetchParentAuthorization', () => {
  it('GETs the parent-challenge (lowercased child_address) and returns a relay-verifiable proof', async () => {
    const parent = generateAgentKeyPair();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ challenge_id: 'parent-ch-1', challenge: CHALLENGE, expires_at: 1 }),
      };
    });

    const proof = await fetchParentAuthorization({
      relayUrl: 'https://relay.test/',
      parentWalletId: PARENT_WALLET_ID,
      childAddress: CHILD_ADDRESS,
      parentPrivateKey: parent.privateKey,
      fetchImpl,
    });

    // URL shape: trailing slash trimmed, both claims present, child lowercased.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `https://relay.test/v1/agent/wallet/parent-challenge` +
      `?parent_wallet_id=${PARENT_WALLET_ID}` +
      `&child_address=${encodeURIComponent(CHILD_ADDRESS.toLowerCase())}`,
    );

    expect(proof.challenge_id).toBe('parent-ch-1');
    // The returned signature must verify under the parent's key over exactly the
    // message the relay reconstructs from the stored claims.
    const relayMessage = canonicalParentAuthorizationMessage(CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      child_address: CHILD_ADDRESS.toLowerCase(),
    });
    expect(relayVerifies(relayMessage, proof.signature, parent.publicKey)).toBe(true);
  });

  it('surfaces the relay error detail when the parent-challenge is rejected', async () => {
    const parent = generateAgentKeyPair();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'parent_wallet_id not found' }),
    }));
    await expect(fetchParentAuthorization({
      relayUrl: 'https://relay.test',
      parentWalletId: PARENT_WALLET_ID,
      childAddress: CHILD_ADDRESS,
      parentPrivateKey: parent.privateKey,
      fetchImpl,
    })).rejects.toThrow('parent challenge failed (HTTP 404): parent_wallet_id not found');
  });

  it('throws when the parent-challenge response is missing challenge fields', async () => {
    const parent = generateAgentKeyPair();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ challenge_id: 'only-id' }),
    }));
    await expect(fetchParentAuthorization({
      relayUrl: 'https://relay.test',
      parentWalletId: PARENT_WALLET_ID,
      childAddress: CHILD_ADDRESS,
      parentPrivateKey: parent.privateKey,
      fetchImpl,
    })).rejects.toThrow('missing challenge_id/challenge');
  });
});
