/**
 * VOUCH FOLD + INVALIDATION — the decision's proof (6-09-04), end-to-end with
 * REAL crypto and the REAL modules (producePresentationFromRequest → the rail
 * handshake gate → stakeVouch → invalidateHandshakes → readHandshakeState).
 *
 * A vouch is a TRUST ACT and is now GATED like every other rail class. FOLD, DON'T
 * STACK: the voucher's single reputation presentation to the vouchee IS the vouch's
 * burn — the vouch never burns a second (scarcity) time. This test proves the exact
 * sequence the operator specified:
 *
 * 1. vouch REFUSED (428) with no live handshake
 * 2. → voucher PRESENTS a reputation presentation to the vouchee (one 15-PVT burn)
 * 3. → vouch COMMITS, consuming that presentation as its burn
 * 4. → EXACTLY ONE burn charged: the burn is consumed once in the GLOBAL
 * single-use ledger as product='presentation'; stakeVouch adds NO second
 * (scarcity) consumption. Both jobs satisfied — reputation tier proves
 * standing (quality), the 15-PVT burn is the anti-sybil cost (quantity).
 * 5. → a SECOND vouch to the same vouchee IN-WINDOW commits with NO new
 * presentation (same backing burn; ledger + presentations unchanged).
 * 6. → an adverse presenter-side event on the VOUCHER closes the window; the next
 * vouch is REFUSED (428) and the invalidation reason is readable by both
 * parties (readHandshakeState → invalidated + reason class).
 * 7. → the voucher RE-PRESENTS (a fresh burn) → the vouch COMMITS again.
 * 8. → a previously-committed vouch is UNTOUCHED (forward-looking only).
 *
 * The rig is CC-controlled identities only — no real vouch on mainnet, no the operator
 * key in the signing path (the decision states the rig is sufficient).
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { producePresentationFromRequest, type PresenterPrincipal } from '../presentation/service';
import { presentationBindingString, claimsDigest } from '../presentation/types';
import { canonicalReputationDirective } from '../presentation/disclosure';
import type { CommerceAttestationPublicJwk } from '../presentation/jws-key-material';
import { stakeVouch, getVouch } from './burn-vouch';
import { BURN_CONSUMPTIONS_COLLECTION } from './burn-consumption';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/types';
import { readHandshakeState, RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';
import { invalidateHandshakes } from '../rail/invalidation';
import type { AgentBankDeps } from '../agent-bank/types';

// ── Ed25519 Provian reputation signing key ───────────────────────────────────
function makeEd25519Env(): { env: Record<string, string>; publicKeys: CommerceAttestationPublicJwk[] } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const kid = 'vouch-rep-key';
  return {
    env: { ATTESTATION_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid, x: priv.x, d: priv.d }) },
    publicKeys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: pub.x, use: 'sig', alg: 'EdDSA', key_ops: ['verify'] }],
  };
}

// ── Agent secp256k1 signer (the VOUCHER / PRESENTER) ─────────────────────────
function makeAgentSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xHex = Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0');
  const yHex = Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  const pubkeyHex = xHex + yHex;
  const address = ethers.computeAddress(`0x04${pubkeyHex}`).toLowerCase();
  const sign = (msg: string): string => { const s = crypto.createSign('SHA256'); s.update(msg); return s.sign(privateKey, 'hex'); };
  return { pubkeyHex, address, sign };
}

// ── Fake Firestore ───────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name); if (!c) { c = new Map(); store.set(name, c); } return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get() { const row = coll(this.store, this.collection).get(this.id); return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) }; }
  set(data: Row, opts?: { merge?: boolean }): void { const c = coll(this.store, this.collection); if (opts?.merge) c.set(this.id, { ...(c.get(this.id) ?? {}), ...data }); else c.set(this.id, { ...data }); }
  create(data: Row): void { const c = coll(this.store, this.collection); if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; } c.set(this.id, { ...data }); }
}
class FakeQuery {
  // the vocabulary is fail-closed — the fixture gives it every reader it uses (op-aware
  // `where` for == / >=, the reference graph's orderBy/select/startAfter/limit, `.count()`, `size`).
  constructor(private store: Store, private collection: string, private cons: [string, string, unknown][] = [], private lim = Infinity) {}
  where(f: string, op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.collection, [...this.cons, [f, op, v]], this.lim); }
  limit(n: number): FakeQuery { return new FakeQuery(this.store, this.collection, this.cons, n); }
  orderBy(): FakeQuery { return this; }
  select(): FakeQuery { return this; }
  startAfter(): FakeQuery { return this; }
  private rows() { let rows = [...coll(this.store, this.collection).entries()]; for (const [f, op, v] of this.cons) rows = rows.filter(([, d]) => (op === '>=' ? typeof d[f] === 'number' && (d[f] as number) >= (v as number) : d[f] === v)); return rows.slice(0, this.lim); }
  async get() { const rows = this.rows(); return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => ({ ...d }) })) }; }
  count() { return { get: async () => ({ data: () => ({ count: this.rows().length }) }) }; }
}
class FakeCollection {
  constructor(private store: Store, private name: string) {}
  doc(id: string): FakeDocRef { return new FakeDocRef(this.store, this.name, id); }
  where(f: string, op: string, v: unknown): FakeQuery { return new FakeQuery(this.store, this.name).where(f, op, v); }
}
function makeDb(store: Store) {
  return {
    collection: (name: string) => new FakeCollection(store, name),
    runTransaction: async (fn: (txn: { get: (r: FakeDocRef) => ReturnType<FakeDocRef['get']>; create: (r: FakeDocRef, d: Row) => void; set: (r: FakeDocRef, d: Row, o?: { merge?: boolean }) => void }) => Promise<unknown>) =>
      fn({ get: (r) => r.get(), create: (r, d) => r.create(d), set: (r, d, o) => r.set(d, o) }),
  } as unknown as import('firebase-admin/firestore').Firestore;
}

const ONE_PVT = 10n ** 18n;
function seedBurn(store: Store, burnId: string, walletId: string, address: string): void {
  coll(store, 'pvt_burn_records').set(burnId, {
    tx_hash: `0x${burnId.slice(0, 8)}`, chain: 'base', wallet_id: walletId,
    burner_address: address, amount_atomic: (15n * ONE_PVT).toString(),
    status: 'recorded', verified: true,
  });
}

/** The voucher signs + POSTs a REPUTATION presentation to the vouchee (audience). */
async function present(
  store: Store, env: Record<string, string>, signer: ReturnType<typeof makeAgentSigner>,
  walletId: string, audience: string, burnId: string, jti: string,
): Promise<void> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 300;
  const challenge = crypto.randomBytes(32).toString('hex'); // the vouchee's fresh nonce
  const directive = canonicalReputationDirective({ redact: [], predicates: [] });
  const digest = claimsDigest({ tier: 'reputation', reputation_directive: directive });
  const binding = presentationBindingString({
    tier: 'reputation', presenter_address: signer.address, aud: audience, chal: challenge,
    iat, exp, jti, burn_id: burnId, claims_digest: digest,
  });
  const body = {
    tier: 'reputation', burn_id: burnId, audience, challenge, iat, exp, jti,
    pop: { scheme: 'ecdsa_sha256_secp256k1', signature: signer.sign(binding), pubkey: signer.pubkeyHex },
    disclosure: { redact: [], predicates: [] },
  };
  const principal: PresenterPrincipal = {
    kind: 'agent', walletId, address: signer.address, peOwnerUserId: `${walletId}-agent`,
    publicKeyHex: signer.pubkeyHex, standing: { governance_score: 42, pe_count: 7, streak_days: 3 },
  };
  const produced = await producePresentationFromRequest({ db: makeDb(store), env }, principal, body);
  expect(produced.ok).toBe(true);
}

