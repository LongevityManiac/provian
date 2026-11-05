/**
 * origin-owner-to-signer (, Prompt 3). The owner→signer map the closed-loop detector uses.
 * Only an on-chain address in the canonical native index maps to a signer; every other scheme, an
 * absent row, and a corrupt row are external (null). A THROWING read propagates (detector -> unresolvable).
 * RED controls: a non-evm owner and an absent row must NOT resolve to a signer.
 */

import { makeOwnerToSigner } from './origin-owner-to-signer';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
} from './native-wallet-registration';

const ADDR = '0x' + 'a'.repeat(40);

/** A fake Firestore exposing only collection().doc().get() on the native index. */
function fakeDb(rows: Record<string, Record<string, unknown> | 'throw'>) {
  return {
    collection(name: string) {
      if (name !== NATIVE_WALLET_ADDRESS_INDEX_COLLECTION) throw new Error(`unexpected collection ${name}`);
      return {
        doc(id: string) {
          return {
            get: async () => {
              const row = rows[id];
              if (row === 'throw') throw new Error('firestore unavailable');
              return { exists: row !== undefined, data: () => row };
            },
          };
        },
      };
    },
  } as never;
}

const goodRow = (agentId: string): Record<string, unknown> => ({
  schema_version: CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
  chain_id: 8453,
  address: ADDR,
  wallet_id: `wallet_aw_${agentId}`,
  owner_type: 'agent',
  owner_id: agentId,
  created_at_ms: 1,
});

describe('makeOwnerToSigner', () => {
  it('maps evm:<addr> to the native index owner_id (the agent_id = the signer namespace)', async () => {
    const resolve = makeOwnerToSigner(fakeDb({ [nativeWalletAddressIndexId(ADDR)]: goodRow('agent_bob') }));
    expect(await resolve(`evm:${ADDR}`)).toBe('agent_bob');
  });

  // RED: a repo/domain/doi owner is an external party — never a signer, no read attempted.
  it('RED — a non-evm owner resolves to null (external party)', async () => {
    const resolve = makeOwnerToSigner(fakeDb({}));
    expect(await resolve('domain:arxiv.org')).toBeNull();
    expect(await resolve('repo-owner:torvalds')).toBeNull();
    expect(await resolve('doi-registrant:10.1145')).toBeNull();
  });

  // RED: an address with no index row is not a Provian native wallet.
  it('RED — an evm owner absent from the index resolves to null', async () => {
    const resolve = makeOwnerToSigner(fakeDb({}));
    expect(await resolve(`evm:${ADDR}`)).toBeNull();
  });

  it('a corrupt index row is treated as external (null), never a false ring', async () => {
    const resolve = makeOwnerToSigner(fakeDb({ [nativeWalletAddressIndexId(ADDR)]: { bogus: true } }));
    expect(await resolve(`evm:${ADDR}`)).toBeNull();
  });

  it('an uppercase/checksum address does not match the lowercased owner regex (null)', async () => {
    const resolve = makeOwnerToSigner(fakeDb({}));
    expect(await resolve(`evm:0x${'A'.repeat(40)}`)).toBeNull();
  });

  it('a THROWING read propagates (detector marks the determination unresolvable)', async () => {
    const resolve = makeOwnerToSigner(fakeDb({ [nativeWalletAddressIndexId(ADDR)]: 'throw' }));
    await expect(resolve(`evm:${ADDR}`)).rejects.toThrow('firestore unavailable');
  });
});
