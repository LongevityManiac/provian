/**
 * Receive authorship detection — behaviour plus its RED controls.
 *
 * Mirrors the fixture discipline of `same-owner-detection.test.ts` every
 * seeded document is the SAME shape production writes (escrow docs carry
 * `depositor_address`/`recipient_address` directly, per `EscrowDocument`;
 * job docs carry `poster_address`/`assigned_address`, per `JobDocument`;
 * `provenance_envelopes` carries `user_id`/`counterparty_address`/
 * `action_type` exactly as `pe-utils.ts`'s `generatePE` stores them).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../native-wallet-registration';
import { resolveReceiveAuthorship } from './receive-authorship';

const AGENT_1 = 'agent_1';
const WALLET_ADDR = '0x1111111111111111111111111111111111111111';
const COUNTERPARTY = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const EXTERNAL_ADDR = '0x4444444444444444444444444444444444444444';
const NATIVE_ADDR = '0x5555555555555555555555555555555555555555';

type DB = ReturnType<typeof createFakeFirestore>;

/** Mirrors `same-owner-detection.test.ts`'s `seedAgent`: registration index
 *  row (agent_id -> wallet_id) plus the `agent_wallets` doc carrying the
 *  NATIVE address — the same two documents production writes. */
function seedAgentNativeAddress(db: DB, opts: { agentId: string; walletId: string; address: string }): void {
  db.store.set(
    `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(opts.agentId)}`,
    { wallet_id: opts.walletId, agent_id: opts.agentId },
  );
  db.store.set(`agent_wallets/${opts.walletId}`, { id: opts.walletId, address: opts.address });
}

describe('resolveReceiveAuthorship — no relationship found (RED CONTROL)', () => {
  it('is NOT authored when nothing ties the wallet to the counterparty', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
    expect(verdict.unresolvable).toBe(false);
    expect(verdict.reason).toBe('no_recipient_authored_relationship');
  });

  it('unrelated data (a relationship with a DIFFERENT counterparty) does not leak a false positive', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_unrelated', {
      user_id: AGENT_1,
      action_type: 'send',
      counterparty_address: STRANGER, // not COUNTERPARTY
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
  });

  it('a RECEIVE to this counterparty (not an outbound act) does not count as authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_receive_not_outbound', {
      user_id: AGENT_1,
      action_type: 'receive', // the wrong direction - not send/x402_payment
      counterparty_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
  });
});

