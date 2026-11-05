import { endHumanBeneficiaryLinks } from './end-human-beneficiary-links';
/**
 * Unit test for the shared agent→human bind path.
 *
 * Heavy collaborators (PE generation, governance scoring, badge evaluation) are
 * mocked so the test isolates bindAgentToHuman's own orchestration: it writes
 * the linked fields onto the agent wallet, invalidates the beneficiary cache,
 * and emits the agent_linked_to_human PE. Prior aggregate estimates are never
 * rewritten: record-time snapshots make beneficiary changes prospective.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async (
    deps: {
      db: {
        collection: (name: string) => { doc: (id: string) => unknown };
        store: Map<string, Record<string, unknown>>;
        runTransaction: <T>(fn: (txn: unknown) => Promise<T>) => Promise<T>;
      };
    },
    params: {
      atomicEntityPrecondition?: (txn: unknown, context: { prevHash: string }) => Promise<void>;
      atomicEntityWrite?: (
        txn: { set: (ref: unknown, data: Record<string, unknown>) => void },
        peId: string,
        context: { prevHash: string; newHash: string; timestamp: number },
      ) => void;
      peIdOverride?: string;
      timestampOverride?: number;
      walletId: string;
      agentId: string;
      actorAddress: string;
      actionType: string;
      metadata: Record<string, unknown>;
    },
  ) => {
    const crypto = jest.requireActual<typeof import('crypto')>('crypto');
    const stableStringify = jest.requireActual<typeof import('json-stable-stringify')>(
      'json-stable-stringify',
    );
    const peId = params.peIdOverride ?? `pe_${params.actionType}`;
    const timestamp = params.timestampOverride ?? Date.now();
    const tip = deps.db.store.get(`pe_chain_tips/${params.agentId}`);
    const prevHash = typeof tip?.hash === 'string' ? tip.hash : '0x0000';
    const canonical = {
      id: peId,
      wallet_id: params.walletId,
      agent_id: params.agentId,
      action_type: params.actionType,
      actor_address: params.actorAddress.toLowerCase(),
      timestamp,
      prev_hash: prevHash,
      attestation_type: 'software',
      metadata: params.metadata,
      compute: null,
      geo: null,
      execution_env: null,
      cited_pe_ids: null,
      parent_goal_pe_id: null,
    };
    const peHash = crypto.createHash('sha256')
      .update(stableStringify(canonical) || '', 'utf8')
      .digest('hex');
    await deps.db.runTransaction(async (txn: any) => {
      await params.atomicEntityPrecondition?.(txn, { prevHash });
      txn.set(deps.db.collection('identity_pes_legacy_v1').doc(peId), {
        ...canonical,
        hash: peHash,
        user_id: params.agentId,
        policy_action_type: params.actionType,
        integration_source: 'agent_bank_generate_pe',
        counterparty_address: null,
        counterparty_type: null,
        session_lineage: null,
        self_referencing: false,
        trust_level_at_creation: null,
        created_at: timestamp,
        durability: 'final',
      });
      txn.set(deps.db.collection('pe_chain_tips').doc(params.agentId), {
        hash: peHash,
        user_id: params.agentId,
        updated_at: timestamp,
        last_pe_timestamp: timestamp,
      });
      params.atomicEntityWrite?.(txn, peId, {
        prevHash,
        newHash: peHash,
        timestamp,
      });
    });
    return { peId, peHash, prevHash };
  }),
}));
jest.mock('./badges', () => ({
  evaluateBadges: jest.fn(() => ['linked']),
  createEarnedBadges: jest.fn(() => [{ id: 'linked', earned_at: 1 }]),
}));

import {
  bindAgentToHuman,
  unbindAgentFromHuman,
  updateAgentBeneficiaryShareBps,
  type BindDeps,
} from './link-human-binding';
import { generatePE } from '../agent-bank/pe-utils';
import { evaluateBadges } from './badges';
import type { AgentWalletDocument } from './types';
import { canonicalAgentPeHash } from './canonical-agent-pe-chain';
import {
  DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
  canonicalAgentBeneficiaryShareBps,
} from './beneficiary-relationship';

interface UpdateRecord { path: string; data: Record<string, unknown> }

const AGENT_ADDRESS = `0x${'a'.repeat(40)}`;
const HUMAN_ADDRESS = `0x${'b'.repeat(40)}`;

function exactBps(value: number) {
  const parsed = canonicalAgentBeneficiaryShareBps({ bps: value });
  if (parsed === null) throw new Error('invalid test BPS');
  return parsed;
}

function applyUpdate(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && value.constructor.name === 'DeleteTransform') {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

interface StubQuery {
  __query: () => Promise<{ empty: boolean; size: number; docs: Array<{ id: string; exists: boolean; data: () => Record<string, unknown> }> }>;
  where: (field: string, op: string, value: unknown) => StubQuery;
  limit: (n: number) => StubQuery;
  get: StubQuery['__query'];
}

class StubFirestore {
  updates: UpdateRecord[] = [];
  accrual = new Map<string, { totalEstimatedPVT: number }>();
  store = new Map<string, Record<string, unknown>>();
  transactionCalls = 0;

  collection(name: string) {
    return {
      where: (field: string, _operator: string, value: unknown) => this.query(name, [[field, value]]),
      doc: (id: string) => ({
        id,
        __path: `${name}/${id}`,
        get: async () => {
          const data = this.store.get(`${name}/${id}`);
          return { exists: data !== undefined, data: () => data };
        },
        update: async (data: Record<string, unknown>) => {
          this.updates.push({ path: `${name}/${id}`, data });
          this.store.set(`${name}/${id}`, applyUpdate(
            this.store.get(`${name}/${id}`) ?? {},
            data,
          ));
        },
      }),
    };
  }

  /** A chainable equality query (where / limit / get); a transaction reads it through `__query`. */
  query(name: string, filters: Array<[string, unknown]>, lim?: number): StubQuery {
    const run = async () => {
      const prefix = `${name}/`;
      let docs = [...this.store.entries()]
        .filter(([key, data]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')
          && filters.every(([f, v]) => data[f] === v))
        .map(([key, data]) => ({ id: key.slice(prefix.length), exists: true, data: () => data }));
      if (lim !== undefined) docs = docs.slice(0, lim);
      return { empty: docs.length === 0, size: docs.length, docs };
    };
    return {
      __query: run,
      where: (field: string, _op: string, value: unknown) => this.query(name, [...filters, [field, value]], lim),
      limit: (n: number) => this.query(name, filters, n),
      get: run,
    };
  }

  async runTransaction<T>(fn: (txn: StubTxn) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return fn(new StubTxn(this.store, this.updates));
  }
}

