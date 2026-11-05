/**
 * beneficiary routing — tests for the single receipt-driven institution state machine.
 *
 * Proves the four properties the beneficiary routing acceptance names — retries (idempotency),
 * finality (an economic transition needs a Base-final verified receipt), no
 * duplicate economic PE (tx-hash dedup), and the record-only draft path — plus
 * kill-switch-first ordering, Unknown = Block on unknown kinds/illegal edges,
 * and per-institution lifecycle walks.
 */

import {
  INSTITUTION_KINDS,
  INITIAL,
  ESCROW_STATES,
  PROMISE_STATES,
  POOL_STATES,
  BOND_STATES,
  BOND_CLAIM_STATES,
  JOB_STATES,
  HUMAN_JOB_STATES,
  COURT_DISPUTE_STATES,
  GENERAL_DISPUTE_STATES,
  classifyTransition,
  findTransition,
  receiptFromVerification,
  evaluateInstitutionTransition,
  type InstitutionKind,
} from './institution-state-machine';

const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;
const TX_MIXED = `0x${'AbCdEf'.repeat(10)}${'1234'}`; // 64 hex, mixed case

const okReceipt = (txHash: string) => ({ ok: true as const, txHash, confirmations: 12 });
const finalityPending = (txHash: string) => ({
  ok: false as const,
  reason: 'insufficient_confirmations: 3/12',
  txHash,
  confirmations: 3,
});

describe('institution-state-machine — kill switch is checked FIRST', () => {
  it('blocks a valid economic transition when the kill switch is active', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: okReceipt(TX_A),
      killSwitchActive: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('kill_switch_active');
  });

  it('blocks even an ILLEGAL transition with kill_switch_active (ordering: killswitch before legality)', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'completed',
      to: 'created',
      killSwitchActive: true,
    });
    expect(decision.allowed === false && decision.reason).toBe('kill_switch_active');
  });

  it('blocks even an unknown kind with kill_switch_active', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'not_a_kind' as InstitutionKind,
      from: 'a',
      to: 'b',
      killSwitchActive: true,
    });
    expect(decision.allowed === false && decision.reason).toBe('kill_switch_active');
  });

  it('a record-only draft still proceeds when the kill switch is NOT active', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: INITIAL,
      to: 'created',
      killSwitchActive: false,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.economic).toBe(false);
  });
});

describe('institution-state-machine — Unknown = Block', () => {
  it('blocks an unknown institution kind', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'insurance' as InstitutionKind,
      from: 'created',
      to: 'funded',
      receipt: okReceipt(TX_A),
    });
    expect(decision.allowed === false && decision.reason).toBe('unknown_institution_kind');
  });

  it('blocks an undeclared (illegal) transition even with a valid receipt', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'completed', // must pass through funded
      receipt: okReceipt(TX_A),
    });
    expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
  });

  it('blocks a backwards transition', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'promise',
      from: 'settled',
      to: 'funded',
      receipt: okReceipt(TX_A),
    });
    expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
  });

  it('blocks a self-loop that was never declared', () => {
    // bond active→active became a DECLARED economic edge in bond lifecycle (renew /
    // top-up); a terminal self-loop stays undeclared and must still block.
    const decision = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'withdrawn',
      to: 'withdrawn',
      receipt: okReceipt(TX_A),
    });
    expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
  });
});

describe('institution-state-machine — record-only drafts need no receipt', () => {
  it('escrow created (draft) is allowed with no receipt and moves no money', () => {
    const decision = evaluateInstitutionTransition({ kind: 'escrow', from: INITIAL, to: 'created' });
    expect(decision).toEqual({ allowed: true, economic: false, idempotent: false });
  });

  it('a raised dispute is record-only (no settlement yet)', () => {
    const decision = evaluateInstitutionTransition({ kind: 'escrow', from: 'funded', to: 'disputed' });
    expect(decision.allowed === true && decision.economic).toBe(false);
  });

  it('cancelling an unfunded draft is record-only', () => {
    const decision = evaluateInstitutionTransition({ kind: 'promise', from: 'open', to: 'cancelled' });
    expect(decision.allowed === true && decision.economic).toBe(false);
  });

  it('a record-only transition ignores any receipt passed alongside it', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'pool',
      from: INITIAL,
      to: 'open',
      receipt: finalityPending(TX_A), // not ok — but irrelevant for a draft
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.economic).toBe(false);
  });
});