describe('resolveReceiveAuthorship — authored via prior outbound PE', () => {
  it('a prior `send` to this counterparty is authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_prior_send', {
      user_id: AGENT_1,
      action_type: 'send',
      counterparty_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
    expect(verdict.unresolvable).toBe(false);
  });

  it('a prior `x402_payment` to this counterparty is authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_prior_x402', {
      user_id: AGENT_1,
      action_type: 'x402_payment',
      counterparty_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('a prior send belonging to a DIFFERENT wallet does not authorize this one', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_other_wallet_send', {
      user_id: 'agent_other',
      action_type: 'send',
      counterparty_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
  });
});

describe('resolveReceiveAuthorship — authored via escrow', () => {
  it('an escrow where the wallet is depositor and counterparty is recipient is authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_1', {
      escrow_id: 'escrow_1',
      depositor_address: WALLET_ADDR,
      recipient_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('an escrow where the wallet is recipient and counterparty is depositor is ALSO authorship (either side)', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_2', {
      escrow_id: 'escrow_2',
      depositor_address: COUNTERPARTY,
      recipient_address: WALLET_ADDR,
      status: 'created',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('an escrow with the wallet on one side but a THIRD PARTY (not the counterparty) on the other does not authorize', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_3', {
      escrow_id: 'escrow_3',
      depositor_address: WALLET_ADDR,
      recipient_address: STRANGER, // not COUNTERPARTY
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
  });
});

describe('resolveReceiveAuthorship — authored via agent job board', () => {
  it('a job where the wallet posted and counterparty was assigned is authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('jobs/job_1', {
      poster_address: WALLET_ADDR,
      assigned_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('a job where the wallet was assigned and counterparty posted is ALSO authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('jobs/job_2', {
      poster_address: COUNTERPARTY,
      assigned_address: WALLET_ADDR,
      status: 'assigned',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });
});

describe('resolveReceiveAuthorship — external-proven wallet matches its NATIVE address history', () => {
  it('an escrow held under the NATIVE address counts, even when the passed walletAddress is a different proven-external address', async () => {
    const db: DB = createFakeFirestore();
    seedAgentNativeAddress(db, { agentId: AGENT_1, walletId: 'wallet_aw_1', address: NATIVE_ADDR });
    db.store.set('escrows/escrow_native', {
      escrow_id: 'escrow_native',
      depositor_address: NATIVE_ADDR, // native, NOT the passed external address
      recipient_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: EXTERNAL_ADDR, // the funded (proven-external) address on this transfer
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('RED CONTROL: without native-address resolution this would be missed — no relationship on the passed address alone', async () => {
    const db: DB = createFakeFirestore();
    // No registration/native-address seed at all: the check can only see
    // whatever address was passed in, which has no escrow history.
    db.store.set('escrows/escrow_native', {
      escrow_id: 'escrow_native',
      depositor_address: NATIVE_ADDR,
      recipient_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: EXTERNAL_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
  });

  it('a job held under the NATIVE address counts too', async () => {
    const db: DB = createFakeFirestore();
    seedAgentNativeAddress(db, { agentId: AGENT_1, walletId: 'wallet_aw_1', address: NATIVE_ADDR });
    db.store.set('jobs/job_native', {
      poster_address: NATIVE_ADDR,
      assigned_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: EXTERNAL_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('an unregistered actor (no native-index row) falls back to the passed address only, without throwing', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_passed', {
      escrow_id: 'escrow_passed',
      depositor_address: WALLET_ADDR,
      recipient_address: COUNTERPARTY,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1, // no registration index row seeded for this actor
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
    expect(verdict.unresolvable).toBe(false);
  });
});

describe('resolveReceiveAuthorship — outbound-PE scan is ordered most-recent-first', () => {
  // RED CONTROL: binds RELATIONSHIP_SCAN_LIMIT (200) for real. A 2-doc
  // fixture can't tell an ordered scan from an unordered one - the fake's
  // in-memory query engine only reorders results when `.orderBy()` is
  // present, and with 200 docs unfiltered, whichever set the query returns
  // is a strict superset when the window doesn't bind. This seeds exactly
  // RELATIONSHIP_SCAN_LIMIT + 1 docs to this counterparty: 200 non-qualifying
  // "noise" docs inserted FIRST, then the one qualifying `send` inserted
  // LAST but stamped with the newest `created_at`. Only a `created_at desc`
  // scan puts it inside the returned 200; a scan with no ordering (or the
  // fake's raw insertion order) returns the 200 noise docs and drops it -
  // verified below by deleting the `.orderBy` call and confirming this same
  // test fails.
  it('finds a qualifying prior send that is the NEWEST doc but the (RELATIONSHIP_SCAN_LIMIT + 1)-th INSERTED', async () => {
    const db: DB = createFakeFirestore();
    for (let i = 0; i < 200; i += 1) {
      db.store.set(`provenance_envelopes/pe_noise_${i}`, {
        user_id: AGENT_1,
        action_type: 'receive', // never a qualifying OUTBOUND_RELATIONSHIP_ACTION_TYPE
        counterparty_address: COUNTERPARTY,
        created_at: i, // all older than the qualifying doc below
      });
    }
    db.store.set('provenance_envelopes/pe_qualifying_send', {
      user_id: AGENT_1,
      action_type: 'send',
      counterparty_address: COUNTERPARTY,
      created_at: 999999, // newest by far - kept by a `desc` sort regardless of insertion order
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });
});

describe('resolveReceiveAuthorship — contract-mediated escrow/job payouts', () => {
  const ESCROW_CONTRACT = '0x6666666666666666666666666666666666666666';
  let prevEscrowEnv: string | undefined;

  beforeEach(() => {
    prevEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    process.env.ESCROW_CONTRACT_ADDRESS = ESCROW_CONTRACT;
  });
  afterEach(() => {
    if (prevEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = prevEscrowEnv;
  });

  // An escrow release/refund transfers OUT OF the escrow CONTRACT
  // (`escrow.ts`'s `expectedTo: escrowContractAddress`), so the inbound
  // watcher stamps the receive's counterparty as the CONTRACT's address —
  // never the other party's wallet. The plain two-sided check can never
  // match this (no escrow/job doc stores the contract's own address), so
  // this must route through the relaxed "any participation" check instead.
  it('a wallet with ANY escrow history is authored when the counterparty is the escrow contract itself', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_unrelated_counterparty', {
      escrow_id: 'escrow_unrelated_counterparty',
      depositor_address: WALLET_ADDR,
      recipient_address: STRANGER, // NOT the observed counterparty (the contract) - irrelevant here
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: ESCROW_CONTRACT,
    });
    expect(verdict.authored).toBe(true);
  });

  it('a wallet with ANY job history is authored when the counterparty is the escrow contract (jobs settle through escrow)', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('jobs/job_unrelated_counterparty', {
      poster_address: STRANGER,
      assigned_address: WALLET_ADDR,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: ESCROW_CONTRACT,
    });
    expect(verdict.authored).toBe(true);
  });

  // RED CONTROL: without ANY escrow/job history at all, a transfer FROM the
  // escrow contract is still not authored - the contract address alone is
  // not a free pass, only a signal that the OTHER check (any participation)
  // is the right one to run.
  it('RED CONTROL: a wallet with NO escrow/job history at all is still unauthored, even from the escrow contract', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: ESCROW_CONTRACT,
    });
    expect(verdict.authored).toBe(false);
  });

  // RED CONTROL: without the escrow-contract special case, this specific
  // scenario is exactly what defect #1 in the second review pass described -
  // a real escrow payout wrongly sealed record_only because the counterparty
  // (the contract) never appears in escrows/jobs the ordinary two-sided way.
  it('RED CONTROL: the ordinary two-sided check alone would miss this (counterparty is the contract, not a stored party address)', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/escrow_real', {
      escrow_id: 'escrow_real',
      depositor_address: STRANGER,
      recipient_address: WALLET_ADDR,
      status: 'completed',
    });
    // Confirm the ESCROW_CONTRACT address itself never appears as either
    // side of this escrow - the two-sided check has nothing to match.
    const stored = db.store.get('escrows/escrow_real') as Record<string, unknown>;
    expect(stored.depositor_address).not.toBe(ESCROW_CONTRACT);
    expect(stored.recipient_address).not.toBe(ESCROW_CONTRACT);
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: ESCROW_CONTRACT,
    });
    expect(verdict.authored).toBe(true); // only true because of the contract-mediated relaxation
  });

  it('a peer transfer NOT from the escrow contract still uses the strict two-sided check', async () => {
    const db: DB = createFakeFirestore();
    // Same wallet has unrelated escrow history, but the counterparty here is
    // an ordinary peer address, not the contract - must NOT get the relaxed
    // "any participation" treatment.
    db.store.set('escrows/escrow_unrelated', {
      escrow_id: 'escrow_unrelated',
      depositor_address: WALLET_ADDR,
      recipient_address: STRANGER,
      status: 'completed',
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY, // an ordinary peer, not ESCROW_CONTRACT
    });
    expect(verdict.authored).toBe(false);
  });
});

describe('resolveReceiveAuthorship — no counterparty / no identity (fail closed, not a pass)', () => {
  it('a null counterparty address is not authored', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: null,
    });
    expect(verdict.authored).toBe(false);
    expect(verdict.unresolvable).toBe(false);
    expect(verdict.reason).toBe('no_counterparty_address');
  });

  it('no economicActorId and no walletAddress at all is not authored (nothing to check)', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: null,
      walletAddress: null,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
    expect(verdict.unresolvable).toBe(false);
  });
});