class StubTxn {
  constructor(
    private store: Map<string, Record<string, unknown>>,
    private updates: UpdateRecord[],
  ) {}
  async get(ref: { __path: string } | StubQuery) {
    if ('__query' in ref) return ref.__query();
    const data = this.store.get(ref.__path);
    return {
      id: ref.__path.slice(ref.__path.lastIndexOf('/') + 1),
      exists: data !== undefined,
      data: () => data,
    };
  }
  update(ref: { __path: string }, data: Record<string, unknown>) {
    this.updates.push({ path: ref.__path, data });
    this.store.set(ref.__path, applyUpdate(this.store.get(ref.__path) ?? {}, data));
  }
  set(ref: { __path: string }, data: Record<string, unknown>) {
    this.updates.push({ path: ref.__path, data });
    this.store.set(ref.__path, { ...data });
  }
  create(ref: { __path: string }, data: Record<string, unknown>) {
    if (this.store.has(ref.__path)) throw new Error('document_already_exists');
    this.set(ref, data);
  }
}

function makeWallet(): AgentWalletDocument {
  return {
    id: 'wallet_aw_123',
    agent_id: 'agent_abc',
    address: AGENT_ADDRESS,
    status: 'active',
    badges: [],
    linked_human_wallet_id: null,
    linked_human_user_id: null,
    linked_human_address: null,
    operational_reserve_ratio: null,
    parent_wallet_id: null,
    attestation_count: 1,
    streak_days: 0,
    updated_at: 1,
  } as unknown as AgentWalletDocument;
}

function makeLinkedWallet(): AgentWalletDocument {
  return {
    ...makeWallet(),
    linked_human_wallet_id: 'wallet_human_9',
    linked_human_user_id: 'user_human',
    linked_human_address: HUMAN_ADDRESS,
    operational_reserve_ratio: 0.2,
  } as AgentWalletDocument;
}

