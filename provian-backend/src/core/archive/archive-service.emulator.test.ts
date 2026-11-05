/**
 * — the paid PE Archive against the Firestore EMULATOR, with a fake chain, an
 * in-memory object store and a fake PEAnchor (the real ones are proven live). Skipped unless
 * FIRESTORE_EMULATOR_HOST is set (see meter-single-lane.emulator.test.ts for the emulator command).
 *
 * Proves: turn-on buys the first GB ($5, charged once, credited once, a retry lands on the same
 * payment); the next GB is refused while most of the GB is unused (nothing charged); an upload
 * that would pass the paid space is refused 402 and writes NOTHING; a stored day is confirmed only
 * once its objects match the index AND every batch is anchored; a tampered object or a batch the
 * meter records differently is never confirmed; an old batch is proven on chain.
 *
 * And (2026-10-07) the storage layout never replaces an Archive-class object early: every part is
 * its own object written once; a second part adds an object and leaves the first untouched;
 * confirmation and the stale-upload sweep read metadata only (zero data reads); a day waiting for
 * its anchor never reads the bucket; a pre-2026-10-07 day (one object per day) is still served and
 * confirmed, and a later part on it gets its own object without rewriting the old one.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { Wallet } from 'ethers';
import type { UsdcChargeChain, UsdcChargePayment } from '../payments/usdc-charge';
import type { UsdcChargeRuntimeDeps } from '../payments/usdc-charge-runtime';
import { signedPaymentHeader } from '../payout/payout-test-fixtures';
import { createMemoryArchiveObjectStore } from './archive-objects';
import {
  advanceArchivePayment,
  archivePartObjectPath,
  confirmArchiveDay,
  listArchivePayments,
  openArchiveDayStream,
  readArchiveAccount,
  readArchiveDay,
  requestArchiveGb,
  setArchiveOn,
  storeArchivePart,
  sweepArchive,
  type ArchiveDeps,
  type ArchiveOwner,
  type ArchiveSettlement,
} from './archive-service';
import type { CdpFacilitator, CdpSettlementListing } from '../payments/cdp-facilitator';
import { usdcChargeRequirement, type UsdcPaymentRequirement } from '../payments/usdc-charge';
import { ARCHIVE_GB_BYTES, ARCHIVE_MIN_CHARGED_PART_BYTES, ARCHIVE_PAYMENTS_COLLECTION, ARCHIVE_SERVICE_TERMS, archiveAgentListing } from './archive-terms';
import { archiveDayId, archiveObjectPath, buildArchiveEntries, bytesToB64u, sealArchivePart, type ArchiveBatchInput } from '../meter/pe-archive-wire';
import type { Readable } from 'stream';
import { archiveContentKeyPair } from '../meter/pe-archive-crypto';
import { actRecordOf, actsRootOf, batchLeafOf, METER_GENESIS_PREV_HASH, peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter/meter-wire';
import { METER_BATCHES_COLLECTION } from '../meter/meter-store';
import { meterAnchorBatchId } from '../meter/meter-anchor';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;
const RUN = `a${Date.now().toString(36)}`;
const LISTING = archiveAgentListing('https://api.provian.ai/v1/archive/pay');
const DAY = '2026-10-03';

let db: FirebaseFirestore.Firestore;
/** One object store for the tests that build on each other's stored days. */
let shared: { deps: ArchiveDeps; objects: ReturnType<typeof createMemoryArchiveObjectStore> };

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

function fakeChain() {
  const submitted: UsdcChargePayment[] = [];
  const used = new Set<string>();
  const landed = new Map<string, string>();
  const chain: UsdcChargeChain = {
    gasAddress: '0x' + '35'.repeat(20),
    authorizationUsed: async (from, nonce) => used.has(`${from}|${nonce}`),
    usdcBalance: async () => 50_000_000n,
    gasBalanceWei: async () => 10n ** 17n,
    gasPriceWei: async () => 6_000_000n,
    l1FeeUpperBoundWei: async () => 1_000_000_000n,
    submitCharge: async (payment) => {
      submitted.push(payment);
      used.add(`${payment.authorization.from}|${payment.authorization.nonce}`);
      const hash = `0x${String(submitted.length).padStart(64, '0')}`;
      landed.set(`${payment.authorization.from}|${payment.authorization.nonce}`, hash);
      return hash;
    },
    confirmCharge: async () => 'confirmed',
    headBlock: async () => 1000,
    findCharge: async (p) => ({ txHash: landed.get(`${p.authorization.from}|${p.authorization.nonce}`) ?? null, windowClosed: false }),
  };
  return { chain, submitted };
}

const GAS_KEY: ArchiveSettlement = { mode: () => 'relay_gas_key', cdp: null };