describe('resolveReceiveAuthorship — fail-closed on a registry read failure', () => {
  // RED CONTROL: a read failure must surface as unresolvable, NOT as
  // `authored: false` treated identically to genuine absence - the caller
  // routes unresolvable to a recoverable pending_review hold, while a
  // resolved "not authored" verdict seals a PERMANENT record_only. Collapsing
  // the two would let a transient Firestore outage permanently strip a real
  // relationship's mint eligibility with no way to recover it later.
  it('a throwing db surfaces unresolvable: true, distinct from a resolved non-match', async () => {
    const throwingDb = {
      collection: () => { throw new Error('firestore_unavailable'); },
    } as unknown as Firestore;
    const verdict = await resolveReceiveAuthorship(throwingDb, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(false);
    expect(verdict.unresolvable).toBe(true);
    expect(verdict.reason).toContain('receive_authorship_registry_unavailable');
  });
});

/**
 * -b (sibling copy). `normalizeAddress` here is the same function as in
 * `same-owner-detection.ts` and had the same literal-lowercase-`0x` defect: a
 * `0X`-prefixed counterparty read as `no_counterparty_address`, which on THIS
 * gate is a fail-CLOSED mis-decision (an authored receive sealed record_only)
 * rather than a skip — but it is still the wrong verdict on the same input,
 * so it is widened with the same control.
 *
 * RED CONTROL RECORD (observed against the pre-fix source, commit 8b408220):
 * both cases FAILED — `verdict.reason` was `no_counterparty_address` and
 * `authored` was false for the `0X` counterparty; for the `0X` wallet address
 * the escrow relationship was not found (`no_recipient_authored_relationship`).
 */
describe('-b — counterparty / wallet address prefix case', () => {
  it('a `0X`-prefixed counterparty is normalized, not read as no_counterparty_address', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_prior_send', {
      user_id: AGENT_1,
      action_type: 'send',
      counterparty_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: `0X${COUNTERPARTY.slice(2)}`,
    });
    expect(verdict.reason).not.toBe('no_counterparty_address');
    expect(verdict.authored).toBe(true);
  });

  it('a `0X`-prefixed wallet address still matches its escrow relationship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set('escrows/esc_1', {
      depositor_address: WALLET_ADDR,
      recipient_address: COUNTERPARTY,
    });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: null,
      walletAddress: `0X${WALLET_ADDR.slice(2)}`,
      counterpartyAddress: COUNTERPARTY,
    });
    expect(verdict.authored).toBe(true);
  });

  it('GREEN CONTROL: a genuinely malformed counterparty still reads as no_counterparty_address', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1,
      walletAddress: WALLET_ADDR,
      counterpartyAddress: `0Y${COUNTERPARTY.slice(2)}`,
    });
    expect(verdict.reason).toBe('no_counterparty_address');
  });
});