function makeDeps(db: StubFirestore) {
  const wallet = makeWallet();
  db.store.set('agent_wallets/wallet_aw_123', wallet as unknown as Record<string, unknown>);
  db.store.set('wallets/wallet_human_9', {
    id: 'wallet_human_9',
    type: 'human',
    user_id: 'user_human',
    address: HUMAN_ADDRESS,
  });
  seedRelationship(db, wallet);
  const invalidateBeneficiaryStatus = jest.fn(async () => {});
  return {
    deps: {
      db,
      cache: { invalidateBeneficiaryStatus } as unknown as BindDeps['cache'],
      peBuffer: { enqueue: jest.fn() },
      recordPEAccrual: jest.fn(async () => {}),
    } as unknown as BindDeps,
    invalidateBeneficiaryStatus,
  };
}

function seedRelationship(db: StubFirestore, wallet: AgentWalletDocument): void {
  const linked = typeof wallet.linked_human_wallet_id === 'string';
  const relationship = {
    schema_version: 'agent-beneficiary-relationship/v1',
    wallet_id: wallet.id,
    agent_id: wallet.agent_id,
    state: linked ? 'linked' : 'unlinked',
    human_wallet_id: wallet.linked_human_wallet_id ?? null,
    human_user_id: wallet.linked_human_user_id ?? null,
    human_address: wallet.linked_human_address?.toLowerCase() ?? null,
    operational_reserve_ratio: wallet.operational_reserve_ratio ?? null,
    parent_wallet_id: wallet.parent_wallet_id ?? null,
    revision: 1,
    source_action_type: 'agent_wallet_created',
    source_pe_id: 'pe_birth',
    source_pe_hash: '',
    created_at_ms: 1,
    updated_at_ms: 1,
  };
  const canonical = {
    id: 'pe_birth',
    wallet_id: wallet.id,
    agent_id: wallet.agent_id,
    action_type: 'agent_wallet_created',
    actor_address: wallet.address.toLowerCase(),
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
        revision: 1,
      },
    },
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
  };
  const sourceHash = canonicalAgentPeHash(canonical);
  relationship.source_pe_hash = sourceHash;
  db.store.set(`agent_beneficiary_relationships_v1/${wallet.id}`, relationship);
  db.store.set('identity_pes_legacy_v1/pe_birth', {
    ...canonical,
    hash: sourceHash,
    user_id: wallet.agent_id,
    policy_action_type: 'wallet_created',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null,
    counterparty_type: null,
    session_lineage: null,
    self_referencing: false,
    trust_level_at_creation: null,
    created_at: 1,
    durability: 'final',
  });
  db.store.set(`pe_chain_tips/${wallet.agent_id}`, {
    hash: sourceHash,
    user_id: wallet.agent_id,
    updated_at: 1,
  });
}

