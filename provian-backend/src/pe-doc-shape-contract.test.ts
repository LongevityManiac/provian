/**
 * PE document SHAPE CONTRACT (Pass-2 fixture-divergence remediation).
 *
 * The escrow/promise/job, forge-webhook, and court general-dispute bugs all
 * shared one root cause: hand-rolled test fixtures whose pe_history /
 * provenance_envelopes shape diverged from the REAL writers, giving green tests
 * over production reads that returned undefined.
 *
 * This test invokes the production writers (writePEHistory + generatePE) and
 * asserts their output matches the canonical field sets the shared fixture
 * builders are derived from. If a writer changes shape, this fails — forcing the
 * field-set constants + builders (and any conforming fixtures) to be updated
 * together, instead of silently drifting.
 *
 * PE METER : `generatePE` no longer stores a readable PE
 * (`provenance_envelopes`) or a `pe_history` row. It authors a PE v2 whose hash the chain tip
 * advances to, seals that PE to its owner (and an agent's linked human), and stages a transient
 * intake (`meter_relay_acts_v1`) carrying the ACT RECORD (identity + pe_hash + the pricing
 * projection) in the tip transaction. The contract's intent is unchanged and is pinned here on the
 * new shapes: the HASHED content (the PE v2), what the OWNER RECEIVES (the sealed copy), and what
 * the RELAY KEEPS (the act record / intake / act key) cannot drift from one another or from the
 * fixture builders.
 */

import crypto from 'crypto';
import {
  ACT_RECORD_FIELDS,
  METER_ACT_KEY_FIELDS,
  PE_HISTORY_FIELDS,
  PROVENANCE_ENVELOPE_FIELDS,
  RELAY_ACT_INTAKE_FIELDS,
  RELAY_PE_V2_CONTENT_FIELDS,
  RELAY_PE_V2_IDENTITY_FIELDS,
  makeMeterActKeyDoc,
  makePeHistoryDoc,
  makeProvenanceEnvelopeDoc,
} from './__test-helpers__/pe-doc-fixtures';

// --- Mocks for writePEHistory (uses admin.firestore() + jurisdiction policy) ---
let capturedHistoryDoc: Record<string, unknown> = {};
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: () => ({
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async (fn: (txn: unknown) => Promise<void>) =>
        fn({
          get: async () => ({ exists: false, data: () => undefined }),
          // The seal transaction now also writes the accrual-time aggregate
          // documents (M5); capture ONLY the pe_history row — the one
          // set whose payload carries the peId.
          set: (_ref: unknown, doc: Record<string, unknown>) => {
            if (doc.peId === 'pe_1') capturedHistoryDoc = doc;
          },
        }),
    }),
  },
}));
jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));

// --- Mocks for generatePE (atomic chain-tip + x402 resolver) ---
// Every write generatePE makes inside the chain-tip transaction, keyed by document path.
const mockTxnWrites = new Map<string, Record<string, unknown>>();
jest.mock('./pe-chain-validator', () => ({
  advanceChainTipAtomic: async (
    _db: unknown,
    _agentId: string,
    peHashOf: (prev: string) => string,
    _peTimestamp: unknown,
    coWrites?: (txn: unknown, ctx: { prevHash: string; newHash: string }) => void,
  ) => {
    const prev_hash = 'GENESIS';
    const new_hash = peHashOf(prev_hash);
    const write = (ref: { __path: string }, doc: Record<string, unknown>) => { mockTxnWrites.set(ref.__path, doc); };
    coWrites?.({ set: write, create: write, update: write }, { prevHash: prev_hash, newHash: new_hash });
    return { prev_hash, new_hash };
  },
  isThenable: () => false,
}));
jest.mock('./pvt-accrual', () => ({
  resolveX402PayerAddress: () => undefined,
  resolveX402SettlementTxHash: () => undefined,
  resolveX402ChainVerified: () => false,
}));

