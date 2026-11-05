/**
 * Tests for human-side EIP-191 link consent signing.
 *
 * Verifies that signLinkPayload produces signatures the relay backend
 * (which uses ethers.verifyMessage) will accept and recover the correct
 * EVM address from.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { signLinkPayload, type LinkPayload, type ShareChangePayload, type UnlinkPayload } from './link-signing';

// A deterministic test private key (NOT a real wallet - for tests only).
// Address: 0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1
const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';

// Stable canonicalization of an object - keys sorted alphabetically.
// Mirrors what the relay reconstructs via json-stable-stringify.
function expectedCanonical(input: object): string {
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

describe('signLinkPayload', () => {
  it('produces a 65-byte hex signature with 0x prefix', () => {
    const payload: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const sig = signLinkPayload(TEST_PRIV_KEY, payload);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('signature recovers to the test address via ethers.verifyMessage', () => {
    const payload: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const canonical = expectedCanonical(payload);
    const sig = signLinkPayload(TEST_PRIV_KEY, payload);
    const recovered = ethers.verifyMessage(canonical, sig);
    expect(recovered).toBe(TEST_ADDRESS);
  });

  it('handles unsigned-private-key input (no 0x prefix)', () => {
    const payload: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const sigA = signLinkPayload(TEST_PRIV_KEY, payload);
    const sigB = signLinkPayload(TEST_PRIV_KEY.slice(2), payload);
    expect(sigA).toBe(sigB);
  });

  it('rejects malformed private key', () => {
    const payload: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    expect(() => signLinkPayload('0xdeadbeef', payload)).toThrow(/32 bytes/);
  });

  it('signs unlink payloads with the same recovery model', () => {
    const payload: UnlinkPayload = {
      action: 'unlink_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const canonical = expectedCanonical(payload);
    const sig = signLinkPayload(TEST_PRIV_KEY, payload);
    const recovered = ethers.verifyMessage(canonical, sig);
    expect(recovered).toBe(TEST_ADDRESS);
  });

  it('produces different signatures for different timestamps', () => {
    const baseA: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const baseB: LinkPayload = { ...baseA, timestamp: 1730000000001 };
    expect(signLinkPayload(TEST_PRIV_KEY, baseA)).not.toBe(
      signLinkPayload(TEST_PRIV_KEY, baseB),
    );
  });

  // link / unlink / share-change signatures are single-use — each names the relationship
  // epoch it moves from, so the same consent at another epoch is a DIFFERENT signed message.
  it('binds link_epoch into the signed bytes (the relay\'s single-use epoch)', () => {
    const atEpoch3: LinkPayload = {
      action: 'link_agent',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 3,
      timestamp: 1730000000000,
    };
    const atEpoch4: LinkPayload = { ...atEpoch3, link_epoch: 4 };
    expect(expectedCanonical(atEpoch3)).toContain('"link_epoch":3');
    const sig3 = signLinkPayload(TEST_PRIV_KEY, atEpoch3);
    // RED control: a signature over epoch 3 does not verify as consent at epoch 4.
    expect(ethers.verifyMessage(expectedCanonical(atEpoch4), sig3)).not.toBe(TEST_ADDRESS);
    expect(ethers.verifyMessage(expectedCanonical(atEpoch3), sig3)).toBe(TEST_ADDRESS);
  });

  it('signs share-change payloads (bps + epoch bound) with the same recovery model', () => {
    const payload: ShareChangePayload = {
      action: 'update_beneficiary_share',
      agent_wallet_id: 'wallet_atlas',
      human_wallet_id: 'wallet_frank',
      link_epoch: 5,
      operational_reserve_bps: 3000,
      timestamp: 1730000000000,
    };
    const canonical = expectedCanonical(payload);
    expect(canonical).toBe('{"action":"update_beneficiary_share","agent_wallet_id":"wallet_atlas","human_wallet_id":"wallet_frank","link_epoch":5,"operational_reserve_bps":3000,"timestamp":1730000000000}');
    const sig = signLinkPayload(TEST_PRIV_KEY, payload);
    expect(ethers.verifyMessage(canonical, sig)).toBe(TEST_ADDRESS);
    expect(ethers.verifyMessage(expectedCanonical({ ...payload, operational_reserve_bps: 5000 }), sig)).not.toBe(TEST_ADDRESS);
  });
});
