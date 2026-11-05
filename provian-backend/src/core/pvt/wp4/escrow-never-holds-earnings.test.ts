/**
 * RECOVERY ESCROW NEVER HOLDS EARNINGS.
 *
 * Recovery escrow is how a linked human can restore an agent's key. It never holds what the agent
 * earned: the escrow gate is removed from every settlement and payout path, for every agent,
 * linked or not. This suite proves the rule four ways, each with an in-suite RED control:
 *
 * 1. an un-escrowed UNLINKED agent's pending meter claim registers through `runMeterClaimInlet`
 * (the `runClaimInlet` / pe_history side is proven through the real source in
 * `frozen-split.test.ts` "an UNLINKED, un-escrowed agent");
 * 2. a LINKED un-escrowed agent's legs — the agent's AND the human's — both register (meter
 * here; the inlet side in `frozen-split.test.ts` "a LINKED, un-escrowed agent");
 * 3. `precheckPayout` answers `ok` for an un-escrowed agent with ready earnings;
 * 4. a permanent STATIC guard: no settlement/payout module, nor any module they import under
 * core/pvt/wp4, core/meter or core/payout, reads the recovery-escrow collection.
 *
 * Every dynamic case runs against a store that THROWS on any read of `agent_recovery_escrows`, so a
 * pass also proves the path never looked.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../../agent-recovery-escrow';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../native-wallet-registration';
import { buildPendingClaim, meterActClaimId, meterActClaimKey } from '../../meter/meter-claims';
import { runMeterClaimInlet } from '../../meter/meter-settlement';
import { METER_PENDING_CLAIMS_COLLECTION, type MeterPendingClaim } from '../../meter/meter-store';
import { precheckPayout, type PayoutDeps } from '../../payout/on-demand-payout';
import type { PayoutChain } from '../../payout/payout-chain';
import type { SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import type { PayoutLegRole } from '../wp-ev/payout-legs';
import { CLAIM_LEDGER_COLLECTION } from './durable-settlement-store';

const AGENT = '0x00000000000000000000000000000000000000a2';
const HUMAN = '0x00000000000000000000000000000000000000a1';
const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// The store: real fake Firestore, with the escrow collection booby-trapped
// ---------------------------------------------------------------------------

class EscrowReadError extends Error {}

/** A store that refuses any read of the recovery-escrow collection, so a pass proves it was never read. */
function escrowTrapped(fake: FakeFirestore): FakeFirestore {
  return new Proxy(fake, {
    get(target, prop, receiver) {
      if (prop === 'collection') {
        return (name: string) => {
          if (name === AGENT_RECOVERY_ESCROW_COLLECTION) {
            throw new EscrowReadError(`settlement/payout path read ${AGENT_RECOVERY_ESCROW_COLLECTION}`);
          }
          return target.collection(name);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Exactly the state the retired gate deferred on: the address is an agent wallet with no escrow. */
async function seedUnescrowedAgent(fake: FakeFirestore, address: string, walletId: string): Promise<void> {
  await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address))
    .set({ owner_type: 'agent', wallet_id: walletId });
  // Read back on the UNtrapped store: the state is really set (no vacuous "no escrow").
  expect((await fake.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(address)).get())
    .data()).toMatchObject({ owner_type: 'agent', wallet_id: walletId });
  expect((await fake.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(walletId).get()).exists).toBe(false);
}

function identity(peId: string): SealedEnvelopeIdentity {
  return {
    id: peId, prev_hash: 'a'.repeat(64), hash: 'b'.repeat(64),
    timestamp: NOW - 86_400_000, action_type: 'compute_session', user_id: 'agent-1',
  };
}

function actClaim(peId: string, leg: PayoutLegRole, contributor: string, beneficiaryClass: number, points: string, readyAtMs = 0): MeterPendingClaim {
  return buildPendingClaim({
    claim_key: meterActClaimKey(peId, leg),
    unit: 'act',
    batch_hash: 'c'.repeat(64),
    device_id: 'relay:agent-1',
    actor_id: 'agent-1',
    leg,
    contributor,
    beneficiary_class: beneficiaryClass,
    record_points_atomic: points,
    acts: [{ relay_pe_id: peId, points_atomic: points }],
    claim_id: meterActClaimId(identity(peId), leg),
    act_identity: identity(peId),
    created_at_ms: 1,
    ready_at_ms: readyAtMs,
  });
}

async function seedClaim(fake: FakeFirestore, claim: MeterPendingClaim): Promise<void> {
  await fake.collection(METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key).set({ ...claim });
}

/** Every pending meter claim still `pending` (held), by key. */
function heldClaims(fake: FakeFirestore): string[] {
  return [...fake.store.entries()]
    .filter(([key, row]) => key.startsWith(`${METER_PENDING_CLAIMS_COLLECTION}/`) && row.state === 'pending')
    .map(([key]) => key.slice(METER_PENDING_CLAIMS_COLLECTION.length + 1))
    .sort();
}

/** Standard-lane ledger rows by contributor, with their points. */
function ledgerByContributor(fake: FakeFirestore): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [key, row] of fake.store.entries()) {
    if (!key.startsWith(`${CLAIM_LEDGER_COLLECTION}/`) || row.lane !== 'standard') continue;
    const who = String(row.contributor);
    out.set(who, (out.get(who) ?? 0n) + BigInt(row.record_points_atomic as string));
  }
  return out;
}

describe('escrow never holds earnings — the trap itself (RED controls)', () => {
  it('RED: the trapped store really throws on a recovery-escrow read', () => {
    const trapped = escrowTrapped(createFakeFirestore());
    expect(() => trapped.collection(AGENT_RECOVERY_ESCROW_COLLECTION)).toThrow(EscrowReadError);
    expect(() => trapped.collection(METER_PENDING_CLAIMS_COLLECTION)).not.toThrow();
  });

  it('RED: the "held" measure sees a claim the meter inlet leaves pending (not ready yet)', async () => {
    const fake = createFakeFirestore();
    const claim = actClaim('pe_wait', 'sole', AGENT, 2, '1000', NOW + 86_400_000);
    await seedClaim(fake, claim);
    const report = await runMeterClaimInlet(escrowTrapped(fake) as never, { nowMs: NOW });
    expect(report.notReady).toBe(1);
    expect(heldClaims(fake)).toEqual([claim.claim_key]);
    expect(ledgerByContributor(fake).size).toBe(0);
  });
});

describe('escrow never holds earnings — the meter inlet', () => {
  it('(1) an un-escrowed UNLINKED agent: its sole claim registers', async () => {
    const fake = createFakeFirestore();
    await seedUnescrowedAgent(fake, AGENT, 'wallet_aw_solo');
    const claim = actClaim('pe_solo', 'sole', AGENT, 2, '1000');
    await seedClaim(fake, claim);

    const report = await runMeterClaimInlet(escrowTrapped(fake) as never, { nowMs: NOW });
    expect(report.scanned).toBe(1); // a population of one, not zero
    // RED with the gate re-inserted: registered 0, the claim left `pending`.
    expect(report.registered).toBe(1);
    expect(report.rejected).toEqual([]);
    expect(heldClaims(fake)).toEqual([]);
    expect(ledgerByContributor(fake).get(AGENT)).toBe(1000n);
    expect(report).not.toHaveProperty('deferredEscrow');
  });

  it('(2) a LINKED un-escrowed agent: the agent leg AND the human leg both register', async () => {
    const fake = createFakeFirestore();
    await seedUnescrowedAgent(fake, AGENT, 'wallet_aw_agent-1');
    await seedClaim(fake, actClaim('pe_link', 'agent', AGENT, 2, '200'));
    await seedClaim(fake, actClaim('pe_link', 'beneficiary', HUMAN, 1, '800'));

    const report = await runMeterClaimInlet(escrowTrapped(fake) as never, { nowMs: NOW });
    expect(report.scanned).toBe(2);
    // RED with the gate re-inserted: registered 1 — the agent's 20% left pending.
    expect(report.registered).toBe(2);
    expect(heldClaims(fake)).toEqual([]);
    const ledger = ledgerByContributor(fake);
    expect(ledger.get(AGENT)).toBe(200n);
    expect(ledger.get(HUMAN)).toBe(800n);
  });

  it('a payee-scoped (on-demand payout) inlet registers an un-escrowed agent\'s own claim', async () => {
    const fake = createFakeFirestore();
    await seedUnescrowedAgent(fake, AGENT, 'wallet_aw_solo');
    await seedClaim(fake, actClaim('pe_mine', 'sole', AGENT, 2, '700'));
    await seedClaim(fake, actClaim('pe_theirs', 'sole', HUMAN, 1, '900'));
    const report = await runMeterClaimInlet(escrowTrapped(fake) as never, { nowMs: NOW, contributor: AGENT });
    expect(report.registered).toBe(1);
    expect(ledgerByContributor(fake).get(AGENT)).toBe(700n);
    expect(heldClaims(fake)).toEqual([meterActClaimKey('pe_theirs', 'sole')]); // the other payee's waits for the weekly run
  });
});

// ---------------------------------------------------------------------------
// (3) The on-demand payout precheck
// ---------------------------------------------------------------------------

function fakeChain(gasPriceWei: bigint): PayoutChain {
  return {
    gasAddress: '0x' + '35'.repeat(20),
    authorizationUsed: async () => false,
    usdcBalance: async () => 5_000_000n,
    gasBalanceWei: async () => 10n ** 17n,
    gasPriceWei: async () => gasPriceWei,
    l1FeeUpperBoundWei: async () => 1_000_000_000n,
    submitCharge: async () => { throw new Error('precheck must not charge'); },
    confirmCharge: async () => 'pending',
    headBlock: async () => 1,
    findCharge: async () => ({ txHash: null, windowClosed: false }),
  };
}

function payoutDeps(fake: FakeFirestore, gasPriceWei = 6_000_000n): PayoutDeps {
  return {
    db: escrowTrapped(fake) as never,
    chain: fakeChain(gasPriceWei),
    ethUsd: async () => 4000,
    settle: async () => { throw new Error('precheck must not settle'); },
    withGasKeyLease: async (fn) => fn(),
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
  };
}

describe('escrow never holds earnings — the on-demand payout precheck', () => {
  it('(3) an un-escrowed agent with ready earnings → ok (never recovery_escrow_required)', async () => {
    const fake = createFakeFirestore();
    await seedUnescrowedAgent(fake, AGENT, 'wallet_aw_solo');
    await seedClaim(fake, actClaim('pe_pay', 'sole', AGENT, 2, '800000000000000000'));
    const pre = await precheckPayout(payoutDeps(fake), AGENT);
    // RED with the gate re-inserted: { kind: 'recovery_escrow_required' }.
    expect(pre.kind).toBe('ok');
    if (pre.kind !== 'ok') return;
    expect(pre.work.pointsAtomic).toBe(800000000000000000n);
    expect(pre.work.claims).toBe(1);
  });

  it('RED: the same precheck is not hard-wired ok — no work → nothing_to_pay; gas above the fee → waits_for_gas', async () => {
    const empty = createFakeFirestore();
    await seedUnescrowedAgent(empty, AGENT, 'wallet_aw_solo');
    expect((await precheckPayout(payoutDeps(empty), AGENT)).kind).toBe('nothing_to_pay');

    const pricey = createFakeFirestore();
    await seedUnescrowedAgent(pricey, AGENT, 'wallet_aw_solo');
    await seedClaim(pricey, actClaim('pe_pay', 'sole', AGENT, 2, '800000000000000000'));
    expect((await precheckPayout(payoutDeps(pricey, 50_000_000_000n), AGENT)).kind).toBe('waits_for_gas');
  });
});

// ---------------------------------------------------------------------------
// (4) The permanent static guard
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, '../../..');
/** The settlement and payout entry modules. */
const ESCROW_FREE_ENTRY_MODULES: readonly string[] = [
  'core/pvt/wp4/operator-runtime.ts',
  'core/pvt/wp4/claim-inlet.ts',
  'core/meter/meter-settlement.ts',
  'core/pvt/wp4/leg-sum-audit.ts',
  'core/payout/on-demand-payout.ts',
  'core/payout/payout-runtime.ts',
  'routes/payout.ts',
];
/** Where the closure is followed: every module an entry imports under these directories is checked too. */
const FOLLOWED_DIRS: readonly string[] = ['core/pvt/wp4/', 'core/meter/', 'core/payout/'];