import { writePEHistory } from './pe-history';
import { generatePE } from './core/agent-bank/pe-utils';
import type { AgentBankDeps } from './core/agent-bank/types';
import { METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from './core/meter/meter-relay-authored';
import type { MeterActKeyDoc } from './core/meter/meter-act-key';
import { actMatchesPe, canonicalJson, peHashOf, type ActRecord, type PeV2 } from './core/meter/meter-wire';
import { fromB64u, openWithKey, toB64u } from './core/meter/sealed-box';

const asSet = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

/**
 * Drive the production writer and return the pe_history row it sealed. Every test that asserts on
 * the row calls this itself, so no test reads a row another test captured (the suite stays valid
 * under `jest --randomize`).
 */
async function sealHistoryRow(): Promise<Record<string, unknown>> {
  capturedHistoryDoc = {};
  await writePEHistory({
    peId: 'pe_1',
    userId: 'agent-1',
    timestamp: 1_700_000_000_000,
    actionType: 'coding_session',
    category: 'agent',
    attestationDepth: 'software',
    estimatedPVT: 1,
    peHash: 'h',
    jurisdiction_context: 'US',
    mint_disposition: 'record_only',
    disposition_reason_code: 'policy_record_only',
    policy_review_state: 'not_required',
    policy_review_reason_code: 'known_policy_entry',
    economic_policy_version: 'shape-contract-test/v1',
    economic_snapshot: null,
  });
  return capturedHistoryDoc;
}

describe('pe_history writer (writePEHistory) shape contract', () => {
  it('emits exactly the canonical PE_HISTORY_FIELDS', async () => {
    const row = await sealHistoryRow();
    expect(asSet(row)).toEqual([...PE_HISTORY_FIELDS].sort());
  });

  it('uses peHash/userId/actionType and NEVER hash/metadata/user_id/action_type/id', async () => {
    const row = await sealHistoryRow();
    // These are the exact distinctions every bug got wrong.
    expect(row).toHaveProperty('peHash');
    expect(row).toHaveProperty('userId');
    expect(row).toHaveProperty('actionType');
    expect(row).not.toHaveProperty('hash');
    expect(row).not.toHaveProperty('metadata');
    expect(row).not.toHaveProperty('user_id');
    expect(row).not.toHaveProperty('action_type');
    expect(row).not.toHaveProperty('id');
  });
});

// ─── generatePE: the relay PE v2, the act record, the intake, the owner's sealed copy ─────────

function x25519(): { secret: Buffer; pub: Buffer } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return {
    secret: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32),
    pub: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32),
  };
}

const OWNER_WALLET = 'wallet_aw_contract';
const HUMAN_WALLET = 'wallet_h_contract';

/** Drive the REAL generatePE; return what it staged, what the owner and linked human open, and every path it wrote. */
async function generateRelayPe(): Promise<{
  peId: string;
  peHash: string;
  intake: RelayActIntake;
  ownerPe: PeV2;
  humanPe: PeV2;
  writtenPaths: string[];
  enqueued: number;
}> {
  mockTxnWrites.clear();
  const owner = x25519();
  const human = x25519();
  const store = new Map<string, Record<string, unknown>>([
    [`commons_message_keys/${OWNER_WALLET}`, { pubkey_b64u: toB64u(owner.pub) }],
    [`commons_message_keys/${HUMAN_WALLET}`, { pubkey_b64u: toB64u(human.pub) }],
    [`agent_wallets/${OWNER_WALLET}`, { linked_human_wallet_id: HUMAN_WALLET, linked_human_user_id: 'user_h' }],
  ]);
  let enqueued = 0;
  const deps = {
    db: {
      collection: (name: string) => ({
        doc: (id: string) => ({
          __path: `${name}/${id}`,
          get: async () => {
            const data = store.get(`${name}/${id}`);
            return { exists: data !== undefined, data: () => data };
          },
        }),
        where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      }),
    } as unknown,
    peBuffer: { enqueue: () => { enqueued += 1; } },
    recordPEAccrual: () => Promise.resolve(),
  } as unknown as AgentBankDeps;

  const { peId, peHash } = await generatePE(deps, {
    walletId: OWNER_WALLET,
    agentId: 'agent-1',
    actorAddress: '0xactor',
    actionType: 'coding_session',
    metadata: { commit_sha: 'abc' },
  });
  const intake = mockTxnWrites.get(`${METER_RELAY_ACTS_COLLECTION}/${peId}`) as unknown as RelayActIntake;
  const open = (to: string, secret: Buffer): PeV2 => {
    const copy = intake.sealed.find((c) => c.to === to);
    if (!copy) throw new Error(`no sealed copy for ${to}`);
    return JSON.parse(openWithKey(secret, fromB64u(copy.box)).toString('utf8')) as PeV2;
  };
  return {
    peId,
    peHash,
    intake,
    ownerPe: open('agent:agent-1', owner.secret),
    humanPe: open('human:user_h', human.secret),
    writtenPaths: [...mockTxnWrites.keys()],
    enqueued,
  };
}