function deps(store: Store): AgentBankDeps {
  return { db: makeDb(store) } as unknown as AgentBankDeps;
}
function recordedAtOf(store: Store, burnId: string): number {
  return coll(store, COMMONS_PRESENTATIONS_COLLECTION).get(burnId)!.recorded_at as number;
}

const VOUCHER_WALLET = 'aw_voucher';
const VOUCHER_AGENT = 'agent_voucher';
const VOUCHEE = 'agent_vouchee'; // the target_agent_id == the handshake audience
const AGENT_WALLET = { id: VOUCHER_WALLET, agent_id: VOUCHER_AGENT };

let store: Store;
let env: Record<string, string>;
let voucher: ReturnType<typeof makeAgentSigner>;
beforeEach(() => {
  store = new Map(); env = makeEd25519Env().env; voucher = makeAgentSigner();
  // the vouch reads the voucher's own wallet record (linked-human exclusion).
  coll(store, 'agent_wallets').set(VOUCHER_WALLET, { id: VOUCHER_WALLET, agent_id: VOUCHER_AGENT });
});

describe('vouch fold — one burn satisfies both jobs; per-relationship in-window', () => {
  it('428 → present → commit (one burn) → second in-window (no new present)', async () => {
    // 1) No handshake → the vouch REFUSES (428).
    const refused = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, nowMs: Date.now() });
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.status).toBe(428); expect(refused.reason).toBe('rail_handshake_required'); }

    // 2) The voucher PRESENTS a reputation presentation to the vouchee (one 15-PVT burn).
    const burn1 = 'a'.repeat(64);
    seedBurn(store, burn1, VOUCHER_WALLET, voucher.address);
    await present(store, env, voucher, VOUCHER_WALLET, VOUCHEE, burn1, 'vouch-pres-1');
    const recordedAt = recordedAtOf(store, burn1);

    // 4a) Exactly ONE burn consumed, as product='presentation' (the fold — the
    //     presentation is the burn artifact; there is no separate 'vouch' product).
    const ledger = coll(store, BURN_CONSUMPTIONS_COLLECTION);
    expect(ledger.size).toBe(1);
    expect(ledger.get(burn1)?.product).toBe('presentation');

    // 3) The vouch COMMITS, riding that presentation as its burn.
    const v1 = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, note: 'genuinely credible', nowMs: recordedAt + 1000 });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.vouch.backing_burn_id).toBe(burn1);

    // 4b) stakeVouch charged NO second burn — the ledger is STILL exactly one entry,
    //     still product='presentation'. Scarcity burn folded, not double-charged.
    expect(ledger.size).toBe(1);
    expect(ledger.get(burn1)?.product).toBe('presentation');
    // 4c) Both jobs satisfied: the backing presentation is REPUTATION tier (proves
    //     standing = quality) and it destroyed 15 PVT (anti-sybil cost = quantity).
    expect(coll(store, COMMONS_PRESENTATIONS_COLLECTION).get(burn1)?.tier).toBe('reputation');

    // 5) A SECOND vouch to the same vouchee IN-WINDOW commits with NO new
    //    presentation: no new burn, same backing burn, ledger + presentations unchanged.
    const v2 = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, note: 'still credible', nowMs: recordedAt + 60_000 });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.vouch.backing_burn_id).toBe(burn1);
    expect(ledger.size).toBe(1); // no new burn charged for the second vouch
    expect(coll(store, COMMONS_PRESENTATIONS_COLLECTION).size).toBe(1); // no new presentation
  });
});

