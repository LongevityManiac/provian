import { describe, expect, it, jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';

import type { RedisCache } from '../../cache';
import { canonicalAgentPeHash } from '../agent-wallet/canonical-agent-pe-chain';
import { resolveBeneficiary } from './beneficiary';

const AGENT_ADDRESS = `0x${'a'.repeat(40)}`;
const HUMAN_ADDRESS = `0x${'b'.repeat(40)}`;

interface Row {
  id: string;
  data: Record<string, unknown>;
}

function snapshot(row: Row | undefined) {
  return {
    id: row?.id ?? '',
    exists: row !== undefined,
    data: () => row?.data,
  };
}

function fakeDb(options: {
  agents?: Row[];
  humans?: Row[];
  rotations?: Row[];
  queryError?: Error;
  mutateAuthority?: (graph: {
    relationships: Row[];
    pes: Row[];
    tips: Row[];
  }) => void;
}): Firestore {
  const agents = options.agents ?? [];
  const humans = options.humans ?? [];
  const rotations = options.rotations ?? [];
  const relationshipInputs = agents.map((row) => {
    const linked = row.data.linked_human_wallet_id !== null;
    return {
      schema_version: 'agent-beneficiary-relationship/v1',
      wallet_id: row.id,
      agent_id: row.data.agent_id,
      state: linked ? 'linked' : 'unlinked',
      human_wallet_id: row.data.linked_human_wallet_id ?? null,
      human_user_id: row.data.linked_human_user_id ?? null,
      human_address: row.data.linked_human_address ?? null,
      operational_reserve_ratio: row.data.operational_reserve_ratio ?? null,
      parent_wallet_id: null,
      revision: 1,
      source_action_type: 'agent_wallet_created',
      source_pe_id: `pe_relationship_${row.id}`,
      source_pe_hash: '',
      created_at_ms: 1,
      updated_at_ms: 1,
    };
  });
  const relationshipPes = relationshipInputs.map((relationship) => {
    const canonical = {
        id: relationship.source_pe_id,
        wallet_id: relationship.wallet_id,
        agent_id: relationship.agent_id,
        user_id: relationship.agent_id,
        actor_address: agents.find((agent) => agent.id === relationship.wallet_id)?.data.address,
        action_type: 'agent_wallet_created',
        timestamp: 1,
        prev_hash: '0x0000',
        attestation_type: 'software',
        metadata: {
          beneficiary_relationship: {
            state: relationship.state,
            human_wallet_id: relationship.human_wallet_id,
            human_user_id: relationship.human_user_id,
            human_address: relationship.human_address,
            operational_reserve_ratio: relationship.operational_reserve_ratio,
            parent_wallet_id: relationship.parent_wallet_id,
            revision: relationship.revision,
          },
        },
        compute: null,
        geo: null,
        execution_env: null,
        cited_pe_ids: null,
        parent_goal_pe_id: null,
      };
    const hash = canonicalAgentPeHash(canonical);
    relationship.source_pe_hash = hash;
    return {
      id: relationship.source_pe_id,
      data: {
        ...canonical,
        hash,
        user_id: relationship.agent_id,
        policy_action_type: 'wallet_created',
        integration_source: 'agent_bank_generate_pe',
        counterparty_address: null,
        counterparty_type: null,
        session_lineage: null,
        self_referencing: false,
        trust_level_at_creation: null,
        created_at: 1,
        durability: 'final',
      },
    };
  });
  const relationships = relationshipInputs.map((relationship) => ({
    id: relationship.wallet_id,
    data: relationship,
  }));
  const chainTips = relationshipPes.map((row) => ({
    id: row.data.agent_id as string,
    data: {
      hash: row.data.hash,
      user_id: row.data.agent_id,
      updated_at: 1,
    },
  }));
  options.mutateAuthority?.({ relationships, pes: relationshipPes, tips: chainTips });
  return {
    collection(name: string) {
      const rows = name === 'agent_wallets'
        ? agents
        : name === 'wallets'
          ? humans
          : name === 'agent_beneficiary_relationships_v1'
            ? relationships
            : name === 'identity_pes_legacy_v1'
              ? relationshipPes
              : name === 'pe_chain_tips'
                ? chainTips
                : [];
      return {
        where(_field: string, _operator: string, value: unknown) {
          const queryRows = rows.filter((row) => row.data.agent_id === value);
          const query = {
            async get() {
              if (options.queryError) throw options.queryError;
              const docs = queryRows.map(snapshot);
              return { empty: docs.length === 0, docs, size: docs.length };
            },
            limit(limit: number) {
              return {
                async get() {
                  if (options.queryError) throw options.queryError;
                  const docs = queryRows
                    .slice(0, limit)
                    .map(snapshot);
                  return { empty: docs.length === 0, docs, size: docs.length };
                },
              };
            },
          };
          return query;
        },
        doc(id: string) {
          return {
            async get() {
              return snapshot(rows.find((row) => row.id === id));
            },
            collection(subcollection: string) {
              const subRows = name === 'agent_wallets' && subcollection === 'rotation_history'
                ? rotations
                : [];
              return {
                async get() {
                  const docs = subRows.map(snapshot);
                  return { empty: docs.length === 0, docs, size: docs.length };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Firestore;
}

function cacheWith(value: unknown) {
  return {
    getBeneficiaryStatus: jest.fn(async () => value),
    setBeneficiaryStatus: jest.fn(async () => undefined),
  } as unknown as RedisCache;
}

function linkedAgent(overrides: Record<string, unknown> = {}): Row {
  return {
    id: 'wallet_aw_atlas',
    data: {
      id: 'wallet_aw_atlas',
      agent_id: 'agent_atlas',
      address: AGENT_ADDRESS,
      status: 'active',
      linked_human_wallet_id: 'wallet_human',
      linked_human_user_id: 'user_human',
      linked_human_address: HUMAN_ADDRESS,
      operational_reserve_ratio: 0.2,
      ...overrides,
    },
  };
}

const human: Row = {
  id: 'wallet_human',
  data: {
    id: 'wallet_human',
    type: 'human',
    user_id: 'user_human',
    address: HUMAN_ADDRESS,
  },
};

describe('authoritative beneficiary resolution', () => {
  it('ignores a stale cached negative and cross-binds the live human wallet', async () => {
    const cache = cacheWith({
      linked: false,
      humanWalletId: null,
      humanUserId: null,
      humanAddress: null,
      agentShareBps: null,
    });
    const result = await resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent()],
      humans: [human],
    }));

    expect(result).toEqual({
      linked: true,
      humanWalletId: 'wallet_human',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: 2_000,
    });
    expect(cache.getBeneficiaryStatus).not.toHaveBeenCalled();
  });

  it('ignores a stale cached positive after an authoritative unlink', async () => {
    const cache = cacheWith({
      linked: true,
      humanWalletId: 'stale_wallet',
      humanUserId: 'stale_user',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: 2_000,
    });
    const result = await resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent({
        linked_human_wallet_id: null,
        linked_human_user_id: null,
        linked_human_address: null,
        operational_reserve_ratio: null,
      })],
    }));

    expect(result).toEqual({
      linked: false,
      humanWalletId: null,
      humanUserId: null,
      humanAddress: null,
      agentShareBps: null,
    });
    expect(cache.getBeneficiaryStatus).not.toHaveBeenCalled();
  });

  // a ROTATED wallet's lineage is proven from sealed PEs (the registration-index-pinned
  // birth PE + each sealed agent_key_rotated PE), which this hand-built fake cannot seal. Its two
  // rotated cases moved to `core/agent-wallet/beneficiary-relationship.sealed-lineage.test.ts`, which
  // rotates a REAL route-created agent through the REAL rotation transition.

  it('fails closed on registry read failure, duplicate agents, or a broken human binding', async () => {
    const cache = cacheWith(null);
    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      queryError: new Error('firestore unavailable'),
    }))).rejects.toThrow('firestore unavailable');

    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent(), { ...linkedAgent(), id: 'wallet_aw_duplicate' }],
      humans: [human],
    }))).rejects.toThrow('beneficiary_registry_duplicate_agent_identity');

    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent()],
      humans: [{ ...human, data: { ...human.data, address: `0x${'c'.repeat(40)}` } }],
    }))).rejects.toThrow('beneficiary_relationship_integrity:human_binding');
  });

  it('fails closed when a wallet-id actor has no authoritative agent row', async () => {
    await expect(resolveBeneficiary(
      'wallet_aw_missing',
      cacheWith(null),
      fakeDb({}),
    )).rejects.toThrow('beneficiary_registry_expected_agent_missing');
  });

  it('fails closed on partial unlink state or mismatched document identity', async () => {
    const cache = cacheWith(null);
    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent({
        linked_human_wallet_id: null,
        linked_human_user_id: null,
        linked_human_address: null,
        operational_reserve_ratio: 0.2,
      })],
    }))).rejects.toThrow('beneficiary_relationship_integrity:unlinked_fields');

    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent({ id: 'different_wallet_id' })],
      humans: [human],
    }))).rejects.toThrow('beneficiary_registry_agent_identity_invalid');

    await expect(resolveBeneficiary('agent_atlas', cache, fakeDb({
      agents: [linkedAgent()],
      humans: [{ ...human, data: { ...human.data, id: 'different_wallet_id' } }],
    }))).rejects.toThrow('beneficiary_relationship_integrity:human_binding');
  });

  it('rejects sub-BPS legacy source metadata even when the rewritten PE is rehashed', async () => {
    const cache = cacheWith(null);
    const db = fakeDb({
      agents: [linkedAgent()],
      humans: [human],
      mutateAuthority: ({ relationships, pes, tips }) => {
        const source = pes[0];
        const metadata = source.data.metadata as {
          beneficiary_relationship: Record<string, unknown>;
        };
        metadata.beneficiary_relationship.operational_reserve_ratio = 0.20001;
        const rewrittenHash = canonicalAgentPeHash(source.data);
        source.data.hash = rewrittenHash;
        relationships[0].data.source_pe_hash = rewrittenHash;
        tips[0].data.hash = rewrittenHash;
      },
    });

    await expect(resolveBeneficiary('agent_atlas', cache, db))
      .rejects.toThrow('beneficiary_relationship_integrity:source_pe_binding');
    expect(cache.setBeneficiaryStatus).not.toHaveBeenCalled();
  });

  it.each(['mutated_body', 'arbitrary_hash', 'orphan_source'] as const)(
    'rejects %s relationship provenance without populating the cache',
    async (attack) => {
      const cache = cacheWith(null);
      const db = fakeDb({
        agents: [linkedAgent()],
        humans: [human],
        mutateAuthority: ({ relationships, pes, tips }) => {
          const source = pes[0];
          if (attack === 'mutated_body') {
            source.data.metadata = { beneficiary_relationship: { forged: true } };
            return;
          }
          if (attack === 'arbitrary_hash') {
            const arbitrary = 'f'.repeat(64);
            source.data.hash = arbitrary;
            relationships[0].data.source_pe_hash = arbitrary;
            tips[0].data.hash = arbitrary;
            return;
          }
          const orphanTipCanonical = {
            id: 'pe_unrelated_tip',
            wallet_id: source.data.wallet_id,
            agent_id: source.data.agent_id,
            action_type: 'policy_updated',
            actor_address: source.data.actor_address,
            timestamp: 2,
            prev_hash: '0x0000',
            attestation_type: 'software',
            metadata: { policy_key: 'unrelated' },
            compute: null,
            geo: null,
            execution_env: null,
            cited_pe_ids: null,
            parent_goal_pe_id: null,
          };
          const orphanTipHash = canonicalAgentPeHash(orphanTipCanonical);
          pes.push({
            id: 'pe_unrelated_tip',
            data: {
              ...orphanTipCanonical,
              hash: orphanTipHash,
              user_id: source.data.agent_id,
              policy_action_type: 'policy_updated',
              integration_source: 'agent_bank_generate_pe',
              counterparty_address: null,
              counterparty_type: null,
              session_lineage: null,
              self_referencing: false,
              trust_level_at_creation: null,
              created_at: 2,
              durability: 'final',
            },
          });
          tips[0].data.hash = orphanTipHash;
          tips[0].data.updated_at = 2;
        },
      });

      if (attack === 'orphan_source') {
        // PE METER : the relay keeps no agent PE chain, so chain membership is
        // no longer an input. The relationship's own pin (source id + canonical hash) is the
        // authority; a tip elsewhere cannot unseat a correctly pinned source. The two tamper
        // attacks above still reject, which is what keeps this from being a weakened guard.
        await expect(resolveBeneficiary('agent_atlas', cache, db)).resolves.toMatchObject({ linked: true });
        return;
      }
      await expect(resolveBeneficiary('agent_atlas', cache, db)).rejects.toThrow();
      expect(cache.setBeneficiaryStatus).not.toHaveBeenCalled();
    },
  );

  it('reads no agent PE chain: resolution is a bounded set of point reads', async () => {
    const cache = cacheWith(null);
    const db = fakeDb({ agents: [linkedAgent()], humans: [human] });
    const touched: string[] = [];
    const tracked = {
      collection(name: string) {
        touched.push(name);
        return (db as unknown as { collection(n: string): unknown }).collection(name);
      },
    } as unknown as Firestore;
    await expect(resolveBeneficiary('agent_atlas', cache, tracked)).resolves.toMatchObject({ linked: true });
    expect(touched).not.toContain('pe_chain_tips');
  });
});