describe('institution-state-machine — finality gate (economic needs a Base-final receipt)', () => {
  it('blocks an economic transition with NO receipt', () => {
    const decision = evaluateInstitutionTransition({ kind: 'escrow', from: 'created', to: 'funded' });
    expect(decision.allowed === false && decision.reason).toBe('receipt_required');
    expect(decision.allowed === false && decision.economic).toBe(true);
  });

  it('blocks an economic transition with a null receipt', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: null,
    });
    expect(decision.allowed === false && decision.reason).toBe('receipt_required');
  });

  it('blocks when the receipt is NOT yet final (insufficient confirmations)', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'promise',
      from: 'open',
      to: 'funded',
      receipt: finalityPending(TX_A),
    });
    expect(decision.allowed === false && decision.reason).toBe('unverified_receipt');
    expect(decision.allowed === false && decision.economic).toBe(true);
  });

  it('blocks when the verifier rejected the receipt (e.g. no matching transfer log)', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'bond',
      from: INITIAL,
      to: 'active',
      receipt: { ok: false, reason: 'bond_posted_event_not_found', txHash: TX_A },
    });
    expect(decision.allowed === false && decision.reason).toBe('unverified_receipt');
  });

  it('blocks an ok receipt that carries no usable tx hash', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: { ok: true },
    });
    expect(decision.allowed === false && decision.reason).toBe('receipt_missing_tx_hash');
  });

  it('blocks an ok receipt whose tx hash is malformed', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: { ok: true, txHash: '0xnothex' },
    });
    expect(decision.allowed === false && decision.reason).toBe('receipt_missing_tx_hash');
  });

  it('ALLOWS an economic transition behind an ok, final receipt', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: okReceipt(TX_A),
    });
    expect(decision).toEqual({ allowed: true, economic: true, idempotent: false, txHash: TX_A });
  });
});

describe('institution-state-machine — idempotency (retries record no duplicate economic PE)', () => {
  it('flags a retry of an already-settled tx hash as idempotent', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'promise',
      from: 'funded',
      to: 'settled',
      receipt: okReceipt(TX_A),
      priorEconomicTxHashes: [TX_A],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.idempotent).toBe(true);
    expect(decision.allowed === true && decision.txHash).toBe(TX_A);
  });

  it('a fresh tx hash against a non-empty ledger is NOT idempotent', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'promise',
      from: 'funded',
      to: 'settled',
      receipt: okReceipt(TX_B),
      priorEconomicTxHashes: [TX_A],
    });
    expect(decision.allowed === true && decision.idempotent).toBe(false);
    expect(decision.allowed === true && decision.txHash).toBe(TX_B);
  });

  it('dedup is case-insensitive on the tx hash', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: okReceipt(TX_MIXED),
      priorEconomicTxHashes: [TX_MIXED.toLowerCase()],
    });
    expect(decision.allowed === true && decision.idempotent).toBe(true);
    // txHash is normalized to lowercase for the caller's ledger.
    expect(decision.allowed === true && decision.txHash).toBe(TX_MIXED.toLowerCase());
  });

  it('an empty ledger yields a non-idempotent first economic transition', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'funded',
      to: 'completed',
      receipt: okReceipt(TX_A),
      priorEconomicTxHashes: [],
    });
    expect(decision.allowed === true && decision.idempotent).toBe(false);
  });
});