describe('relay-authored PE (generatePE) shape contract — PE meter', () => {
  it('the PE the owner receives carries exactly the canonical identity + content fields', async () => {
    const { ownerPe } = await generateRelayPe();
    expect(asSet(ownerPe)).toEqual([...RELAY_PE_V2_IDENTITY_FIELDS, ...RELAY_PE_V2_CONTENT_FIELDS].sort());
    expect(ownerPe.metadata).toEqual({ commit_sha: 'abc' });
    expect(ownerPe.agent_id).toBe('agent-1');
    expect(ownerPe.wallet_id).toBe(OWNER_WALLET);
  });

  it('the hashed content IS what the owner receives: its hash is the chain-tip hash and the act record matches it byte for byte', async () => {
    const { peHash, intake, ownerPe, humanPe } = await generateRelayPe();
    expect(peHashOf(ownerPe)).toBe(peHash);
    expect(intake.act.pe_hash).toBe(peHash);
    expect(intake.act.prev_hash).toBe('GENESIS');
    expect(actMatchesPe(intake.act, ownerPe)).toBe(true);
    // The linked human receives the SAME PE, not a projection of it.
    expect(canonicalJson(humanPe)).toBe(canonicalJson(ownerPe));
  });

  it('RED control: one changed content byte breaks both the hash and the act-record match', async () => {
    const { peHash, intake, ownerPe } = await generateRelayPe();
    const tampered: PeV2 = { ...ownerPe, metadata: { commit_sha: 'abd' } };
    expect(peHashOf(tampered)).not.toBe(peHash);
    expect(actMatchesPe(intake.act, tampered)).toBe(false);
  });

  it('the relay keeps only the act record + accrual inputs + sealed copies: exactly the canonical intake / act-record fields', async () => {
    const { intake } = await generateRelayPe();
    expect(asSet(intake as unknown as Record<string, unknown>)).toEqual([...RELAY_ACT_INTAKE_FIELDS].sort());
    expect(asSet(intake.act as unknown as Record<string, unknown>)).toEqual([...ACT_RECORD_FIELDS].sort());
    // The pricing projection is the content (never the identity slots).
    expect(asSet(intake.act.pricing as Record<string, unknown>)).toEqual([...RELAY_PE_V2_CONTENT_FIELDS].sort());
    expect(intake.sealed.map((c) => c.to).sort()).toEqual(['agent:agent-1', 'human:user_h']);
    // No free text is kept in the accrual inputs.
    expect(intake.accrual).not.toHaveProperty('inputSummary');
    expect(intake.accrual).not.toHaveProperty('outputSummary');
  });

  it('writes NO provenance_envelopes doc, NO pe_history row, and never enqueues a readable PE', async () => {
    const { peId, writtenPaths, enqueued } = await generateRelayPe();
    expect(writtenPaths).toContain(`${METER_RELAY_ACTS_COLLECTION}/${peId}`);
    expect(writtenPaths.filter((p) => p.startsWith('provenance_envelopes/') || p.startsWith('pe_history/'))).toEqual([]);
    expect(enqueued).toBe(0);
  });
});