/**
 *. A facilitator settlement on Solana with a non-Provian party names that party's raw base58
 * address. The EVM-only normalizer read it as `no_counterparty_address`, so a receive back from a
 * party the recipient had paid could never be authored. RED CONTROL RECORD (pre-fix source): the
 * first case returned `{ authored: false, reason: 'no_counterparty_address' }`.
 */
describe('a Solana counterparty', () => {
  const SOL_PEER = '6ruSP2eFqg7tvhBJaa6zzhqdp1n5KJFMNLMYaJvX9pXt';

  it('a recorded outbound pair to the exact base58 address is authorship', async () => {
    const db: DB = createFakeFirestore();
    db.store.set(`counterparty_pairs_v1/${AGENT_1}__${SOL_PEER}`, { actor_id: AGENT_1, counterparty: SOL_PEER, outbound_count: 1 });
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1, walletAddress: WALLET_ADDR, counterpartyAddress: SOL_PEER,
    });
    expect(verdict.authored).toBe(true);
  });

  it('RED CONTROL: no pair is not authored, and the reason is not "no counterparty"', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1, walletAddress: WALLET_ADDR, counterpartyAddress: SOL_PEER,
    });
    expect(verdict.authored).toBe(false);
    expect(verdict.reason).not.toBe('no_counterparty_address');
  });

  it('a base58-shaped string that is not a 32-byte key is still no counterparty', async () => {
    const db: DB = createFakeFirestore();
    const verdict = await resolveReceiveAuthorship(db as never, {
      economicActorId: AGENT_1, walletAddress: WALLET_ADDR, counterpartyAddress: '1111',
    });
    expect(verdict.reason).toBe('no_counterparty_address');
  });
});