describe('institution-state-machine — full per-institution lifecycle walks', () => {
  it('escrow: draft → funded → completed (economic legs need receipts)', () => {
    expect(evaluateInstitutionTransition({ kind: 'escrow', from: INITIAL, to: 'created' }).allowed).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'escrow', from: 'created', to: 'funded', receipt: okReceipt(TX_A) })
        .allowed,
    ).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'escrow', from: 'funded', to: 'completed', receipt: okReceipt(TX_B) })
        .allowed,
    ).toBe(true);
  });

  it('escrow dispute path: funded → disputed (record) → resolved (economic)', () => {
    expect(evaluateInstitutionTransition({ kind: 'escrow', from: 'funded', to: 'disputed' }).economic ?? null).toBe(false);
    const resolved = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'disputed',
      to: 'resolved',
      receipt: okReceipt(TX_A),
    });
    expect(resolved.allowed === true && resolved.economic).toBe(true);
  });

  it('promise: open → funded → settled', () => {
    expect(evaluateInstitutionTransition({ kind: 'promise', from: INITIAL, to: 'open' }).allowed).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'promise', from: 'open', to: 'funded', receipt: okReceipt(TX_A) }).allowed,
    ).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'promise', from: 'funded', to: 'settled', receipt: okReceipt(TX_B) })
        .allowed,
    ).toBe(true);
  });

  it('pool: open → funded → executed', () => {
    expect(evaluateInstitutionTransition({ kind: 'pool', from: INITIAL, to: 'open' }).allowed).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'pool', from: 'open', to: 'funded', receipt: okReceipt(TX_A) }).allowed,
    ).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'pool', from: 'funded', to: 'executed', receipt: okReceipt(TX_B) }).allowed,
    ).toBe(true);
  });

  it('bond: INITIAL → active → withdrawn (both economic)', () => {
    const active = evaluateInstitutionTransition({ kind: 'bond', from: INITIAL, to: 'active', receipt: okReceipt(TX_A) });
    expect(active.allowed === true && active.economic).toBe(true);
    const withdrawn = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'active',
      to: 'withdrawn',
      receipt: okReceipt(TX_B),
    });
    expect(withdrawn.allowed === true && withdrawn.economic).toBe(true);
  });

  it('bond_claim: INITIAL → filed → upheld / dismissed (all economic)', () => {
    expect(
      evaluateInstitutionTransition({ kind: 'bond_claim', from: INITIAL, to: 'filed', receipt: okReceipt(TX_A) })
        .allowed,
    ).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'bond_claim', from: 'filed', to: 'upheld', receipt: okReceipt(TX_B) })
        .allowed,
    ).toBe(true);
    expect(
      evaluateInstitutionTransition({ kind: 'bond_claim', from: 'filed', to: 'dismissed', receipt: okReceipt(TX_B) })
        .allowed,
    ).toBe(true);
  });

  it('job: open → assigned → delivered are all record-only drafts (settlement is linked-job settlement escrow)', () => {
    for (const [from, to] of [
      [INITIAL, 'open'],
      ['open', 'assigned'],
      ['assigned', 'delivered'],
    ] as const) {
      const d = evaluateInstitutionTransition({ kind: 'job', from, to });
      expect(d.allowed).toBe(true);
      expect(d.allowed === true && d.economic).toBe(false);
    }
  });

  it('job settlement : assigned|delivered → completed|refunded are ECONOMIC (receipt required)', () => {
    for (const [from, to] of [
      ['assigned', 'completed'],
      ['delivered', 'completed'],
      ['assigned', 'refunded'],
      ['delivered', 'refunded'],
    ] as const) {
      // Without a receipt: fail closed.
      const blocked = evaluateInstitutionTransition({ kind: 'job', from, to });
      expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');
      // With a Base-final receipt: allowed, economic.
      const d = evaluateInstitutionTransition({ kind: 'job', from, to, receipt: okReceipt(TX_A) });
      expect(d.allowed === true && d.economic).toBe(true);
    }
  });

  it('job : a settled job cannot re-terminate — completed/refunded have no outgoing edges', () => {
    for (const from of ['completed', 'refunded'] as const) {
      for (const to of JOB_STATES) {
        const d = evaluateInstitutionTransition({ kind: 'job', from, to, receipt: okReceipt(TX_A) });
        expect(d.allowed).toBe(false);
      }
    }
  });

  it('human_job : open → in_progress → disputed are record-only; settlement legs are economic', () => {
    for (const [from, to] of [
      [INITIAL, 'open'],
      ['open', 'in_progress'],
      ['in_progress', 'disputed'],
    ] as const) {
      const d = evaluateInstitutionTransition({ kind: 'human_job', from, to });
      expect(d.allowed === true && d.economic).toBe(false);
    }
    for (const [from, to] of [
      ['in_progress', 'completed'],
      ['disputed', 'completed'],
      ['in_progress', 'refunded'],
      ['disputed', 'refunded'],
    ] as const) {
      const blocked = evaluateInstitutionTransition({ kind: 'human_job', from, to });
      expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');
      const d = evaluateInstitutionTransition({ kind: 'human_job', from, to, receipt: okReceipt(TX_B) });
      expect(d.allowed === true && d.economic).toBe(true);
    }
  });

  it('human_job : the poster-confirmation edge does NOT exist — in_progress→completed without a receipt blocks', () => {
    // 'completed' means PAID. There is no record-only path into it.
    const d = evaluateInstitutionTransition({ kind: 'human_job', from: 'in_progress', to: 'completed' });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('receipt_required');
  });

  it('human_job : cancelled has no declared edges yet — every path into it fails closed', () => {
    for (const from of [INITIAL, ...HUMAN_JOB_STATES] as const) {
      const d = evaluateInstitutionTransition({
        kind: 'human_job',
        from,
        to: 'cancelled',
        receipt: okReceipt(TX_A),
      });
      expect(d.allowed).toBe(false);
    }
  });
});

