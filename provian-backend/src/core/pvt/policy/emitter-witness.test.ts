/** Trust Layer build §2.3/§2.8 — relay-composed lanes derive their witness class by identifier type. */
import { deriveEmitterWitnessClass, deriveOutputDigestsFromMetadata } from './emitter-witness';

const TX = `0x${'ab'.repeat(32)}`;
const SHA = 'c'.repeat(40);

describe('deriveEmitterWitnessClass', () => {
  it('a verified chain log identity / tx hash → chain_witnessed (watchers, transfer/record)', () => {
    expect(deriveEmitterWitnessClass({ metadata: { verified: true }, observedCanonicalEventId: `8453:${TX}:3` })).toBe('chain_witnessed');
    expect(deriveEmitterWitnessClass({ metadata: { verified: true, tx_hash: TX } })).toBe('chain_witnessed');
    expect(deriveEmitterWitnessClass({ metadata: { verified: true, canonical_event_id: `chaintx:8453:${TX}:0` } })).toBe('chain_witnessed');
  });
  it('a verified forge commit → forge_witnessed; other verified → relay_verified', () => {
    expect(deriveEmitterWitnessClass({ metadata: { verified: true, commit_sha: SHA } })).toBe('forge_witnessed');
    expect(deriveEmitterWitnessClass({ metadata: { verified: true } })).toBe('relay_verified');
  });
  it('RED — no verified stamp is actor_declared whatever the body names; an explicit valid class wins; junk declared is ignored', () => {
    expect(deriveEmitterWitnessClass({ metadata: { tx_hash: TX, commit_sha: SHA } })).toBe('actor_declared');
    expect(deriveEmitterWitnessClass({ metadata: { verified: 'true', tx_hash: TX } })).toBe('actor_declared');
    expect(deriveEmitterWitnessClass({ declared: 'hardware_rooted', metadata: { verified: true, tx_hash: TX } })).toBe('hardware_rooted');
    expect(deriveEmitterWitnessClass({ declared: 'god_mode', metadata: { verified: true, tx_hash: TX } })).toBe('chain_witnessed');
    // a chain-shaped id that is NOT a tx hash is not chain evidence
    expect(deriveEmitterWitnessClass({ metadata: { verified: true }, observedCanonicalEventId: 'base:8453:pe_receive:0' })).toBe('relay_verified');
  });
});

describe('deriveOutputDigestsFromMetadata', () => {
  it('a verified event names its commit / tx as output digests (chain locator only when chain_id rides)', () => {
    expect(deriveOutputDigestsFromMetadata({ verified: true, commit_sha: SHA.toUpperCase() })).toEqual([{ hash: `git:${SHA}`, kind: 'commit' }]);
    expect(deriveOutputDigestsFromMetadata({ verified: true, tx_hash: TX, chain_id: 8453 })).toEqual([{ hash: `evmtx:${TX}`, kind: 'tx', locator: 'chain:eip155:8453' }]);
    expect(deriveOutputDigestsFromMetadata({ verified: true, settlementTxHash: TX })).toEqual([{ hash: `evmtx:${TX}`, kind: 'tx' }]);
  });
  it('RED — unverified → null (a claim is not an output); verified with nothing observable → null, never a placeholder', () => {
    expect(deriveOutputDigestsFromMetadata({ tx_hash: TX })).toBeNull();
    expect(deriveOutputDigestsFromMetadata({ verified: true })).toBeNull();
    expect(deriveOutputDigestsFromMetadata({ verified: true, tx_hash: '0x1234', commit_sha: 'notasha' })).toBeNull();
  });
});
