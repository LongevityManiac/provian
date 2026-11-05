/**
 * settlement runtime — the Genesis lane's source.
 *
 * The assertion that carries the most weight here is the `genesisAnchorKey` vector, and it is
 * NOT a value this test computed. It was read off the DEPLOYED kernel
 * `0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61` on Base with
 * `cast call 'genesisAnchorKey(uint8,bytes32)'`. A derivation checked against its own output is
 * the self-referential control the run contract names; checked against the contract that will
 * consult `genesisAnchorUsed[...]` on settle, it is evidence.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { runClaimInlet } from './claim-inlet';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { PVT9_ELIGIBILITY_CUT_LINE_MS, evaluateEligibility } from '../wp-ev/eligibility';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf, type SettlementDb } from './durable-settlement-store';
import {
  AGENT_WALLETS_COLLECTION,
  ENVELOPES_COLLECTION,
  NO_GENESIS_ANCHORS,
  PE_HISTORY_COLLECTION,
  buildEligibilityCandidate,
} from './claim-inlet-source';
import {
  GENESIS_GRANT_MAXIMUM_ATOMIC,
  GENESIS_GRANT_TYPES,
  GENESIS_QUALIFICATION_COLLECTION,
  bytes32Of,
  createGenesisAnchorResolver,
  createGenesisInletSource,
  genesisAnchorKey,
  projectGenesisReservation,
} from './genesis-inlet-source';

const ANCHOR_FF = `0x${'00'.repeat(31)}ff`;
const ADDR = '0x00000000000000000000000000000000000000c1';
const POST_CUT_LINE = PVT9_ELIGIBILITY_CUT_LINE_MS + 5_000;

/**
 * Vectors read from the DEPLOYED ProvianPVT9 on Base, not computed here.
 *   cast call 0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61 \
 *     'genesisAnchorKey(uint8,bytes32)(bytes32)' <grantType> <anchor>
 */
const KERNEL_ANCHOR_KEY_VECTORS: readonly { grantType: number; anchor: string; key: string }[] = [
  {
    grantType: 0,
    anchor: ANCHOR_FF,
    key: '0x80778dc73674ef7b9d522ecd29ef67877a194649d90062047174eebc18c1831c',
  },
  {
    grantType: 2,
    anchor: ANCHOR_FF,
    key: '0x0cf984a8094e8906ba1733d91774c96f9f0b0501aa29b4deca4f8a3616271b44',
  },
];

function reservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'pvt-genesis-qualification/v2',
    qualification_id: 'q-1',
    pe_id: 'pe-g1',
    action_type: 'genesis_human_signup',
    wallet_id: 'wallet_h_1',
    economic_actor_id: 'user-1',
    actor_address: ADDR,
    immutable_anchor: { anchor_kind: 'wallet_id', anchor_id: 'wallet_h_1' },
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: 'e-1',
      evidence_hash: 'h-1',
      subject_wallet_id: 'wallet_h_1',
      canonical_bounty_key: 'genesis_human_signup',
      qualifying_act: 'wallet_created',
      immutable_anchor_kind: 'wallet_id',
      immutable_anchor_id: 'wallet_h_1',
      qualifying_act_at_ms: 1_785_200_000_123,
    },
    status: 'complete',
    reserved_atomic: '75000000000000000000',
    ...overrides,
  };
}

function db(): SettlementDb {
  return createFakeFirestore() as unknown as SettlementDb;
}