describe('institution-state-machine — bond lifecycle non-adjudicative bond lifecycle', () => {
  it('bond renew/top-up (active→active) is ECONOMIC: receipt required, idempotent by tx hash', () => {
    const blocked = evaluateInstitutionTransition({ kind: 'bond', from: 'active', to: 'active' });
    expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');

    const renewed = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'active',
      to: 'active',
      receipt: okReceipt(TX_A),
    });
    expect(renewed.allowed === true && renewed.economic).toBe(true);
    expect(renewed.allowed === true && renewed.idempotent).toBe(false);

    // A replayed renewal/top-up tx is an idempotent retry — no second PE.
    const replay = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'active',
      to: 'active',
      receipt: okReceipt(TX_A),
      priorEconomicTxHashes: [TX_A],
    });
    expect(replay.allowed === true && replay.idempotent).toBe(true);
  });

  it('bond expiry (active→expired) is RECORD-ONLY: an off-chain autonomy drop needs no receipt', () => {
    const d = evaluateInstitutionTransition({ kind: 'bond', from: 'active', to: 'expired' });
    expect(d.allowed).toBe(true);
    expect(d.allowed === true && d.economic).toBe(false);
  });

  it('late renewal (expired→active) and late withdrawal (expired→withdrawn) are ECONOMIC chain-truth edges', () => {
    for (const to of ['active', 'withdrawn'] as const) {
      const blocked = evaluateInstitutionTransition({ kind: 'bond', from: 'expired', to });
      expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');
      const d = evaluateInstitutionTransition({ kind: 'bond', from: 'expired', to, receipt: okReceipt(TX_B) });
      expect(d.allowed === true && d.economic).toBe(true);
    }
  });

  it('abandonment (expired→abandoned) is ECONOMIC and unreachable from active (expiry first)', () => {
    const blocked = evaluateInstitutionTransition({ kind: 'bond', from: 'expired', to: 'abandoned' });
    expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');
    const d = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'expired',
      to: 'abandoned',
      receipt: okReceipt(TX_A),
    });
    expect(d.allowed === true && d.economic).toBe(true);

    // Direct active→abandoned was never declared — the record must pass
    // through the expiry record first (Unknown = Block).
    const direct = evaluateInstitutionTransition({
      kind: 'bond',
      from: 'active',
      to: 'abandoned',
      receipt: okReceipt(TX_A),
    });
    expect(direct.allowed === false && direct.reason).toBe('illegal_transition');
  });

  it('bond terminal states (withdrawn/abandoned) have no outgoing edges', () => {
    for (const from of ['withdrawn', 'abandoned'] as const) {
      for (const to of BOND_STATES) {
        const d = evaluateInstitutionTransition({ kind: 'bond', from, to, receipt: okReceipt(TX_A) });
        expect(d.allowed).toBe(false);
      }
    }
  });

  it('an unverified receipt (finality pending) blocks every bond lifecycle economic bond edge', () => {
    for (const [from, to] of [
      ['active', 'active'],
      ['expired', 'active'],
      ['expired', 'withdrawn'],
      ['expired', 'abandoned'],
    ] as const) {
      const d = evaluateInstitutionTransition({ kind: 'bond', from, to, receipt: finalityPending(TX_A) });
      expect(d.allowed === false && d.reason).toBe('unverified_receipt');
    }
  });

  it('bond_claim expiry (filed→expired) is ECONOMIC; expired is terminal', () => {
    const blocked = evaluateInstitutionTransition({ kind: 'bond_claim', from: 'filed', to: 'expired' });
    expect(blocked.allowed === false && blocked.reason).toBe('receipt_required');
    const d = evaluateInstitutionTransition({
      kind: 'bond_claim',
      from: 'filed',
      to: 'expired',
      receipt: okReceipt(TX_A),
    });
    expect(d.allowed === true && d.economic).toBe(true);

    for (const to of BOND_CLAIM_STATES) {
      const out = evaluateInstitutionTransition({ kind: 'bond_claim', from: 'expired', to, receipt: okReceipt(TX_B) });
      expect(out.allowed).toBe(false);
    }
  });

  it('kill switch blocks the bond lifecycle bond edges FIRST (agent-initiated paths)', () => {
    for (const [from, to] of [
      [INITIAL, 'active'],
      ['active', 'active'],
      ['active', 'withdrawn'],
      ['expired', 'active'],
      ['expired', 'withdrawn'],
    ] as const) {
      const d = evaluateInstitutionTransition({
        kind: 'bond',
        from,
        to,
        receipt: okReceipt(TX_A),
        killSwitchActive: true,
      });
      expect(d.allowed === false && d.reason).toBe('kill_switch_active');
    }
  });
});