// ─── The fixture builders conform to the writers + interfaces ─────────────────────────────────

// Exhaustive over the interfaces: adding or removing a field on RelayActIntake / MeterActKeyDoc /
// ActRecord fails TYPECHECK here, and the runtime assertions below then pin the field-set constants
// the fixture builders use to the same keys.
const INTAKE_KEYS: Record<keyof RelayActIntake, true> = {
  schema: true, pe_id: true, actor_id: true, act: true, accrual: true, durable: true, sealed: true,
  created_at_ms: true, expire_at: true,
};
const ACT_KEY_KEYS: Record<keyof MeterActKeyDoc, true> = {
  schema: true, relay_pe_id: true, client_pe_id: true, pe_hash: true, prev_hash: true, device_id: true,
  batch_hash: true, actor_id: true, timestamp: true, action_type: true, row: true, legs: true,
  unit: true, held_reason: true, side: true, created_at_ms: true, facts: true, beneficiary_id: true, expire_at: true, pending_retention_v1: true,
};
const ACT_RECORD_KEYS: Record<keyof ActRecord, true> = {
  pe_id: true, pe_hash: true, prev_hash: true, timestamp: true, action_type: true, pricing: true,
};

describe('shared fixture builders conform to the writers + encode the bug-distinctions', () => {
  it('the meter field-set constants are exactly the interfaces\' keys', () => {
    expect(Object.keys(INTAKE_KEYS).sort()).toEqual([...RELAY_ACT_INTAKE_FIELDS].sort());
    expect(Object.keys(ACT_KEY_KEYS).sort()).toEqual([...METER_ACT_KEY_FIELDS].sort());
    expect(Object.keys(ACT_RECORD_KEYS).sort()).toEqual([...ACT_RECORD_FIELDS].sort());
  });

  it('makeMeterActKeyDoc is exactly an act key whose row is a canonical pe_history row carrying commit_sha', () => {
    const key = makeMeterActKeyDoc({ peId: 'pe_k', actorId: 'agent-1', peHash: 'h', commitSha: 'abc' });
    expect(asSet(key)).toEqual([...METER_ACT_KEY_FIELDS].sort());
    const row = key.row as Record<string, unknown>;
    for (const k of Object.keys(row)) expect(PE_HISTORY_FIELDS).toContain(k);
    expect(row.commit_sha).toBe('abc');
    expect(row.peHash).toBe(key.pe_hash);
    expect(row.userId).toBe(key.actor_id);
    expect(row).not.toHaveProperty('metadata');
  });

  it('makePeHistoryDoc keys are all canonical pe_history fields (no foreign fields)', () => {
    const doc = makePeHistoryDoc();
    for (const k of Object.keys(doc)) {
      expect(PE_HISTORY_FIELDS).toContain(k);
    }
    expect(doc).toHaveProperty('peHash');
    expect(doc).not.toHaveProperty('hash');
    expect(doc).not.toHaveProperty('metadata');
  });

  it('makeProvenanceEnvelopeDoc (PRE-METER rows only) keys are all canonical envelope fields (no foreign fields)', () => {
    const doc = makeProvenanceEnvelopeDoc();
    for (const k of Object.keys(doc)) {
      expect(PROVENANCE_ENVELOPE_FIELDS).toContain(k);
    }
    expect(doc).toHaveProperty('hash');
    expect(doc).toHaveProperty('metadata');
    expect(doc).not.toHaveProperty('peHash');
  });

  it('the two shapes are NOT interchangeable: peHash is history-only, hash+metadata are envelope-only', () => {
    expect(PE_HISTORY_FIELDS).toContain('peHash');
    expect(PE_HISTORY_FIELDS).not.toContain('hash');
    expect(PE_HISTORY_FIELDS).not.toContain('metadata');
    expect(PROVENANCE_ENVELOPE_FIELDS).toContain('hash');
    expect(PROVENANCE_ENVELOPE_FIELDS).toContain('metadata');
    expect(PROVENANCE_ENVELOPE_FIELDS).not.toContain('peHash');
  });
});
