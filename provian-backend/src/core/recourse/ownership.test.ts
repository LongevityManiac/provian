jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: requireConfiguredPvt9Runtime().address, recoursePool: `0x${'12'.repeat(20)}` }, runtimeHashes: Array(10).fill('0x0000000000000000000000000000000000000000000000000000000000000000') }) }));
import { requireConfiguredPvt9Runtime } from '../pvt/pvt9-base-config.generated';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../pvt/native-wallet-registration';
import { Wallet } from 'ethers';
import { identityHash, ownershipBindingMessage, recoveryHash, registeredBalanceAt, consumeRecovery,
  registerOwnership, RECOURSE_COLLECTIONS,
  type OwnershipBinding, type RegisteredAddress, type TransferEvent } from './ownership';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from '../onchain/economic-constants';

const address = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const binding: RegisteredAddress = {
  identity: identityHash('human', 'alice'), address, kernel: requireConfiguredPvt9Runtime().address.toLowerCase(),
  boundBlock: 100, boundBlockHash: hash, openingBalanceAtomic: '100', bindingDigest: hash, recoveryGeneration: 0,
};
const event = (patch: Partial<TransferEvent>): TransferEvent => ({
  block: 101, blockHash: hash, transactionHash: hash, logIndex: 0,
  from: '0x0000000000000000000000000000000000000000', to: address, amountAtomic: '10', ...patch,
});

describe('ownership registry evidence', () => {
  test('minted and received entries both count; sent and burned balances leave; self-transfer nets zero', () => {
    const events = [event({}), event({ logIndex: 1, from: binding.kernel, amountAtomic: '20' }),
      event({ logIndex: 2, from: address, to: binding.kernel, amountAtomic: '30' }),
      event({ logIndex: 3, from: address, amountAtomic: '12' }),
      event({ logIndex: 4, from: address, to: '0x0000000000000000000000000000000000000000', amountAtomic: '5' })];
    expect(events).toHaveLength(5);
    expect(registeredBalanceAt(binding, events, 101)).toEqual({ balanceAtomic: 95n, mintedAtomic: 10n, receivedAtomic: 32n });
  });

  test('empty interval preserves only the independently read bind balance', () => {
    expect(registeredBalanceAt(binding, [], 100).balanceAtomic).toBe(100n);
  });

  test.each([
    ['pre-binding', [event({ block: 100 })]],
    ['after snapshot', [event({ block: 102 })]],
    ['duplicate', [event({}), event({})]],
    ['reordered', [event({ logIndex: 1 }), event({})]],
    ['reorged block', [event({}), event({ logIndex: 1, blockHash: `0x${'cd'.repeat(32)}` })]],
    ['unrelated address', [event({ to: binding.kernel })]],
    ['negative amount', [event({ amountAtomic: '-1' })]],
    ['missing funds', [event({ from: address, to: binding.kernel, amountAtomic: '101' })]],
  ])('RED control rejects %s evidence', (_name, events) => {
    expect(() => registeredBalanceAt(binding, events, 101)).toThrow();
  });

  test('recovery commitment is SHA-256 of exact secret bytes, not a wallet signature', () => {
    expect(recoveryHash(Buffer.alloc(64))).toBe('0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b');
    expect(recoveryHash(Buffer.alloc(64, 1))).not.toBe(recoveryHash(Buffer.alloc(64)));
    expect(() => recoveryHash(Buffer.alloc(31))).toThrow('recourse_preimage_invalid');
    expect(identityHash('human', 'alice')).not.toBe(identityHash('agent', 'alice'));
  });

  test('signature binds recovery hash, identity, kernel, address, nonce and expiry', async () => {
    const wallet = Wallet.createRandom();
    const value: OwnershipBinding = {
      identity: binding.identity, address: wallet.address.toLowerCase(), kernel: binding.kernel,
      recoveryCommitment: hash, signingRoot: hash, nonce: hash, expiresAtMs: 1000,
    };
    const { verifyMessage } = await import('ethers');
    const signature = await wallet.signMessage(ownershipBindingMessage(value));
    expect(verifyMessage(ownershipBindingMessage(value), signature)).toBe(wallet.address);
    for (const mutation of [
      { identity: identityHash('human', 'mallory') }, { address }, { kernel: address },
      { recoveryCommitment: `0x${'cd'.repeat(32)}` }, { signingRoot: `0x${'ac'.repeat(32)}` }, { nonce: `0x${'ef'.repeat(32)}` }, { expiresAtMs: 1001 },
    ]) {
      expect(verifyMessage(ownershipBindingMessage({ ...value, ...mutation }), signature)).not.toBe(wallet.address);
    }
  });
});