/** What a module that reads (or wires a read of) the recovery-escrow collection contains. */
const ESCROW_READ = /AGENT_RECOVERY_ESCROW_COLLECTION|['"`]agent_recovery_escrows['"`]|['"][./]*[^'"]*agent-recovery-escrow(?:-gate)?['"]/;

/** The offending lines of one source text (empty = clean). Comments are stripped first. */
function escrowReadsIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return code.split('\n').filter((line) => ESCROW_READ.test(line)).map((line) => line.trim());
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

function resolveImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The entry modules plus every module they reach (transitively) under the followed directories. */
function escrowGuardClosure(): string[] {
  const seen = new Set<string>();
  const queue = ESCROW_FREE_ENTRY_MODULES.map((rel) => path.join(SRC, rel));
  for (const entry of queue) if (!fs.existsSync(entry)) throw new Error(`entry module missing: ${entry}`);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved === null || resolved.endsWith('.test.ts')) continue;
      const rel = path.relative(SRC, resolved).split(path.sep).join('/');
      if (FOLLOWED_DIRS.some((dir) => rel.startsWith(dir))) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

describe('escrow never holds earnings — (4) permanent static guard', () => {
  it('RED: the checker catches a planted escrow read in every form it guards', () => {
    expect(escrowReadsIn(`const s = await db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(w).get();`)).toHaveLength(1);
    expect(escrowReadsIn(`const s = await db.collection('agent_recovery_escrows').doc(w).get();`)).toHaveLength(1);
    expect(escrowReadsIn(`const s = await db.collection("agent_recovery_escrows").doc(w).get();`)).toHaveLength(1);
    expect(escrowReadsIn(`import { createAgentEscrowGate } from './agent-recovery-escrow-gate';`)).toHaveLength(1);
    expect(escrowReadsIn(`import { readAgentEscrow } from '../../agent-recovery-escrow';`)).toHaveLength(1);
    // …and leaves prose about escrow alone.
    expect(escrowReadsIn(`// recovery escrow never holds earnings (agent_recovery_escrows)\nconst x = 1;`)).toEqual([]);
    expect(escrowReadsIn(`/* AGENT_RECOVERY_ESCROW_COLLECTION */ const y = 2;`)).toEqual([]);
  });

  it('RED: the closure walker follows imports (a known transitive module is reached)', () => {
    const closure = escrowGuardClosure().map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    // operator-runtime → claim-inlet-source and meter-settlement → meter-claims are real edges.
    expect(closure).toContain('core/pvt/wp4/claim-inlet-source.ts');
    expect(closure).toContain('core/meter/meter-claims.ts');
  });

  it('no settlement/payout module, nor any module it imports under core/pvt/wp4, core/meter or core/payout, reads the recovery-escrow collection', () => {
    const closure = escrowGuardClosure();
    // eslint-disable-next-line no-console
    console.log(`[escrow-never-holds-earnings] evaluated ${closure.length} module(s)`);
    // A pass over zero files is not a pass.
    expect(closure.length).toBeGreaterThanOrEqual(ESCROW_FREE_ENTRY_MODULES.length);
    const offending = closure
      .map((file) => ({ file: path.relative(SRC, file), lines: escrowReadsIn(fs.readFileSync(file, 'utf8')) }))
      .filter((hit) => hit.lines.length > 0);
    expect(offending).toEqual([]);
  });

  it('the gate module is gone', () => {
    expect(fs.existsSync(path.join(SRC, 'core/pvt/wp4/agent-recovery-escrow-gate.ts'))).toBe(false);
  });
});