function makeDeps(chain: UsdcChargeChain, anchorOk: (leaf: string) => boolean = () => false, settlement: ArchiveSettlement = GAS_KEY) {
  let clock = Date.now();
  const charge: UsdcChargeRuntimeDeps = {
    chain,
    ethUsd: async () => 4000,
    withGasKeyLease: async (fn) => fn(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  const objects = createMemoryArchiveObjectStore();
  const deps: ArchiveDeps = {
    db,
    objects,
    anchor: { verifyPE: async (_batchId, leaf) => anchorOk(leaf) },
    charge,
    settlement,
    now: () => clock,
  };
  return { deps, objects };
}

const OWNER_SECRET = new Uint8Array(32).fill(0x61);
const pubOf = (secret: Uint8Array): string => bytesToB64u(archiveContentKeyPair(() => secret).publicKey);

function batchFor(owner: ArchiveOwner, deviceId: string, seq: number, firstIndex: number, prevHash: string, count: number): ArchiveBatchInput & { last: string } {
  const pes: (PeV2 & { pe_hash: string })[] = [];
  let prev = prevHash;
  for (let i = 0; i < count; i++) {
    const body: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_${RUN}_${deviceId}_${seq}_${i}`, device_id: deviceId, prev_hash: prev,
      timestamp: 1_790_000_000_000 + seq * 100 + i, action_type: 'coding_session', attestation_depth: 'software',
    };
    const pe = { ...body, pe_hash: peHashOf(body) };
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = peHashOf({ schema: 'x', pe_id: `b_${RUN}_${deviceId}_${seq}`, device_id: deviceId, prev_hash: 'genesis', timestamp: 1, action_type: 'b' });
  return {
    device_id: deviceId, actor_id: owner.actorId, seq, batch_hash: batchHash, acts_root: actsRoot,
    batch_leaf: batchLeafOf({ device_id: deviceId, actor_id: owner.actorId, seq, batch_hash: batchHash, acts_root: actsRoot }),
    first_index: firstIndex, pes,
    anchor: { day: DAY, anchor_batch_id: meterAnchorBatchId(DAY), leaf_index: 0, proof: [], merkle_root: hashEnvelopeHashLeaf(batchLeafOf({ device_id: deviceId, actor_id: owner.actorId, seq, batch_hash: batchHash, acts_root: actsRoot })), tx_hash: null },
    last: prev,
  };
}

function partOf(owner: ArchiveOwner, deviceId: string, batches: ArchiveBatchInput[], partNo = 0) {
  const { entries, refs } = buildArchiveEntries(DAY, batches);
  return sealArchivePart({
    wallet: owner.wallet, day: DAY, device_id: deviceId, part: partNo, entries, refs,
    recipients: [{ party_id: owner.wallet, pubkey_b64u: pubOf(OWNER_SECRET) }],
  });
}

async function seedBatchRecord(b: ArchiveBatchInput, anchored: boolean, overrides: Record<string, unknown> = {}): Promise<void> {
  await db.collection(METER_BATCHES_COLLECTION).doc(b.batch_hash).set({
    device_id: b.device_id, actor_id: b.actor_id, seq: b.seq, acts_root: b.acts_root, batch_leaf: b.batch_leaf,
    day: DAY, anchored, ...(anchored ? { anchor: b.anchor } : {}), ...overrides,
  });
}

suite('paid PE Archive (emulator)', () => {
  const payer = Wallet.createRandom();
  const owner: ArchiveOwner = { wallet: `wallet_aw_${RUN}`, kind: 'agent', actorId: `agent_${RUN}`, linkedHumanWallet: null };
  const other: ArchiveOwner = { wallet: `wallet_aw_${RUN}_o`, kind: 'agent', actorId: `agent_${RUN}_o`, linkedHumanWallet: null };

  beforeAll(async () => {
    const admin = await import('firebase-admin');
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
    shared = makeDeps(fakeChain().chain);
  });

  it('RED: an upload before the Archive is on is refused and writes nothing', async () => {
    const { chain } = fakeChain();
    const { deps, objects } = makeDeps(chain);
    const b = batchFor(owner, 'dev_a', 1, 0, METER_GENESIS_PREV_HASH, 3);
    const out = await storeArchivePart(deps, { owner, deviceId: 'dev_a', bytes: partOf(owner, 'dev_a', [b]).bytes });
    expect(out).toMatchObject({ kind: 'refused', http: 402, error: 'archive_not_on' });
    expect(objects.objects.size).toBe(0);
    expect(await readArchiveDay(db, owner.wallet, DAY)).toBeNull();
  });

  it('turn-on: no header → the $5 quote; paid → charged once, 1 GB credited once, Archive on', async () => {
    const { chain, submitted } = fakeChain();
    const { deps } = makeDeps(chain);
    expect((await requestArchiveGb(deps, { owner, requestedBy: owner.wallet, paymentHeader: undefined, listing: LISTING })).kind).toBe('payment_required');
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    const out = await requestArchiveGb(deps, { owner, requestedBy: owner.wallet, paymentHeader: header, listing: LISTING });
    expect(out.kind).toBe('payment');
    if (out.kind !== 'payment') return;
    expect(out.payment.credited).toBe(true);
    expect(submitted).toHaveLength(1);
    let account = await readArchiveAccount(db, owner.wallet);
    expect(account).toMatchObject({ on: true, paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1 });

    // The same paid header again: the same payment, never a second charge or a second GB.
    const again = await requestArchiveGb(deps, { owner, requestedBy: owner.wallet, paymentHeader: header, listing: LISTING });
    expect(again.kind).toBe('payment');
    expect(submitted).toHaveLength(1);
    account = await readArchiveAccount(db, owner.wallet);
    expect(account?.paid_bytes).toBe(ARCHIVE_GB_BYTES);
    // Someone else replaying it for their own archive is refused.
    expect((await requestArchiveGb(deps, { owner: other, requestedBy: other.wallet, paymentHeader: header, listing: LISTING })).kind).toBe('not_your_request');
  });

  describe('from the launch flip, Coinbase CDP settles new charges ', () => {
    type SettleCall = { payment: UsdcChargePayment; requirement: UsdcPaymentRequirement; listing: CdpSettlementListing };
    function cdpSpy(reply: (p: UsdcChargePayment) => Promise<string>) {
      const calls: SettleCall[] = [];
      const cdp: CdpFacilitator = {
        settle: async (payment, requirement, listing) => { calls.push({ payment, requirement, listing }); return reply(payment); },
      };
      return { cdp, calls };
    }
    const viaCdp = (cdp: CdpFacilitator | null): ArchiveSettlement => ({ mode: () => 'cdp_facilitator', cdp });
    const fresh = (n: string): ArchiveOwner => ({ wallet: `wallet_aw_${RUN}_c${n}`, kind: 'agent', actorId: `agent_${RUN}_c${n}`, linkedHumanWallet: null });

    it("CDP settles with the relay's requirement and the agent listing; the gas key submits nothing; the chain confirms; one GB once", async () => {
      const { chain, submitted } = fakeChain();
      // A gas price no $5 fee could cover: CDP pays the gas, so the relay does not wait for it.
      const pricey: UsdcChargeChain = { ...chain, gasPriceWei: async () => 10n ** 15n };
      const tx = '0x' + 'c1'.repeat(32);
      const { cdp, calls } = cdpSpy(async () => tx);
      const o = fresh('1');
      const { deps } = makeDeps(pricey, () => false, viaCdp(cdp));
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      const out = await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING });
      if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
      expect(out.payment).toMatchObject({ state: 'charged', credited: true, charge_tx_hash: tx, settled_via: 'cdp_facilitator' });
      expect(submitted).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].requirement).toEqual(usdcChargeRequirement(ARCHIVE_SERVICE_TERMS));
      expect(calls[0].listing).toEqual(LISTING);
      expect(await readArchiveAccount(db, o.wallet)).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
      // A retry of the same paid header never reaches CDP again.
      await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING });
      expect(calls).toHaveLength(1);
    });

    it('RED: from the flip, a missing CDP key answers not_configured and writes nothing (never the gas key)', async () => {
      const { chain, submitted } = fakeChain();
      const o = fresh('2');
      const { deps } = makeDeps(chain, () => false, viaCdp(null));
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      expect((await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING })).kind).toBe('not_configured');
      expect(submitted).toHaveLength(0);
      expect((await listArchivePayments(db, o.wallet)).length).toBe(0);
    });

    it('RED: a CDP refusal is UNCONFIRMED (never "not charged" on its word); failed only once the chain window closes', async () => {
      let closed = false;
      const chain: UsdcChargeChain = { ...fakeChain().chain, findCharge: async () => ({ txHash: null, windowClosed: closed }) };
      const { cdp } = cdpSpy(async () => { throw new Error('cdp_settle_refused:invalid_payload'); });
      const o = fresh('3');
      const { deps } = makeDeps(chain, () => false, viaCdp(cdp));
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      const out = await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING });
      if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
      expect(out.payment).toMatchObject({ state: 'charge_unconfirmed', credited: false, last_error: 'cdp_settle_refused:invalid_payload' });
      expect((await advanceArchivePayment(deps, out.payment.request_id)).state).toBe('charge_unconfirmed');
      closed = true;
      expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charge_failed', credited: false });
      expect(await readArchiveAccount(db, o.wallet)).toBeNull();
    });

    it("RED: CDP reports success but the receipt does not move the fee — never credited", async () => {
      let closed = false;
      const chain: UsdcChargeChain = {
        ...fakeChain().chain,
        confirmCharge: async () => 'reverted',
        findCharge: async () => ({ txHash: null, windowClosed: closed }),
      };
      const { cdp } = cdpSpy(async () => '0x' + 'c4'.repeat(32));
      const o = fresh('4');
      const { deps } = makeDeps(chain, () => false, viaCdp(cdp));
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      const out = await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING });
      if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
      expect(out.payment.credited).toBe(false);
      closed = true;
      expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charge_failed', credited: false });
      expect(await readArchiveAccount(db, o.wallet)).toBeNull();
    });

    it('before the flip the gas key submits, as it always did, and CDP is never called', async () => {
      const { chain, submitted } = fakeChain();
      const { cdp, calls } = cdpSpy(async () => '0x' + 'c5'.repeat(32));
      const o = fresh('5');
      const { deps } = makeDeps(chain, () => false, { mode: () => 'relay_gas_key', cdp });
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      const out = await requestArchiveGb(deps, { owner: o, requestedBy: o.wallet, paymentHeader: header, listing: LISTING });
      if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
      expect(out.payment).toMatchObject({ credited: true, settled_via: 'relay_gas_key' });
      expect(submitted).toHaveLength(1);
      expect(calls).toHaveLength(0);
    });
  });

  it('a submit that throws after broadcasting is UNCONFIRMED, never "not charged"; the sweep credits it once it mines', async () => {
    const lands: UsdcChargePayment[] = [];
    const used = new Set<string>();
    let mined: string | null = null;
    const chain: UsdcChargeChain = {
      ...fakeChain().chain,
      authorizationUsed: async (from, nonce) => used.has(`${from}|${nonce}`),
      // The node accepted the transaction, then the call failed (it is in the mempool, not mined).
      submitCharge: async (p) => { lands.push(p); throw new Error('getBlockNumber timeout'); },
      findCharge: async () => ({ txHash: mined, windowClosed: false }),
    };
    const o3: ArchiveOwner = { wallet: `wallet_aw_${RUN}_3`, kind: 'agent', actorId: `agent_${RUN}_3`, linkedHumanWallet: null };
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    const out = await requestArchiveGb(deps, { owner: o3, requestedBy: o3.wallet, paymentHeader: header, listing: LISTING });
    expect(out.kind).toBe('payment');
    if (out.kind !== 'payment') return;
    expect(out.payment).toMatchObject({ state: 'charge_unconfirmed', credited: false, last_error: 'getBlockNumber timeout' });
    // RED: still unused and still valid → the sweep keeps it unconfirmed (never charge_failed).
    expect((await advanceArchivePayment(deps, out.payment.request_id)).state).toBe('charge_unconfirmed');
    // It mines: the sweep credits the GB exactly once.
    used.add(`${lands[0].authorization.from}|${lands[0].authorization.nonce}`);
    mined = '0x' + 'a1'.repeat(32);
    expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charged', credited: true, charge_tx_hash: mined });
    expect(await readArchiveAccount(db, o3.wallet)).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
  });

  it('a submit that throws and never lands becomes "not charged" only once the chain window has closed', async () => {
    let closed = false;
    const chain: UsdcChargeChain = {
      ...fakeChain().chain,
      authorizationUsed: async () => false,
      submitCharge: async () => { throw new Error('socket hang up'); },
      findCharge: async () => ({ txHash: null, windowClosed: closed }),
    };
    const o4: ArchiveOwner = { wallet: `wallet_aw_${RUN}_4`, kind: 'agent', actorId: `agent_${RUN}_4`, linkedHumanWallet: null };
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    const out = await requestArchiveGb(deps, { owner: o4, requestedBy: o4.wallet, paymentHeader: header, listing: LISTING });
    if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
    expect(out.payment.state).toBe('charge_unconfirmed');
    expect((await advanceArchivePayment(deps, out.payment.request_id)).state).toBe('charge_unconfirmed');
    closed = true; // Base's head is past validBefore + grace, and nothing paid
    expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charge_failed', credited: false });
    expect(await readArchiveAccount(db, o4.wallet)).toBeNull();
  });

  it('RED: a payer who cancels the authorization (USDC says "used", no fee moved) is never credited', async () => {
    let closed = false;
    const chain: UsdcChargeChain = {
      ...fakeChain().chain,
      authorizationUsed: async () => false,
      submitCharge: async () => { throw new Error('insufficient funds for gas'); },
      findCharge: async () => ({ txHash: null, windowClosed: closed }),
    };
    const o5: ArchiveOwner = { wallet: `wallet_aw_${RUN}_5`, kind: 'agent', actorId: `agent_${RUN}_5`, linkedHumanWallet: null };
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    const out = await requestArchiveGb(deps, { owner: o5, requestedBy: o5.wallet, paymentHeader: header, listing: LISTING });
    if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
    // The payer now calls USDC.cancelAuthorization: authorizationState reads true, nothing moved.
    (chain as { authorizationUsed: UsdcChargeChain['authorizationUsed'] }).authorizationUsed = async () => true;
    expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charge_unconfirmed', credited: false });
    closed = true; // Base's head is past validBefore + grace, and nothing paid
    expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charge_failed', credited: false });
    expect(await readArchiveAccount(db, o5.wallet)).toBeNull();
  });

  for (const submitEnds of ['throws', 'returns its hash'] as const) {
    it(`RED: a poll that credits the GB while the submit is still running is never pulled back (the submit ${submitEnds})`, async () => {
      const seen: (number | null)[] = [];
      let mined: string | null = null;
      let unreadable = false;
      const chain: UsdcChargeChain = { ...fakeChain().chain, headBlock: async () => 7777 };
      const o6: ArchiveOwner = { wallet: `wallet_aw_${RUN}_6${submitEnds === 'throws' ? 't' : 'r'}`, kind: 'agent', actorId: `agent_${RUN}_6`, linkedHumanWallet: null };
      const { deps } = makeDeps(chain);
      chain.confirmCharge = async () => { if (unreadable) throw new Error('rpc 429'); return 'confirmed'; };
      chain.findCharge = async (_p, since) => {
        if (unreadable) throw new Error('rpc 429');
        seen.push(since.block);
        return { txHash: mined, windowClosed: false };
      };
      chain.submitCharge = async () => {
        mined = '0x' + 'c3'.repeat(32);
        const snap = await db.collection(ARCHIVE_PAYMENTS_COLLECTION).where('wallet', '==', o6.wallet).get();
        expect(snap.size).toBe(1);
        expect(await advanceArchivePayment(deps, snap.docs[0].id)).toMatchObject({ state: 'charged', credited: true });
        // The chain goes unreadable, so nothing after this can re-confirm (and repair) the payment:
        // only the handler's own write decides what the document says.
        unreadable = true;
        if (submitEnds === 'throws') throw new Error('getBlockNumber timeout');
        return mined;
      };
      const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
      const out = await requestArchiveGb(deps, { owner: o6, requestedBy: o6.wallet, paymentHeader: header, listing: LISTING });
      if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
      expect(out.payment).toMatchObject({ state: 'charged', credited: true, charge_tx_hash: mined });
      expect(await readArchiveAccount(db, o6.wallet)).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
      // The search started from the Base block recorded on the payment.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((b) => b === 7777)).toBe(true);
    });
  }

  it('a credited payment that a racing write left unconfirmed is put back to charged — never credited twice', async () => {
    const o8: ArchiveOwner = { wallet: `wallet_aw_${RUN}_8`, kind: 'agent', actorId: `agent_${RUN}_8`, linkedHumanWallet: null };
    const { chain } = fakeChain();
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    const out = await requestArchiveGb(deps, { owner: o8, requestedBy: o8.wallet, paymentHeader: header, listing: LISTING });
    if (out.kind !== 'payment') throw new Error(`expected payment, got ${out.kind}`);
    expect(out.payment.credited).toBe(true);
    await db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(out.payment.request_id).update({ state: 'charge_unconfirmed' });
    expect(await advanceArchivePayment(deps, out.payment.request_id)).toMatchObject({ state: 'charged', credited: true });
    expect(await readArchiveAccount(db, o8.wallet)).toMatchObject({ paid_bytes: ARCHIVE_GB_BYTES, gb_purchased: 1 });
  });

  it('RED: the sweep reaches an unresolved payment however many finished payments sort before it', async () => {
    const o7: ArchiveOwner = { wallet: `wallet_aw_${RUN}_7`, kind: 'agent', actorId: `agent_${RUN}_7`, linkedHumanWallet: null };
    const base = { schema: 'provian.pe-archive-payment.v1', owner_kind: 'agent', actor_id: o7.actorId, requested_by: o7.wallet, payer: payer.address.toLowerCase(),
      authorization_nonce: '0x' + '00'.repeat(32), fee_usdc_atomic: '5000000', created_at_ms: Date.now(), updated_at_ms: Date.now(), charged_at_ms: null,
      last_error: null, charge_from_block: 1, payment: { signature: '0x', authorization: { from: payer.address.toLowerCase(), to: '0x086e0f377af1245b8888540f39e99a42a7daf1da', value: '5000000', validAfter: '0', validBefore: '1', nonce: '0x' + '00'.repeat(32) } } };
    // Twelve finished payments whose ids sort before the unresolved one.
    for (let i = 0; i < 12; i++) {
      const id = `ap_!a_${RUN}_${String(i).padStart(2, '0')}`;
      await db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(id).set({ ...base, request_id: id, wallet: `wallet_done_${RUN}`, state: 'charged', credited: true, credited_bytes: ARCHIVE_GB_BYTES, charge_tx_hash: '0x' + '01'.repeat(32) });
    }
    const id = `ap_!s_${RUN}`;
    await db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(id).set({ ...base, request_id: id, wallet: o7.wallet, state: 'charge_unconfirmed', credited: false, credited_bytes: 0, charge_tx_hash: null });
    const chain: UsdcChargeChain = { ...fakeChain().chain, findCharge: async (p, _s) => ({ txHash: p.authorization.nonce === base.authorization_nonce ? '0x' + 'd4'.repeat(32) : null, windowClosed: false }) };
    const { deps } = makeDeps(chain);
    await sweepArchive(deps, 2);
    expect((await db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(id).get()).data()).toMatchObject({ state: 'charged', credited: true });
  });

  it('RED: the next GB is refused while most of the GB is unused — nothing charged', async () => {
    const { chain, submitted } = fakeChain();
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000' });
    expect((await requestArchiveGb(deps, { owner, requestedBy: owner.wallet, paymentHeader: header, listing: LISTING })).kind).toBe('space_available');
    expect(submitted).toHaveLength(0);
  });

  it('RED: a wrong signer is refused before the chain', async () => {
    const { chain, submitted } = fakeChain();
    const { deps } = makeDeps(chain);
    const header = await signedPaymentHeader(payer, Math.floor(Date.now() / 1000), { value: '5000000', signWith: Wallet.createRandom() });
    expect(await requestArchiveGb(deps, { owner: other, requestedBy: other.wallet, paymentHeader: header, listing: LISTING }))
      .toMatchObject({ kind: 'payment_required', error: 'payment_signature_invalid' });
    expect(submitted).toHaveLength(0);
  });

  it('a day is confirmed only once its object matches the index AND its batches are anchored', async () => {
    const { deps, objects } = shared;
    const b1 = batchFor(owner, 'dev_a', 1, 0, METER_GENESIS_PREV_HASH, 3);
    await seedBatchRecord(b1, false);
    const part = partOf(owner, 'dev_a', [b1]);
    const out = await storeArchivePart(deps, { owner, deviceId: 'dev_a', bytes: part.bytes });
    expect(out.kind).toBe('stored');
    let day = await readArchiveDay(db, owner.wallet, DAY);
    expect(day?.parts[0]).toMatchObject({ state: 'stored', sha256: part.sha256, bytes: part.bytes.length });
    expect(day?.confirmed).toBe(false); // RED: batch not anchored yet → not confirmed
    // A small part counts as 1 MB of the paid space; the day records its real size.
    expect(part.bytes.length).toBeLessThan(ARCHIVE_MIN_CHARGED_PART_BYTES);
    expect(day?.parts[0]?.charged_bytes).toBe(ARCHIVE_MIN_CHARGED_PART_BYTES);
    expect((await readArchiveAccount(db, owner.wallet))?.used_bytes).toBe(ARCHIVE_MIN_CHARGED_PART_BYTES);

    await seedBatchRecord(b1, true);
    expect(await confirmArchiveDay(deps, owner.wallet, DAY)).toBe('confirmed');
    day = await readArchiveDay(db, owner.wallet, DAY);
    expect(day?.confirmed).toBe(true);
    // The part is its own object; the old single day object is never created.
    expect(day!.parts[0].object_path).toBe(archivePartObjectPath(owner.wallet, DAY, 'dev_a', 0, part.sha256));
    expect(Buffer.from(objects.objects.get(day!.parts[0].object_path!)!.bytes).equals(Buffer.from(part.bytes))).toBe(true);
    expect(objects.objects.has(day!.object_path)).toBe(false);

    // Idempotent re-upload; a different part under the same number is a conflict.
    expect(await storeArchivePart(deps, { owner, deviceId: 'dev_a', bytes: part.bytes })).toMatchObject({ kind: 'stored', idempotent: true });
    const b1b = batchFor(owner, 'dev_a', 1, 0, METER_GENESIS_PREV_HASH, 2);
    expect(await storeArchivePart(deps, { owner, deviceId: 'dev_a', bytes: partOf(owner, 'dev_a', [b1b]).bytes }))
      .toMatchObject({ kind: 'refused', error: 'archive_part_conflict' });
  });

  it('a second device adds its OWN object; the first object is never rewritten; the day serves both in order', async () => {
    const { deps, objects } = shared;
    const b = batchFor(owner, 'dev_b', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await seedBatchRecord(b, true);
    const before = (await readArchiveDay(db, owner.wallet, DAY))!;
    const firstPath = before.parts[0].object_path!;
    const firstGen = objects.objects.get(firstPath)!.generation;
    const firstBytes = Buffer.from(objects.objects.get(firstPath)!.bytes);
    const readsBefore = objects.reads.count;
    const part = partOf(owner, 'dev_b', [b]);
    expect((await storeArchivePart(deps, { owner, deviceId: 'dev_b', bytes: part.bytes })).kind).toBe('stored');
    const after = (await readArchiveDay(db, owner.wallet, DAY))!;
    expect(after.parts.map((p) => p.device_id)).toEqual(['dev_a', 'dev_b']);
    expect(after.stored_bytes).toBe(before.stored_bytes + part.bytes.length);
    expect(after.confirmed).toBe(true);
    expect(objects.objects.size).toBe(2);
    // The first object: same generation, same bytes (never replaced, composed into or deleted).
    expect(objects.objects.get(firstPath)!.generation).toBe(firstGen);
    expect(Buffer.from(objects.objects.get(firstPath)!.bytes).equals(firstBytes)).toBe(true);
    // Storing and confirming read no object data at all.
    expect(objects.reads.count).toBe(readsBefore);
    // A reader gets the parts concatenated in index order (the wire every client already parses).
    const served = await drain(openArchiveDayStream(objects, after));
    expect(served.equals(Buffer.concat([firstBytes, Buffer.from(part.bytes)]))).toBe(true);
  });

  it('a day waiting for its anchor never reads the bucket; once anchored, confirmation is metadata-only', async () => {
    const { chain } = fakeChain();
    const { deps, objects } = makeDeps(chain);
    const w: ArchiveOwner = { wallet: `wallet_aw_${RUN}_w`, kind: 'agent', actorId: `agent_${RUN}_w`, linkedHumanWallet: null };
    await db.collection('archive_accounts_v1').doc(w.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: w.wallet, owner_kind: 'agent', actor_id: w.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    const b = batchFor(w, 'dev_w', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await seedBatchRecord(b, false);
    expect((await storeArchivePart(deps, { owner: w, deviceId: 'dev_w', bytes: partOf(w, 'dev_w', [b]).bytes })).kind).toBe('stored');
    for (let i = 0; i < 3; i++) expect(await confirmArchiveDay(deps, w.wallet, DAY)).toBe('pending');
    await sweepArchive(deps);
    expect((await readArchiveDay(db, w.wallet, DAY))?.last_check).toBe('batches_not_yet_anchored');
    expect(objects.reads.count).toBe(0);
    await seedBatchRecord(b, true);
    expect(await confirmArchiveDay(deps, w.wallet, DAY)).toBe('confirmed');
    expect(objects.reads.count).toBe(0);
  });

  it('a pre-2026-10-07 day (one object per day) is served and confirmed as it is; a later part gets its own object', async () => {
    const { chain } = fakeChain();
    const { deps, objects } = makeDeps(chain);
    const l: ArchiveOwner = { wallet: `wallet_aw_${RUN}_l`, kind: 'agent', actorId: `agent_${RUN}_l`, linkedHumanWallet: null };
    const b = batchFor(l, 'dev_l', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await seedBatchRecord(b, true);
    const legacyPart = partOf(l, 'dev_l', [b]);
    const legacyPath = archiveObjectPath(l.wallet, DAY);
    await objects.create(legacyPath, legacyPart.bytes);
    const legacyGen = objects.objects.get(legacyPath)!.generation;
    await db.collection('archive_accounts_v1').doc(l.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: l.wallet, owner_kind: 'agent', actor_id: l.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: legacyPart.bytes.length, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    await db.collection('archive_days_v1').doc(archiveDayId(l.wallet, DAY)).set({
      schema: 'provian.pe-archive-day.v1', id: archiveDayId(l.wallet, DAY), wallet: l.wallet, day: DAY, bucket: objects.bucket,
      object_path: legacyPath, stored_bytes: legacyPart.bytes.length, generation: String(legacyGen), pe_count: 2,
      confirmed: false, confirmed_at_ms: null, rejected_reason: null, last_check: null, created_at_ms: 1, updated_at_ms: 1,
      parts: [{
        device_id: 'dev_l', part: 0, sha256: legacyPart.sha256, bytes: legacyPart.bytes.length, pe_count: 2, state: 'stored',
        confirmed: false, uploaded_at_ms: 1, stored_at_ms: 1,
        batches: [{ seq: b.seq, batch_hash: b.batch_hash, batch_leaf: b.batch_leaf, acts_root: b.acts_root, actor_id: b.actor_id, first_index: 0, count: 2, anchor: b.anchor }],
      }],
    });
    expect(await confirmArchiveDay(deps, l.wallet, DAY)).toBe('confirmed');
    // A second device's part on the same day: its own object; the old day object untouched.
    const b2 = batchFor(l, 'dev_l2', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await seedBatchRecord(b2, true);
    const p2 = partOf(l, 'dev_l2', [b2]);
    expect((await storeArchivePart(deps, { owner: l, deviceId: 'dev_l2', bytes: p2.bytes })).kind).toBe('stored');
    const day = (await readArchiveDay(db, l.wallet, DAY))!;
    expect(day.parts[0].object_path).toBeUndefined();
    expect(day.parts[1].object_path).toBe(archivePartObjectPath(l.wallet, DAY, 'dev_l2', 0, p2.sha256));
    expect(objects.objects.get(legacyPath)!.generation).toBe(legacyGen);
    expect(Buffer.from(objects.objects.get(legacyPath)!.bytes).equals(Buffer.from(legacyPart.bytes))).toBe(true);
    expect(day.confirmed).toBe(true);
    const served = await drain(openArchiveDayStream(objects, day));
    expect(served.equals(Buffer.concat([Buffer.from(legacyPart.bytes), Buffer.from(p2.bytes)]))).toBe(true);
  });

  it('a part whose object landed but whose index fell behind is settled by the sweep from metadata alone', async () => {
    const { chain } = fakeChain();
    const made = makeDeps(chain);
    let failNext = true;
    const flaky = {
      ...made.objects,
      async create(path: string, bytes: Uint8Array) {
        const out = await made.objects.create(path, bytes);
        if (failNext) { failNext = false; throw new Error('network_dropped_after_write'); }
        return out;
      },
    };
    let clock = Date.now();
    const deps: ArchiveDeps = { ...made.deps, objects: flaky, now: () => clock };
    const s: ArchiveOwner = { wallet: `wallet_aw_${RUN}_s`, kind: 'agent', actorId: `agent_${RUN}_s`, linkedHumanWallet: null };
    await db.collection('archive_accounts_v1').doc(s.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: s.wallet, owner_kind: 'agent', actor_id: s.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    const b = batchFor(s, 'dev_s', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await seedBatchRecord(b, true);
    await expect(storeArchivePart(deps, { owner: s, deviceId: 'dev_s', bytes: partOf(s, 'dev_s', [b]).bytes })).rejects.toThrow('network_dropped_after_write');
    expect((await readArchiveDay(db, s.wallet, DAY))?.parts[0].state).toBe('uploading');
    clock += 16 * 60_000;
    await sweepArchive(deps);
    const day = (await readArchiveDay(db, s.wallet, DAY))!;
    expect(day.parts[0].state).toBe('stored');
    expect(day.confirmed).toBe(true);
    expect(made.objects.objects.size).toBe(1);
    expect(made.objects.reads.count).toBe(0);
  });

  it('the 1 MB floor : a small part that fits by its bytes but not by 1 MB is refused; a released upload gives back exactly 1 MB', async () => {
    // (1) Space: 999,999 bytes left. A ~5 KB part would fit by its bytes, but counts as 1 MB.
    const { chain } = fakeChain();
    const made = makeDeps(chain);
    const f: ArchiveOwner = { wallet: `wallet_aw_${RUN}_f`, kind: 'agent', actorId: `agent_${RUN}_f`, linkedHumanWallet: null };
    const seedAccount = (o: ArchiveOwner, used: number) => db.collection('archive_accounts_v1').doc(o.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: o.wallet, owner_kind: 'agent', actor_id: o.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: used, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    await seedAccount(f, ARCHIVE_GB_BYTES - (ARCHIVE_MIN_CHARGED_PART_BYTES - 1));
    const bf = batchFor(f, 'dev_f', 1, 0, METER_GENESIS_PREV_HASH, 2);
    const small = partOf(f, 'dev_f', [bf]).bytes;
    expect(small.length).toBeLessThan(ARCHIVE_MIN_CHARGED_PART_BYTES - 1); // RED: by its bytes alone it would fit
    expect((await storeArchivePart(made.deps, { owner: f, deviceId: 'dev_f', bytes: small })).kind).toBe('space_exhausted');
    expect(made.objects.objects.size).toBe(0);
    // Exactly 1 MB left: it fits, and uses all of it.
    await seedAccount(f, ARCHIVE_GB_BYTES - ARCHIVE_MIN_CHARGED_PART_BYTES);
    await seedBatchRecord(bf, true);
    expect((await storeArchivePart(made.deps, { owner: f, deviceId: 'dev_f', bytes: small })).kind).toBe('stored');
    expect((await readArchiveAccount(db, f.wallet))?.used_bytes).toBe(ARCHIVE_GB_BYTES);

    // (2) Release: an upload that never landed gives back what it was counted (1 MB), not its bytes.
    let clock = Date.now();
    const failing = { ...made.objects, async create() { throw new Error('network_dropped_before_write'); } };
    const deps: ArchiveDeps = { ...made.deps, objects: failing, now: () => clock };
    const r: ArchiveOwner = { wallet: `wallet_aw_${RUN}_r`, kind: 'agent', actorId: `agent_${RUN}_r`, linkedHumanWallet: null };
    await seedAccount(r, 3_000_000);
    const br = batchFor(r, 'dev_r', 1, 0, METER_GENESIS_PREV_HASH, 2);
    await expect(storeArchivePart(deps, { owner: r, deviceId: 'dev_r', bytes: partOf(r, 'dev_r', [br]).bytes })).rejects.toThrow('network_dropped_before_write');
    expect((await readArchiveAccount(db, r.wallet))?.used_bytes).toBe(3_000_000 + ARCHIVE_MIN_CHARGED_PART_BYTES);
    clock += 16 * 60_000;
    await sweepArchive(deps);
    expect((await readArchiveDay(db, r.wallet, DAY))?.parts ?? []).toHaveLength(0);
    expect((await readArchiveAccount(db, r.wallet))?.used_bytes).toBe(3_000_000);
  });

  it('RED: an upload that would pass the paid space is refused 402 and writes NOTHING', async () => {
    const { chain } = fakeChain();
    const { deps, objects } = makeDeps(chain);
    const full: ArchiveOwner = { wallet: `wallet_aw_${RUN}_full`, kind: 'agent', actorId: `agent_${RUN}_full`, linkedHumanWallet: null };
    await db.collection('archive_accounts_v1').doc(full.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: full.wallet, owner_kind: 'agent', actor_id: full.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: ARCHIVE_GB_BYTES - 100, gb_purchased: 1,
      created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    const b = batchFor(full, 'dev_f', 1, 0, METER_GENESIS_PREV_HASH, 3);
    const out = await storeArchivePart(deps, { owner: full, deviceId: 'dev_f', bytes: partOf(full, 'dev_f', [b]).bytes });
    expect(out.kind).toBe('space_exhausted');
    expect(objects.objects.size).toBe(0);
    expect(await readArchiveDay(db, full.wallet, DAY)).toBeNull();
    expect((await readArchiveAccount(db, full.wallet))?.used_bytes).toBe(ARCHIVE_GB_BYTES - 100);
  });

  it('RED: a tampered object is never confirmed; a batch the meter records differently is rejected', async () => {
    const { chain } = fakeChain();
    const { deps, objects } = makeDeps(chain);
    const t: ArchiveOwner = { wallet: `wallet_aw_${RUN}_t`, kind: 'agent', actorId: `agent_${RUN}_t`, linkedHumanWallet: null };
    await setArchiveOn(deps, t, true).catch(() => undefined);
    await db.collection('archive_accounts_v1').doc(t.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: t.wallet, owner_kind: 'agent', actor_id: t.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    const b = batchFor(t, 'dev_t', 1, 0, METER_GENESIS_PREV_HASH, 3);
    await seedBatchRecord(b, false);
    const part = partOf(t, 'dev_t', [b]);
    expect((await storeArchivePart(deps, { owner: t, deviceId: 'dev_t', bytes: part.bytes })).kind).toBe('stored');
    const day = (await readArchiveDay(db, t.wallet, DAY))!;
    const stored = objects.objects.get(day.parts[0].object_path!)!;
    stored.bytes[10] ^= 0x01; // one flipped bit in storage
    await seedBatchRecord(b, true);
    expect(await confirmArchiveDay(deps, t.wallet, DAY)).toBe('pending');
    expect((await readArchiveDay(db, t.wallet, DAY))?.last_check).toBe('part_object_differs_from_index');
    stored.bytes[10] ^= 0x01;
    await seedBatchRecord(b, true, { batch_leaf: 'ff'.repeat(32) });
    expect(await confirmArchiveDay(deps, t.wallet, DAY)).toBe('rejected');
    expect((await readArchiveDay(db, t.wallet, DAY))?.confirmed).toBe(false);
  });

  it('an old batch (no meter record left) is proven on chain by the proof the part carries; the sweep confirms it', async () => {
    const { chain } = fakeChain();
    const h: ArchiveOwner = { wallet: `wallet_aw_${RUN}_h`, kind: 'agent', actorId: `agent_${RUN}_h`, linkedHumanWallet: null };
    const b = batchFor(h, 'dev_h', 1, 0, METER_GENESIS_PREV_HASH, 2);
    let anchored = false;
    const { deps } = makeDeps(chain, () => anchored);
    await db.collection('archive_accounts_v1').doc(h.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: h.wallet, owner_kind: 'agent', actor_id: h.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    expect((await storeArchivePart(deps, { owner: h, deviceId: 'dev_h', bytes: partOf(h, 'dev_h', [b]).bytes })).kind).toBe('stored');
    // The anchor says no: rejected, never confirmed.
    expect((await readArchiveDay(db, h.wallet, DAY))?.rejected_reason).toMatch(/batch_not_anchored_on_chain/);
    // A fresh day under a second wallet the anchor DOES know: confirmed through the sweep.
    const h2: ArchiveOwner = { ...h, wallet: `${h.wallet}2`, actorId: `${h.actorId}2` };
    await db.collection('archive_accounts_v1').doc(h2.wallet).set({
      schema: 'provian.pe-archive-account.v1', wallet: h2.wallet, owner_kind: 'agent', actor_id: h2.actorId, on: true,
      paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0, gb_purchased: 1, created_at_ms: 1, updated_at_ms: 1, turned_on_at_ms: 1, turned_off_at_ms: null,
    });
    anchored = true;
    const b2 = batchFor(h2, 'dev_h2', 1, 0, METER_GENESIS_PREV_HASH, 2);
    expect((await storeArchivePart(deps, { owner: h2, deviceId: 'dev_h2', bytes: partOf(h2, 'dev_h2', [b2]).bytes })).kind).toBe('stored');
    expect((await readArchiveDay(db, h2.wallet, DAY))?.confirmed).toBe(true);
    await sweepArchive(deps);
  });

  it("an owner's payments list newest first, with the transaction", async () => {
    const list = await listArchivePayments(db, owner.wallet);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].charge_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(list.every((p) => p.wallet === owner.wallet)).toBe(true);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].created_at_ms).toBeGreaterThanOrEqual(list[i].created_at_ms);
    expect(await listArchivePayments(db, `${owner.wallet}_nobody`)).toEqual([]);
  });

  it('off keeps everything stored; on again needs space left', async () => {
    const { deps } = shared;
    const off = await setArchiveOn(deps, owner, false);
    expect(off.kind).toBe('ok');
    expect((await readArchiveAccount(db, owner.wallet))?.on).toBe(false);
    expect((await readArchiveDay(db, owner.wallet, DAY))?.stored_bytes).toBeGreaterThan(0);
    expect((await setArchiveOn(deps, owner, true)).kind).toBe('ok');
  });
});