describe('durable ownership and recovery transitions', () => {
  const secret = Buffer.alloc(64, 17);
  const replacement = recoveryHash(Buffer.alloc(64, 19));
  const identity = identityHash('agent', 'unlinked-agent');
  const input = { identity, preimage: secret, destination: address, nextCommitment: replacement, nextSigningRoot: `0x${'13'.repeat(32)}`,
    requestId: hash, nowMs: 1000 };
  const seed = (fake: ReturnType<typeof createFakeFirestore>) => {
    fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, {
      identity, recoveryCommitment: recoveryHash(secret), signingRoot: `0x${'11'.repeat(32)}`, recoveryGeneration: 0,
    });
  };

  test('an unlinked agent recovers without the old wallet key; only hashes persist', async () => {
    const fake = createFakeFirestore(); seed(fake);
    const db = fake as unknown as Firestore;
    expect(await consumeRecovery(db, input)).toEqual({ destination: address, generation: 1 });
    expect(await consumeRecovery(db, input)).toEqual({ destination: address, generation: 1 });
    const serialized = JSON.stringify([...fake.store]);
    expect(serialized).not.toContain(secret.toString('hex'));
    expect(fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${identity}`)?.recoveryCommitment).toBe(replacement);
    await expect(consumeRecovery(db, { ...input, destination: binding.kernel })).rejects.toThrow('recourse_recovery_replay');
    await expect(consumeRecovery(db, { ...input, requestId: `0x${'ce'.repeat(32)}` })).rejects.toThrow('recourse_recovery_proof_invalid');
    await expect(consumeRecovery(db, { ...input, preimage: Buffer.alloc(64, 19),
      nextCommitment: recoveryHash(secret), requestId: `0x${'cf'.repeat(32)}` }))
      .rejects.toThrow('recourse_recovery_commitment_reused');
  });

  test('wrong preimage and cross-identity proof cannot consume a commitment', async () => {
    const fake = createFakeFirestore(); seed(fake);
    const db = fake as unknown as Firestore;
    await expect(consumeRecovery(db, { ...input, preimage: Buffer.alloc(64) })).rejects.toThrow('recourse_recovery_proof_invalid');
    await expect(consumeRecovery(db, { ...input, identity: binding.identity })).rejects.toThrow('recourse_recovery_proof_invalid');
    expect(fake.store.size).toBe(1);
    expect(fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${identity}`)?.recoveryGeneration).toBe(0);
  });

  test('failure to create recovery receipt rolls back commitment consumption', async () => {
    const fake = createFakeFirestore({ failTxnWriteTo: RECOURSE_COLLECTIONS.recoveries }); seed(fake);
    await expect(consumeRecovery(fake as unknown as Firestore, input)).rejects.toThrow();
    expect(fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${identity}`)?.recoveryCommitment).toBe(recoveryHash(secret));
    expect(fake.store.size).toBe(1);
  });

  test('a competing recovery wins atomically; retried proof cannot overwrite its destination', async () => {
    const fake = createFakeFirestore({ strictTransactionOrder: true,
      retryFirstTxn: { beforeRetry: store => {
        store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, {
          identity, recoveryCommitment: recoveryHash(Buffer.alloc(64, 23)), recoveryGeneration: 1,
        });
      } } });
    seed(fake);
    await expect(consumeRecovery(fake as unknown as Firestore, input)).rejects.toThrow('recourse_recovery_proof_invalid');
    expect(fake.store.has(`${RECOURSE_COLLECTIONS.recoveries}/${input.requestId}`)).toBe(false);
    expect(fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${identity}`)?.recoveryGeneration).toBe(1);
  });

  test('verified binding persists opening balance once and refuses hash substitution', async () => {
    const fake = createFakeFirestore();
    const wallet = Wallet.createRandom();
    const value: OwnershipBinding = { identity, address: wallet.address.toLowerCase(), kernel: binding.kernel,
      recoveryCommitment: recoveryHash(secret), signingRoot: hash, nonce: hash, expiresAtMs: 2000 };
    const fence = {
      schemaVersion: 'external-proof-fence/v1' as const, chainId: 8453 as const,
      observedHeadBlock: 100 + BASE_ECONOMIC_FINALITY_CONFIRMATIONS - 1,
      proofBlockNumber: 100, proofBlockHash: hash,
      provenAtBlock: 100 + BASE_ECONOMIC_FINALITY_CONFIRMATIONS,
      minActivityConfirmations: BASE_ECONOMIC_FINALITY_CONFIRMATIONS,
      rpcOperatorIds: ['independent-a', 'independent-b'] as const,
    };
    const request = { binding: value, signature: await wallet.signMessage(ownershipBindingMessage(value)),
      authenticatedIdentity: identity, owner: { type: 'agent' as const, id: 'unlinked-agent', walletId: 'wallet_aw_test' }, nowMs: 1000, fence, balanceAtomic: 500n,
      admissionBlock: fence.observedHeadBlock, admissionBlockHash: hash };
    const verify = { getCode: async () => '0x', isValidSignature: async () => '0x00000000' };
    const db = fake as unknown as Firestore;
    const first = await registerOwnership(db, request, verify);
    // A signed address need not first join a separate earning program.
    expect(first.boundAtMs).toBe(1000);
    const index = `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(value.address)}`;
    fake.store.set(index, { owner_type: 'agent', wallet_id: 'another-wallet' });
    await expect(registerOwnership(db, request, verify)).rejects.toThrow('recourse_address_owned_elsewhere');
    fake.store.set(index, { owner_type: 'agent', wallet_id: 'wallet_aw_test' });
    expect(first.openingBalanceAtomic).toBe('500');
    expect(first.boundBlock).toBe(fence.observedHeadBlock);
    await expect(registerOwnership(db, { ...request, admissionBlock: fence.proofBlockNumber }, verify))
      .rejects.toThrow('recourse_binding_context_invalid');
    expect(await registerOwnership(db, { ...request, balanceAtomic: 900n }, verify)).toEqual(first);
    await expect(registerOwnership(db, { ...request,
      binding: { ...value, recoveryCommitment: replacement } }, verify)).rejects.toThrow('recourse_signature_invalid');
    await expect(registerOwnership(db, { ...request, authenticatedIdentity: binding.identity }, verify))
      .rejects.toThrow('recourse_binding_context_invalid');
    expect(fake.store.size).toBe(3);
  });
});