describe('bindAgentToHuman', () => {
  beforeEach(() => {
    (generatePE as jest.Mock).mockClear();
  });

  it('writes linked fields onto the agent wallet doc', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    await bindAgentToHuman(deps, {
      wallet: makeWallet(),
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    const walletUpdate = db.updates.find((u) => u.path === 'agent_wallets/wallet_aw_123');
    expect(walletUpdate).toBeDefined();
    expect(walletUpdate!.data).toMatchObject({
      linked_human_wallet_id: 'wallet_human_9',
      linked_human_user_id: 'user_human',
      linked_human_address: HUMAN_ADDRESS,
      operational_reserve_bps: 2_000,
    });
  });

  it('refuses a new bind to a released wallet, including an in-flight bind', async () => {
    for (const releaseDuringTransaction of [false, true]) {
      const db = new StubFirestore();
      const { deps } = makeDeps(db);
      const release = () => db.store.set('wallets/wallet_human_9', {
        ...db.store.get('wallets/wallet_human_9'), released_at_ms: 10,
      });
      if (!releaseDuringTransaction) release();
      else {
        const run = db.runTransaction.bind(db);
        db.runTransaction = async (fn) => { release(); return run(fn); };
      }
      await expect(bindAgentToHuman(deps, {
        wallet: makeWallet(), humanWalletId: 'wallet_human_9', humanUserId: 'user_human',
        humanAddress: HUMAN_ADDRESS, agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
      })).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
      expect(db.store.get('agent_wallets/wallet_aw_123')?.linked_human_user_id).toBeNull();
    }
  });

  it('invalidates the beneficiary cache for the agent', async () => {
    const db = new StubFirestore();
    const { deps, invalidateBeneficiaryStatus } = makeDeps(db);
    await bindAgentToHuman(deps, {
      wallet: makeWallet(),
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('agent_abc');
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('wallet_aw_123');
  });

  it('emits an agent_linked_to_human PE with the link metadata', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    await bindAgentToHuman(deps, {
      wallet: makeWallet(),
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    const calls = (generatePE as jest.Mock).mock.calls;
    const linkCall = calls.find((c) => (c[1] as { actionType: string }).actionType === 'agent_linked_to_human');
    expect(linkCall).toBeDefined();
    expect((linkCall![1] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      human_wallet_id: 'wallet_human_9',
      operational_reserve_bps: 2_000,
    });
  });

  it('returns a zero retro transfer when the agent has no prior accrual', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    const result = await bindAgentToHuman(deps, {
      wallet: makeWallet(),
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    expect(result.retroTransfer.total_pvt_transferred).toBe(0);
    expect(result.newBadgeIds).toEqual(['linked']);
  });

  it('does not rewrite a pre-link aggregate or create a human aggregate', async () => {
    const db = new StubFirestore();
    db.accrual.set('pvt_accrual/agent_abc', { totalEstimatedPVT: 125 });
    const before = new Map(db.accrual);
    const { deps } = makeDeps(db);

    const result = await bindAgentToHuman(deps, {
      wallet: makeWallet(),
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    expect(db.accrual).toEqual(before);
    // One atomic link+PE transaction plus the derived badge PE transaction;
    // neither transaction reads or rewrites pvt_accrual.
    expect(db.transactionCalls).toBe(2);
    expect(result.retroTransfer).toEqual({
      total_pvt_transferred: 0,
      agent_retained: 0,
      human_received: 0,
    });
  });

  it('serializes the authoritative link and rejects a stale attempt for another human', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    db.store.set('wallets/wallet_human_other', {
      id: 'wallet_human_other',
      type: 'human',
      user_id: 'user_other',
      address: `0x${'c'.repeat(40)}`,
    });
    const staleWallet = makeWallet();

    await bindAgentToHuman(deps, {
      wallet: staleWallet,
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    await expect(bindAgentToHuman(deps, {
      wallet: staleWallet,
      humanWalletId: 'wallet_human_other',
      humanUserId: 'user_other',
      humanAddress: `0x${'c'.repeat(40)}`,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    })).rejects.toMatchObject({
      code: 'agent_already_linked',
    });

    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({
      linked_human_wallet_id: 'wallet_human_9',
      linked_human_user_id: 'user_human',
      linked_human_address: HUMAN_ADDRESS,
    });
  });

  it('treats an exact already-committed link as idempotent without another link PE', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    const staleWallet = makeWallet();
    await bindAgentToHuman(deps, {
      wallet: staleWallet,
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    const committedCalls = (generatePE as jest.Mock).mock.calls.length;

    const replay = await bindAgentToHuman(deps, {
      wallet: staleWallet,
      humanWalletId: 'wallet_human_9',
      humanUserId: 'user_human',
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    expect(replay.newBadgeIds).toEqual([]);
    expect((generatePE as jest.Mock).mock.calls.length).toBe(committedCalls);
    expect(db.updates.filter((update) =>
      update.data.linked_human_wallet_id === 'wallet_human_9')).toHaveLength(1);
  });
});

describe('bindAgentToHuman — fleet-code bind (review 2)', () => {
  beforeEach(() => {
    (generatePE as jest.Mock).mockClear();
    // The badge mock always re-qualifies 'linked'; a re-link in these tests must
    // not trip the (unrelated) badge-outbox guard, so no badge qualifies here.
    (evaluateBadges as jest.Mock).mockReturnValue([]);
  });
  afterEach(() => {
    (evaluateBadges as jest.Mock).mockReturnValue(['linked']);
  });

  function seedFleetCode(db: StubFirestore, code: string, over: Record<string, unknown> = {}): void {
    db.store.set(`connection_tokens/${code}`, {
      token: code, user_id: 'user_human', kind: 'fleet', issued_by_agent_wallet_id: 'wallet_aw_main',
      used: true, used_by_wallet_id: 'wallet_aw_123', used_at: 1, bind_completed: false, ...over,
    });
  }
  const fleetBind = (deps: BindDeps, code: string) => bindAgentToHuman(deps, {
    wallet: makeWallet(),
    humanWalletId: 'wallet_human_9',
    humanUserId: 'user_human',
    humanAddress: HUMAN_ADDRESS,
    agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    fleet: { code },
  });

  it('marks the code bound in the SAME transaction that writes the link', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    seedFleetCode(db, 'PROV-AAAA-2222');
    await fleetBind(deps, 'PROV-AAAA-2222');
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: 'user_human' });
    expect(db.store.get('connection_tokens/PROV-AAAA-2222')).toMatchObject({
      bind_completed: true, bind_pe_id: 'pe_agent_linked_to_human',
    });
  });

  it.each([
    ['consumed by another agent', { used_by_wallet_id: 'wallet_aw_other' }],
    ['already bound', { bind_completed: true }],
    ['not consumed', { used: false }],
    ['for another human', { user_id: 'user_other' }],
    ['not a fleet code', { kind: undefined }],
  ])('refuses a code %s, writing nothing', async (_label, over) => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    seedFleetCode(db, 'PROV-BBBB-3333', over);
    await expect(fleetBind(deps, 'PROV-BBBB-3333')).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
  });

  it('REVIEW 2 #6: the never-linked precondition is re-checked INSIDE the bind transaction — X binds, the human unlinks, then Y (its pre-check already passed) is refused', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    seedFleetCode(db, 'PROV-XXXX-2222');
    seedFleetCode(db, 'PROV-YYYY-3333');
    // X binds.
    await fleetBind(deps, 'PROV-XXXX-2222');
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: 'user_human' });
    // The human ends the link.
    const linked = db.store.get('agent_wallets/wallet_aw_123') as unknown as AgentWalletDocument;
    await unbindAgentFromHuman(deps, { wallet: linked });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
    // Y's route pre-check ran before X bound; its bind now reaches the transaction.
    await expect(fleetBind(deps, 'PROV-YYYY-3333')).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
    expect(db.store.get('connection_tokens/PROV-YYYY-3333')).toMatchObject({ bind_completed: false });
  });

  it('REVIEW 2 #6: an accepted agent_invites record for the agent refuses a fleet bind inside the transaction', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    seedFleetCode(db, 'PROV-ZZZZ-4444');
    db.store.set('agent_invites/inv_past', { id: 'inv_past', agent_wallet_id: 'wallet_aw_123', status: 'accepted' });
    await expect(fleetBind(deps, 'PROV-ZZZZ-4444')).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
  });

  it('control: a NON-fleet bind (the human\'s own Accept) re-links after an unlink, as before', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    seedFleetCode(db, 'PROV-XXXX-2222');
    await fleetBind(deps, 'PROV-XXXX-2222');
    await unbindAgentFromHuman(deps, { wallet: db.store.get('agent_wallets/wallet_aw_123') as unknown as AgentWalletDocument });
    db.store.set('agent_invites/inv_accept', { id: 'inv_accept', agent_wallet_id: 'wallet_aw_123', status: 'accepted' });
    await bindAgentToHuman(deps, {
      wallet: db.store.get('agent_wallets/wallet_aw_123') as unknown as AgentWalletDocument,
      humanWalletId: 'wallet_human_9', humanUserId: 'user_human', humanAddress: HUMAN_ADDRESS,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: 'user_human' });
  });

  it('refuses a missing code', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    await expect(fleetBind(deps, 'PROV-CCCC-4444')).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
  });
});

describe('unbindAgentFromHuman', () => {
  beforeEach(() => {
    (generatePE as jest.Mock).mockClear();
  });

  it('commits the relationship clear through the unlink PE transaction', async () => {
    const db = new StubFirestore();
    const { deps, invalidateBeneficiaryStatus } = makeDeps(db);
    db.store.set(
      'agent_wallets/wallet_aw_123',
      makeLinkedWallet() as unknown as Record<string, unknown>,
    );
    seedRelationship(db, makeLinkedWallet());

    // unbindAgentFromHuman carries no governance newScore, and the cleared wallet carries
    // no governance_score field. 2026-09-23: it returns the sealed unlink PE id.
    const result = await unbindAgentFromHuman(deps, { wallet: makeLinkedWallet() });

    expect(result).toEqual({ peId: 'pe_agent_unlinked_from_human' });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({
      linked_human_wallet_id: null,
      linked_human_user_id: null,
      linked_human_address: null,
      operational_reserve_bps: null,
    });
    const unlinkCall = (generatePE as jest.Mock).mock.calls.find((call) =>
      (call[1] as { actionType: string }).actionType === 'agent_unlinked_from_human');
    expect(unlinkCall).toBeDefined();
    expect((unlinkCall![1] as { atomicEntityWrite?: unknown }).atomicEntityWrite)
      .toEqual(expect.any(Function));
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('agent_abc');
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('wallet_aw_123');
  });

  it('the bilateral unlink PE carries no ended_by; the human-alone unlink records ended_by linked_human and clears the same fields (2026-09-23)', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    db.store.set('agent_wallets/wallet_aw_123', makeLinkedWallet() as unknown as Record<string, unknown>);
    seedRelationship(db, makeLinkedWallet());
    await unbindAgentFromHuman(deps, { wallet: makeLinkedWallet(), endedBy: 'linked_human' });
    const call = (generatePE as jest.Mock).mock.calls.find((c) =>
      (c[1] as { actionType: string }).actionType === 'agent_unlinked_from_human');
    expect((call![1] as { metadata: Record<string, unknown> }).metadata.ended_by).toBe('linked_human');
    expect(db.store.get('agent_bank_event_outbox_v1/beneficiary_link_ended_pe_agent_unlinked_from_human'))
      .toMatchObject({ event_type: 'beneficiary_link_ended', notify_only: true,
        recipients: ['wallet_aw_123'], data: { unlink_pe_id: 'pe_agent_unlinked_from_human' } });
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({
      linked_human_wallet_id: null,
      linked_human_user_id: null,
      linked_human_address: null,
      operational_reserve_bps: null,
      agent_id: 'agent_abc',
    });

    const db2 = new StubFirestore();
    const { deps: deps2 } = makeDeps(db2);
    (generatePE as jest.Mock).mockClear();
    db2.store.set('agent_wallets/wallet_aw_123', makeLinkedWallet() as unknown as Record<string, unknown>);
    seedRelationship(db2, makeLinkedWallet());
    await unbindAgentFromHuman(deps2, { wallet: makeLinkedWallet() });
    const call2 = (generatePE as jest.Mock).mock.calls.find((c) =>
      (c[1] as { actionType: string }).actionType === 'agent_unlinked_from_human');
    expect('ended_by' in (call2![1] as { metadata: Record<string, unknown> }).metadata).toBe(false);
  });

  it.each(['active', 'suspended', 'revoked'] as const)('deletion ends this human’s %s agent link with its notice, retries without a second PE, and preserves prior snapshots', async (status) => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    const wallet = { ...makeLinkedWallet(), status };
    db.store.set('agent_wallets/wallet_aw_123', wallet as unknown as Record<string, unknown>);
    seedRelationship(db, wallet);
    // Deletion has already released the wallet; human-alone unlink still has authority.
    db.store.set('wallets/wallet_human_9', { ...db.store.get('wallets/wallet_human_9'), released_at_ms: 10 });
    const before = { user_id: 'agent_abc', economic_snapshot: { human_bps: 8000, human: 'wallet_human_9' } };
    db.store.set('meter_act_keys_v1/previous', before);
    const other = { ...wallet, id: 'wallet_aw_other', linked_human_user_id: 'another_human' };
    db.store.set('agent_wallets/wallet_aw_other', other as unknown as Record<string, unknown>);
    await endHumanBeneficiaryLinks(deps, 'user_human');
    await endHumanBeneficiaryLinks(deps, 'user_human');
    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({ linked_human_user_id: null });
    expect(db.store.get('agent_wallets/wallet_aw_other')).toEqual(other);
    expect(db.store.get('meter_act_keys_v1/previous')).toEqual(before);
    expect((generatePE as jest.Mock).mock.calls.filter(c => (c[1] as {actionType: string}).actionType === 'agent_unlinked_from_human')).toHaveLength(1);
    expect(db.store.get('agent_bank_event_outbox_v1/beneficiary_link_ended_pe_agent_unlinked_from_human')).toBeDefined();
  });

  it('rejects a stale unlink after the authoritative relationship changes', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    const staleWallet = makeLinkedWallet();
    const changedWallet = {
      ...makeLinkedWallet(),
      linked_human_wallet_id: 'wallet_human_other',
      linked_human_user_id: 'user_other',
      linked_human_address: `0x${'c'.repeat(40)}`,
    };
    db.store.set('agent_wallets/wallet_aw_123', changedWallet as unknown as Record<string, unknown>);
    seedRelationship(db, staleWallet);
    const before = new Map(db.store);

    await expect(unbindAgentFromHuman(deps, { wallet: staleWallet }))
      .rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });

    expect(db.store).toEqual(before);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects a contradictory human identity without clearing the link', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    db.store.set(
      'agent_wallets/wallet_aw_123',
      makeLinkedWallet() as unknown as Record<string, unknown>,
    );
    seedRelationship(db, makeLinkedWallet());
    db.store.set('wallets/wallet_human_9', {
      id: 'wallet_human_9',
      type: 'human',
      user_id: 'different_user',
      address: HUMAN_ADDRESS,
    });

    await expect(unbindAgentFromHuman(deps, { wallet: makeLinkedWallet() }))
      .rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });

    expect(db.store.get('agent_wallets/wallet_aw_123')).toMatchObject({
      linked_human_wallet_id: 'wallet_human_9',
      linked_human_user_id: 'user_human',
    });
    expect(db.updates).toHaveLength(0);
  });
});

