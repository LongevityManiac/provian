import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  resolveCommittedBeneficiaryAddress,
  resolveMintRecipientAddress,
} from './mint-recipient-resolver';
import { canonicalAgentBeneficiaryShareBps } from '../agent-wallet/beneficiary-relationship';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('exact mint recipient resolver', () => {
  it('accepts multiple exact registry mirrors only when every address agrees', async () => {
    const fake = createFakeFirestore();
    fake.store.set('agent_wallets/agent-wallet', {
      id: 'agent-wallet', agent_id: 'agent-1', address: ADDRESS,
    });
    fake.store.set('wallets/compat-wallet', {
      id: 'compat-wallet', agent_id: 'agent-1', evm_address: `0x${'A'.repeat(40)}`,
    });
    await expect(resolveMintRecipientAddress(fake as unknown as Firestore, 'agent-1'))
      .resolves.toBe(ADDRESS);
  });

  it('rejects duplicate identities and cross-registry recipient disagreement', async () => {
    const duplicate = createFakeFirestore();
    duplicate.store.set('agent_wallets/a', { id: 'a', agent_id: 'agent-1', address: ADDRESS });
    duplicate.store.set('agent_wallets/b', { id: 'b', agent_id: 'agent-1', address: ADDRESS });
    await expect(resolveMintRecipientAddress(duplicate as unknown as Firestore, 'agent-1'))
      .rejects.toThrow('mint_recipient_duplicate_identity');

    const conflict = createFakeFirestore();
    conflict.store.set('agent_wallets/a', { id: 'a', agent_id: 'agent-1', address: ADDRESS });
    conflict.store.set('wallets/b', { id: 'b', agent_id: 'agent-1', address: OTHER });
    await expect(resolveMintRecipientAddress(conflict as unknown as Firestore, 'agent-1'))
      .rejects.toThrow('mint_recipient_registry_conflict');
  });

  it('supports an exact direct wallet-id actor and rejects malformed identity/address state', async () => {
    const direct = createFakeFirestore();
    direct.store.set('agent_wallets/wallet_aw_1', {
      id: 'wallet_aw_1', agent_id: 'agent-1', address: ADDRESS,
    });
    await expect(resolveMintRecipientAddress(direct as unknown as Firestore, 'wallet_aw_1'))
      .resolves.toBe(ADDRESS);

    const malformed = createFakeFirestore();
    malformed.store.set('wallets/wallet-1', {
      id: 'wrong-id', user_id: 'human-1', address: 'not-an-address',
    });
    await expect(resolveMintRecipientAddress(malformed as unknown as Firestore, 'human-1'))
      .rejects.toThrow('mint_recipient_identity_invalid');
  });

  it('returns null only when every authoritative representation is absent', async () => {
    await expect(resolveMintRecipientAddress(
      createFakeFirestore() as unknown as Firestore,
      'missing-actor',
    )).resolves.toBeNull();
  });

  it('rebinds a committed beneficiary to the exact canonical human wallet id', async () => {
    const fake = createFakeFirestore();
    fake.store.set('wallets/human-wallet', {
      id: 'human-wallet', type: 'human', user_id: 'human-1', address: ADDRESS,
    });
    const route = {
      schema_version: 'beneficiary-routing/v1' as const,
      pe_id: 'pe-1',
      economic_actor_id: 'agent-1',
      recorded_at_ms: 1,
      human_wallet_id: 'human-wallet',
      human_user_id: 'human-1',
      human_address: ADDRESS,
      agent_share_bps: canonicalAgentBeneficiaryShareBps({ bps: 2_000 })!,
    };
    await expect(resolveCommittedBeneficiaryAddress(fake as unknown as Firestore, route))
      .resolves.toBe(ADDRESS);
    await expect(resolveCommittedBeneficiaryAddress(fake as unknown as Firestore, {
      ...route,
      human_wallet_id: 'substituted-wallet',
    })).rejects.toThrow('mint_beneficiary_human_binding_invalid');
  });
});