describe('genesisAnchorKey mirrors the deployed kernel', () => {
  it.each(KERNEL_ANCHOR_KEY_VECTORS)(
    'grantType $grantType matches the on-chain vector',
    ({ grantType, anchor, key }) => {
      expect(genesisAnchorKey(grantType, anchor)).toBe(key);
    },
  );

  it('RED CONTROL: the grant type is part of the key, so the two vectors differ', () => {
    // If grantType were dropped from the preimage the derivation would still be a valid
    // bytes32 and every single-vector assertion above would still pass.
    expect(genesisAnchorKey(0, ANCHOR_FF)).not.toBe(genesisAnchorKey(2, ANCHOR_FF));
    expect(genesisAnchorKey(0, ANCHOR_FF)).not.toBe(genesisAnchorKey(0, `0x${'00'.repeat(31)}fe`));
  });

  it('pins the kernel grant-type numbering and per-grant maxima', () => {
    // ProvianPVT9: GENESIS_HUMAN_SIGNUP = 0, GENESIS_AGENT_SIGNUP = 1, GENESIS_DEVICE_LINK = 2.
    expect(GENESIS_GRANT_TYPES).toEqual({
      genesis_human_signup: 0, genesis_signup: 1, genesis_device_link: 2,
    });
    // `cast call genesisGrantMaximum(uint8)` on the deployed kernel.
    expect(GENESIS_GRANT_MAXIMUM_ATOMIC[0]).toBe(75_000000000000000000n);
    expect(GENESIS_GRANT_MAXIMUM_ATOMIC[1]).toBe(75_000000000000000000n);
    expect(GENESIS_GRANT_MAXIMUM_ATOMIC[2]).toBe(25_000000000000000000n);
  });

  it('domain-separates wallet ids from anchor ids', () => {
    expect(bytes32Of('a', 'x')).not.toBe(bytes32Of('b', 'x'));
    expect(bytes32Of('a', 'x')).toBe(bytes32Of('a', 'x'));
    expect(bytes32Of('a', 'x')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('projectGenesisReservation', () => {
  it('projects a complete reservation onto the kernel payload', () => {
    const projected = projectGenesisReservation(reservation());
    expect(projected.kind).toBe('projected');
    if (projected.kind !== 'projected') throw new Error('unreachable');

    expect(projected.peId).toBe('pe-g1');
    expect(projected.contributor).toBe(ADDR);
    expect(projected.genesis.grantType).toBe(0);
    expect(projected.genesis.reservedGrossAtomic).toBe('75000000000000000000');
    // Milliseconds -> seconds, floored. The kernel compares against uint64 seconds.
    expect(projected.genesis.qualifiedAt).toBe(1_785_200_000);
    expect(projected.genesis.genesisAnchorKey)
      .toBe(genesisAnchorKey(0, projected.genesis.oneTimeAnchor));
    expect(projected.genesis.oneTimeAnchor).toMatch(/^0x[0-9a-f]{64}$/);
    expect(projected.genesis.walletId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([
    ['pending_reservation'], ['reserved'], ['emitting'], ['pe_recorded'], ['denied'],
  ])('REFUSES status %s — only a complete reservation may settle', (status) => {
    expect(projectGenesisReservation(reservation({ status })))
      .toEqual({ kind: 'refused', reason: 'status_not_complete' });
  });

  it('RED CONTROL: the identical row at status complete IS projected', () => {
    expect(projectGenesisReservation(reservation({ status: 'complete' })).kind).toBe('projected');
  });

  it('refuses an action type the kernel does not price', () => {
    expect(projectGenesisReservation(reservation({ action_type: 'genesis_funding_bonus' })))
      .toEqual({ kind: 'refused', reason: 'unknown_grant_type' });
  });

  it('refuses a reservation above the kernel maximum for its grant type', () => {
    // A device link is worth 25 PVT gross; 75 would revert `InvalidGenesisGrant` and take the
    // whole batch with it.
    expect(projectGenesisReservation(reservation({
      action_type: 'genesis_device_link', reserved_atomic: '75000000000000000000',
    }))).toEqual({ kind: 'refused', reason: 'reserved_gross_above_kernel_maximum' });

    // RED CONTROL: exactly the maximum is fine — the bound is `>`, not `>=`.
    expect(projectGenesisReservation(reservation({
      action_type: 'genesis_device_link', reserved_atomic: '25000000000000000000',
    })).kind).toBe('projected');
  });

  it('refuses a zero or malformed reservation amount', () => {
    expect(projectGenesisReservation(reservation({ reserved_atomic: '0' })).kind).toBe('refused');
    expect(projectGenesisReservation(reservation({ reserved_atomic: 'x' })).kind).toBe('refused');
    expect(projectGenesisReservation(reservation({ reserved_atomic: undefined })).kind)
      .toBe('refused');
  });

  it('refuses a missing anchor, wallet id, pe id, or actor address', () => {
    expect(projectGenesisReservation(reservation({ immutable_anchor: null })))
      .toEqual({ kind: 'refused', reason: 'missing_anchor' });
    expect(projectGenesisReservation(reservation({ wallet_id: undefined })))
      .toEqual({ kind: 'refused', reason: 'missing_wallet_id' });
    expect(projectGenesisReservation(reservation({ pe_id: undefined })))
      .toEqual({ kind: 'refused', reason: 'missing_pe_id' });
    expect(projectGenesisReservation(reservation({ actor_address: 'not-an-address' })))
      .toEqual({ kind: 'refused', reason: 'invalid_actor_address' });
  });

  it('refuses a qualification instant it cannot read', () => {
    expect(projectGenesisReservation(reservation({ qualifying_act_evidence: {} })))
      .toEqual({ kind: 'refused', reason: 'invalid_qualified_at' });
  });

  it('gives two grants on the SAME anchor id different one-time anchors', () => {
    // A wallet that both signed up and linked a device shares one anchor id. If the two
    // collapsed onto one `oneTimeAnchor`, `genesisAnchorUsed` would reject the second grant
    // outright — a wallet losing 25 PVT it qualified for.
    const signup = projectGenesisReservation(reservation());
    const device = projectGenesisReservation(reservation({
      action_type: 'genesis_device_link',
      pe_id: 'pe-g2',
      reserved_atomic: '25000000000000000000',
    }));
    if (signup.kind !== 'projected' || device.kind !== 'projected') throw new Error('unreachable');
    expect(signup.genesis.oneTimeAnchor).not.toBe(device.genesis.oneTimeAnchor);
    expect(signup.genesis.genesisAnchorKey).not.toBe(device.genesis.genesisAnchorKey);
  });
});

describe('createGenesisInletSource', () => {
  async function seed(database: SettlementDb, row: Record<string, unknown>): Promise<void> {
    const id = String(row.qualification_id);
    await database.collection(GENESIS_QUALIFICATION_COLLECTION).doc(id).set(row);
    const peId = String(row.pe_id);
    await database.collection(PE_HISTORY_COLLECTION).doc(peId).set({
      peId,
      userId: 'user-1',
      attestationDepth: 'software',
      attestation_verified: true,
      mint_status: 'eligible',
      record_points_atomic: String(row.reserved_atomic),
      corroboration_status: 'none',
      is_genesis_grant: true,
    });
    await database.collection(ENVELOPES_COLLECTION).doc(peId).set({
      id: peId,
      prev_hash: GENESIS_PREV_HASH,
      hash: `0x${peId.length.toString(16).padStart(64, '0')}`,
      timestamp: POST_CUT_LINE,
      action_type: String(row.action_type),
      user_id: 'user-1',
    });
  }

  it('offers a complete reservation as a Genesis candidate carrying its anchor evidence', async () => {
    const database = db();
    await seed(database, reservation());

    const page = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });

    expect(page.readCount).toBe(1);
    expect(page.candidates.length).toBe(1);
    const candidate = page.candidates[0];
    expect(candidate.lane).toBe('genesis');
    expect(candidate.contributor).toBe(ADDR);
    // For a Genesis grant the anchor IS the act, and unlike the standard lane its uniqueness
    // is genuinely enforced on-chain — so it is admissible work evidence here and only here.
    expect(candidate.eligibility.workEvidence.oneTimeAnchor).toMatch(/^0x[0-9a-f]{64}$/);
    expect(candidate.eligibility.chainVerified).toBe(true);
  });

  it('filters a reservation already in the claim ledger but still counts the read', async () => {
    const database = db();
    await seed(database, reservation());
    await database.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-g1', 'sole'))
      .set({ pe_id: 'pe-g1' });

    const page = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.readCount).toBe(1);
    expect(page.candidates).toEqual([]);
    expect(page.lastKey).toBe('q-1');
  });

  it('resolves the SAME anchor for the approval gate that the inlet admitted', async () => {
    // The two-lane fork run failed exactly here before this resolver existed: the inlet
    // admitted the Genesis PE carrying its anchor, the approval gate re-projected the PE from
    // `pe_history` alone — where no anchor lives — found no work evidence, and refused its own
    // batch with `ghost_pe_no_work_evidence`. One PE, two projections, two answers.
    const database = db();
    await seed(database, reservation());

    const page = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });
    const admitted = page.candidates[0].eligibility.workEvidence.oneTimeAnchor;
    expect(admitted).toMatch(/^0x[0-9a-f]{64}$/);

    const resolved = await createGenesisAnchorResolver(database)('pe-g1');
    expect(resolved).toBe(admitted);

    const candidate = await buildEligibilityCandidate(
      database, 'pe-g1', createGenesisAnchorResolver(database),
    );
    expect(candidate?.workEvidence.oneTimeAnchor).toBe(admitted);
    expect(evaluateEligibility(candidate!).kind).toBe('eligible');

    // RED CONTROL: the same PE judged WITHOUT the resolver is a ghost. This is the exact
    // verdict the fork run produced, and the reason the resolver is a required parameter.
    const anchorless = await buildEligibilityCandidate(database, 'pe-g1', NO_GENESIS_ANCHORS);
    const verdict = evaluateEligibility(anchorless!);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind === 'ineligible') {
      expect(verdict.reasons).toContain('ghost_pe_no_work_evidence');
    }
  });

  it('refuses to resolve an anchor when two reservations name one PE', async () => {
    const database = db();
    await seed(database, reservation());
    await database.collection(GENESIS_QUALIFICATION_COLLECTION).doc('q-2')
      .set(reservation({ qualification_id: 'q-2' }));
    // Two grants for one act is the double-pay shape. Unknown = block.
    expect(await createGenesisAnchorResolver(database)('pe-g1')).toBeNull();
  });

  it('resolves null for a PE with no reservation at all', async () => {
    expect(await createGenesisAnchorResolver(db())('pe-nothing')).toBeNull();
  });

  it('never offers an incomplete reservation, even one the query returned', async () => {
    const database = db();
    // Seeded at `complete` so the query matches, then downgraded — modelling a row the index
    // has not caught up on. The projection is the authority, not the query.
    await seed(database, reservation());
    await database.collection(GENESIS_QUALIFICATION_COLLECTION).doc('q-1')
      .set(reservation({ status: 'pe_recorded' }));

    const page = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.candidates).toEqual([]);

    // RED CONTROL: restored to complete, it is offered — so the refusal is about the status.
    await database.collection(GENESIS_QUALIFICATION_COLLECTION).doc('q-1').set(reservation());
    const again = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(again.candidates.length).toBe(1);
  });

  // /10-01 (supersedes and addendum 3): every agent with its own
  // wallet draws its own grant, however it was onboarded. A grant whose agent wallet names a
  // parent is offered exactly like a parentless agent's.
  function childDeviceGrant(): Record<string, unknown> {
    return reservation({
      action_type: 'genesis_device_link',
      wallet_id: 'wallet_aw_child',
      economic_actor_id: 'wallet_aw_child',
      immutable_anchor: { anchor_kind: 'registered_device_id', anchor_id: 'dev_child' },
      reserved_atomic: '25000000000000000000',
    });
  }

  it.each([
    ['names a parent', { parent_wallet_id: 'wallet_aw_parent' }],
    ['names no parent', { parent_wallet_id: null }],
  ])('offers a Genesis grant whose agent wallet %s (parenthood refuses nothing)', async (_label, walletFields) => {
    const database = db();
    await seed(database, childDeviceGrant());
    await database.collection(AGENT_WALLETS_COLLECTION).doc('wallet_aw_child')
      .set({ id: 'wallet_aw_child', ...walletFields });

    const page = await createGenesisInletSource({ db: database }).loadPage({ pageSize: 10 });
    expect(page.readCount).toBe(1);
    expect(page.candidates.length).toBe(1);
    expect(page.candidates[0].peId).toBe(String(childDeviceGrant().pe_id));
  });
});

// L644 — the Genesis settlement inlet reads the outbox correctly at any backlog size: it pages
// on `qualification_id` and the run carries its stop position to the next run, so a backlog far
// above one run's scan budget is registered in full, never stranded past the first horizon.
describe('createGenesisInletSource — any backlog size (L644)', () => {
  const BACKLOG = 600;
  const BUDGET = { pageSize: 100, maxPesPerRun: 250, maxRunMs: 60_000 };
  const qid = (i: number): string => `q-${String(i).padStart(4, '0')}`;

  async function seedBacklog(database: SettlementDb): Promise<void> {
    for (let i = 0; i < BACKLOG; i += 1) {
      const wallet = `wallet_h_${i}`;
      const peId = `pe-g${String(i).padStart(4, '0')}`;
      const row = reservation({
        qualification_id: qid(i),
        pe_id: peId,
        wallet_id: wallet,
        economic_actor_id: `user-${i}`,
        immutable_anchor: { anchor_kind: 'wallet_id', anchor_id: wallet },
        qualifying_act_evidence: {
          ...(reservation().qualifying_act_evidence as Record<string, unknown>),
          subject_wallet_id: wallet,
          immutable_anchor_id: wallet,
          evidence_id: `e-${i}`,
        },
      });
      await database.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qid(i)).set(row);
      await database.collection(PE_HISTORY_COLLECTION).doc(peId).set({
        peId, userId: `user-${i}`, attestationDepth: 'software', attestation_verified: true,
        mint_status: 'eligible', record_points_atomic: String(row.reserved_atomic),
        corroboration_status: 'none', is_genesis_grant: true,
      });
      await database.collection(ENVELOPES_COLLECTION).doc(peId).set({
        id: peId, prev_hash: GENESIS_PREV_HASH, hash: `0x${i.toString(16).padStart(64, '0')}`,
        timestamp: POST_CUT_LINE, action_type: 'genesis_human_signup', user_id: `user-${i}`,
      });
    }
  }

  async function ledgerSize(database: SettlementDb): Promise<number> {
    return (await database.collection(CLAIM_LEDGER_COLLECTION).get()).docs.length;
  }

  async function runs(database: SettlementDb, n: number, carryCursor: boolean): Promise<void> {
    let cursor: string | undefined;
    for (let r = 0; r < n; r += 1) {
      const report = await runClaimInlet(
        { db: database, source: createGenesisInletSource({ db: database }), now: () => 1 },
        { ...BUDGET, ...(carryCursor && cursor !== undefined ? { startAfterKey: cursor } : {}) },
      );
      cursor = report.nextStartAfterKey ?? undefined;
    }
  }

  it('one page never exceeds its requested size, and pages tile the outbox in qualification_id order', async () => {
    const database = db();
    await seedBacklog(database);
    const source = createGenesisInletSource({ db: database });
    const seen: string[] = [];
    let key: string | undefined;
    for (;;) {
      const page = await source.loadPage({ pageSize: 100, ...(key === undefined ? {} : { startAfterKey: key }) });
      expect(page.readCount).toBeLessThanOrEqual(100);
      if (page.readCount === 0) break;
      seen.push(...page.candidates.map((c) => c.peId));
      key = page.lastKey;
    }
    expect(seen.length).toBe(BACKLOG);
    expect(new Set(seen).size).toBe(BACKLOG);
  });

  it('successive budget-bounded runs register the WHOLE backlog (600 > one run\'s 250)', async () => {
    const database = db();
    await seedBacklog(database);
    await runs(database, Math.ceil(BACKLOG / BUDGET.maxPesPerRun), true);
    expect(await ledgerSize(database)).toBe(BACKLOG);
  });

  it('RED CONTROL — without carrying the cursor the same runs re-scan the head and strand the tail', async () => {
    const database = db();
    await seedBacklog(database);
    await runs(database, Math.ceil(BACKLOG / BUDGET.maxPesPerRun), false);
    expect(await ledgerSize(database)).toBe(BUDGET.maxPesPerRun);
    expect(await ledgerSize(database)).toBeLessThan(BACKLOG);
  });
});