describe('vouch invalidation — adverse voucher event closes the window forward-only', () => {
  it('adverse event → refuse w/ reason → re-present → commit; earlier vouch untouched', async () => {
    // Establish + commit a first vouch (steps 1–3 condensed).
    const burn1 = 'b'.repeat(64);
    seedBurn(store, burn1, VOUCHER_WALLET, voucher.address);
    await present(store, env, voucher, VOUCHER_WALLET, VOUCHEE, burn1, 'inv-pres-1');
    const recordedAt = recordedAtOf(store, burn1);
    const committed = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, note: 'first', nowMs: recordedAt + 1000 });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const firstVouchId = committed.vouch.vouch_id;

    // 6) Adverse presenter-side event on the VOUCHER (reputation downgrade) closes
    //    the window. The next vouch is REFUSED (428)...
    await invalidateHandshakes(deps(store).db, VOUCHER_WALLET, 'reputation_downgrade', recordedAt + 2000);
    const afterEvent = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, note: 'blocked', nowMs: recordedAt + 3000 });
    expect(afterEvent.ok).toBe(false);
    if (!afterEvent.ok) expect(afterEvent.status).toBe(428);

    // ...and the INVALIDATION REASON is readable by both parties.
    const state = await readHandshakeState(deps(store).db, VOUCHER_WALLET, VOUCHEE, recordedAt + 3000);
    expect(state.state).toBe('invalidated');
    expect(state.reasonClass).toBe('reputation_downgrade');

    // 7) The voucher RE-PRESENTS (a fresh burn) after the event → the vouch COMMITS.
    const burn2 = 'c'.repeat(64);
    seedBurn(store, burn2, VOUCHER_WALLET, voucher.address);
    await present(store, env, voucher, VOUCHER_WALLET, VOUCHEE, burn2, 'inv-pres-2');
    // Place the re-presentation's record time AFTER the invalidation event (on a
    // real clock the re-present is simply later than the event; the rig may collapse
    // both into the same ms).
    coll(store, COMMONS_PRESENTATIONS_COLLECTION).get(burn2)!.recorded_at = recordedAt + 4000;
    const recommitted = await stakeVouch(deps(store), { walletId: VOUCHER_WALLET, agentWallet: AGENT_WALLET, targetAgentId: VOUCHEE, note: 're-vouch', nowMs: recordedAt + 5000 });
    expect(recommitted.ok).toBe(true);
    if (!recommitted.ok) return;
    expect(recommitted.vouch.backing_burn_id).toBe(burn2);

    // 8) The previously-committed vouch is UNTOUCHED (forward-looking only): it still
    //    resolves, with its ORIGINAL backing burn — the floor never rewrote history.
    const stillThere = await getVouch(deps(store), firstVouchId);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.backing_burn_id).toBe(burn1);
  });
});