describe('updateAgentBeneficiaryShareBps', () => {
  beforeEach(() => {
    (generatePE as jest.Mock).mockClear();
  });

  it('commits prospective exact BPS through a record-only policy PE transaction', async () => {
    const db = new StubFirestore();
    const { deps, invalidateBeneficiaryStatus } = makeDeps(db);
    db.store.set(
      'agent_wallets/wallet_aw_123',
      makeLinkedWallet() as unknown as Record<string, unknown>,
    );
    seedRelationship(db, makeLinkedWallet());

    await updateAgentBeneficiaryShareBps(deps, {
      wallet: makeLinkedWallet(),
      agentShareBps: exactBps(3_500),
    });

    expect(db.store.get('agent_wallets/wallet_aw_123')!.operational_reserve_bps).toBe(3_500);
    expect(db.store.get('agent_wallets/wallet_aw_123')!.operational_reserve_ratio).toBeUndefined();
    const policyCall = (generatePE as jest.Mock).mock.calls.find((call) =>
      (call[1] as { actionType: string }).actionType === 'policy_updated');
    expect(policyCall).toBeDefined();
    expect((policyCall![1] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      policy_key: 'beneficiary_operational_reserve_bps',
      previous_agent_share_bps: 2_000,
      new_agent_share_bps: 3_500,
      beneficiary_effect: 'prospective_only',
    });
    expect((policyCall![1] as { atomicEntityWrite?: unknown }).atomicEntityWrite)
      .toEqual(expect.any(Function));
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('agent_abc');
    expect(invalidateBeneficiaryStatus).toHaveBeenCalledWith('wallet_aw_123');
  });

  it('rejects a stale BPS update instead of overwriting a concurrent transition', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    const staleWallet = makeLinkedWallet();
    db.store.set('agent_wallets/wallet_aw_123', {
      ...makeLinkedWallet(),
      operational_reserve_ratio: 0.3,
    } as unknown as Record<string, unknown>);
    seedRelationship(db, staleWallet);
    const before = new Map(db.store);

    await expect(updateAgentBeneficiaryShareBps(deps, {
      wallet: staleWallet,
      agentShareBps: exactBps(4_000),
    })).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });

    expect(db.store).toEqual(before);
    expect(db.updates).toHaveLength(0);
  });

  it('treats already-committed exact BPS as an idempotent no-op', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    db.store.set(
      'agent_wallets/wallet_aw_123',
      makeLinkedWallet() as unknown as Record<string, unknown>,
    );
    seedRelationship(db, makeLinkedWallet());

    await updateAgentBeneficiaryShareBps(deps, {
      wallet: makeLinkedWallet(),
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });

    expect(db.store.get('agent_wallets/wallet_aw_123')!.operational_reserve_ratio).toBe(0.2);
    expect(db.updates).toHaveLength(0);
  });

  it('rejects a sub-BPS value', async () => {
    const db = new StubFirestore();
    const { deps } = makeDeps(db);
    db.store.set(
      'agent_wallets/wallet_aw_123',
      makeLinkedWallet() as unknown as Record<string, unknown>,
    );
    seedRelationship(db, makeLinkedWallet());

    await expect(updateAgentBeneficiaryShareBps(deps, {
      wallet: makeLinkedWallet(),
      agentShareBps: 3_333.33 as never,
    })).rejects.toMatchObject({ code: 'beneficiary_link_identity_invalid' });
    expect(db.updates).toHaveLength(0);
  });
});