describe('institution-state-machine — agent directory Court process records', () => {
  it('court_dispute: panel assignment and deadline escalation are record-only drafts', () => {
    for (const [from, to] of [
      [INITIAL, 'pending'],
      ['pending', 'escalated'],
    ] as const) {
      const decision = evaluateInstitutionTransition({ kind: 'court_dispute', from, to });
      expect(decision.allowed).toBe(true);
      expect(decision.allowed === true && decision.economic).toBe(false);
    }
  });

  it('court_dispute: recording a VERDICT (pending→resolved) is ECONOMIC — receipt required', () => {
    const noReceipt = evaluateInstitutionTransition({
      kind: 'court_dispute',
      from: 'pending',
      to: 'resolved',
    });
    expect(noReceipt.allowed).toBe(false);
    expect(noReceipt.allowed === false && noReceipt.reason).toBe('receipt_required');

    const withReceipt = evaluateInstitutionTransition({
      kind: 'court_dispute',
      from: 'pending',
      to: 'resolved',
      receipt: { ok: true, txHash: TX_A },
    });
    expect(withReceipt).toEqual({ allowed: true, economic: true, idempotent: false, txHash: TX_A });
  });

  it('court_dispute: a replay of the recorded resolution tx is flagged idempotent (no second verdict PE)', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'court_dispute',
      from: 'pending',
      to: 'resolved',
      receipt: { ok: true, txHash: TX_A.toUpperCase().replace('0X', '0x') },
      priorEconomicTxHashes: [TX_A],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.idempotent).toBe(true);
  });

  it('court_dispute: escalated→resolved has NO writer — it fails closed (Unknown = Block)', () => {
    const decision = evaluateInstitutionTransition({
      kind: 'court_dispute',
      from: 'escalated',
      to: 'resolved',
      receipt: { ok: true, txHash: TX_A },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
  });

  it('general_dispute: the full declared lifecycle is record-only (money legs ride their own kinds)', () => {
    for (const [from, to] of [
      [INITIAL, 'filed'],
      ['filed', 'evidence_period'],
      ['evidence_period', 'voting'],
      ['voting', 'resolved'],
      ['filed', 'escalated'],
      ['voting', 'escalated'],
    ] as const) {
      const decision = evaluateInstitutionTransition({ kind: 'general_dispute', from, to });
      expect(decision.allowed).toBe(true);
      expect(decision.allowed === true && decision.economic).toBe(false);
    }
  });

  it('general_dispute: panel_assigned is a declared state with NO writer — every edge into it blocks', () => {
    for (const from of [INITIAL, 'filed', 'evidence_period', 'voting', 'resolved', 'escalated']) {
      const decision = evaluateInstitutionTransition({ kind: 'general_dispute', from, to: 'panel_assigned' });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
    }
  });

  it('general_dispute: skipping the evidence window (filed→voting / filed→resolved) fails closed', () => {
    for (const to of ['voting', 'resolved']) {
      const decision = evaluateInstitutionTransition({ kind: 'general_dispute', from: 'filed', to });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('illegal_transition');
    }
  });

  it('kill switch blocks the Court edges FIRST (agent-initiated paths)', () => {
    for (const [kind, from, to] of [
      ['court_dispute', 'pending', 'resolved'],
      ['general_dispute', INITIAL, 'filed'],
      ['general_dispute', 'voting', 'resolved'],
    ] as const) {
      const decision = evaluateInstitutionTransition({
        kind: kind as InstitutionKind,
        from,
        to,
        receipt: { ok: true, txHash: TX_A },
        killSwitchActive: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('kill_switch_active');
    }
  });
});

describe('institution-state-machine — classify/find helpers and structural integrity', () => {
  it('classifyTransition returns the class or null', () => {
    expect(classifyTransition('escrow', 'created', 'funded')).toBe('economic');
    expect(classifyTransition('escrow', INITIAL, 'created')).toBe('record_only');
    expect(classifyTransition('escrow', 'created', 'completed')).toBeNull();
    expect(classifyTransition('nope' as InstitutionKind, 'a', 'b')).toBeNull();
  });

  it('findTransition returns the edge with its note or null', () => {
    const t = findTransition('bond', INITIAL, 'active');
    expect(t?.class).toBe('economic');
    expect(typeof t?.note).toBe('string');
    // bond lifecycle declared active→expired (record_only autonomy drop); a terminal
    // exit like abandoned→active stays undeclared.
    expect(findTransition('bond', 'active', 'expired')?.class).toBe('record_only');
    expect(findTransition('bond', 'abandoned', 'active')).toBeNull();
  });

  it('every declared transition references a declared state (or INITIAL) on both ends', () => {
    const stateSets: Record<InstitutionKind, readonly string[]> = {
      escrow: ESCROW_STATES,
      promise: PROMISE_STATES,
      pool: POOL_STATES,
      bond: BOND_STATES,
      bond_claim: BOND_CLAIM_STATES,
      job: JOB_STATES,
      human_job: HUMAN_JOB_STATES,
      court_dispute: COURT_DISPUTE_STATES,
      general_dispute: GENERAL_DISPUTE_STATES,
    };
    for (const kind of INSTITUTION_KINDS) {
      const states = stateSets[kind];
      // Reconstruct every declared edge by probing every state pair + INITIAL.
      const sources = [INITIAL, ...states];
      let declaredCount = 0;
      for (const from of sources) {
        for (const to of states) {
          const t = findTransition(kind, from, to);
          if (!t) continue;
          declaredCount += 1;
          expect(t.from === INITIAL || states.includes(t.from)).toBe(true);
          expect(states.includes(t.to)).toBe(true);
          expect(['economic', 'record_only']).toContain(t.class);
        }
      }
      expect(declaredCount).toBeGreaterThan(0);
    }
  });

  it('INITIAL is never a member of any state set', () => {
    for (const states of [
      ESCROW_STATES,
      PROMISE_STATES,
      POOL_STATES,
      BOND_STATES,
      BOND_CLAIM_STATES,
      JOB_STATES,
      HUMAN_JOB_STATES,
      COURT_DISPUTE_STATES,
      GENERAL_DISPUTE_STATES,
    ]) {
      expect((states as readonly string[]).includes(INITIAL)).toBe(false);
    }
  });
});

describe('institution-state-machine — receiptFromVerification adapter', () => {
  it('carries ok/reason/confirmations through and attaches the tx hash', () => {
    const ev = receiptFromVerification({ ok: false, reason: 'tx_failed', confirmations: 0 }, TX_A);
    expect(ev).toEqual({ ok: false, reason: 'tx_failed', confirmations: 0, txHash: TX_A });
  });

  it('an adapted ok verification drives an economic transition', () => {
    const ev = receiptFromVerification({ ok: true, confirmations: 30 }, TX_A);
    const decision = evaluateInstitutionTransition({
      kind: 'escrow',
      from: 'created',
      to: 'funded',
      receipt: ev,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.txHash).toBe(TX_A);
  });
});
