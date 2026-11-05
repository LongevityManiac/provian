/**
 * Fact-base fixes item 4 : relay-witnessed origins count. The relay's own verified
 * observation (forge webhook / chain watcher) witnesses EXACTLY the origins it derived from the
 * verified event; those then face the unchanged owner / identity-set / closed-loop tests. Every
 * counting case has a RED control that adds zero.
 */
import { resolveOriginPricingInputs } from './origin-pricing-inputs';
import {
  relayWitnessedOriginsFor,
  relayObservationWitness,
  originKey,
  RELAY_WITNESS_CHAIN_WATCHER,
  RELAY_WITNESS_FORGE_WEBHOOK,
} from './relay-observation-witness';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
} from './native-wallet-registration';
import { ORIGIN_REFERENCE_GRAPH_COLLECTION } from './origin-reference-graph';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { normalizeInputOrigins, type InputOrigin } from '../provenance/input-origins';
import { resolvableOrigin, chainWatcherWitness, forgeWebhookWitness, privateOrigin } from '../provenance/origin-capture';

type Doc = Record<string, unknown> & { __id?: string };
function fakeDb(seed: Record<string, Doc[]> = {}) {
  const cols = new Map<string, Map<string, Record<string, unknown>>>();
  const getCol = (name: string) => { let m = cols.get(name); if (!m) { m = new Map(); cols.set(name, m); } return m; };
  for (const [name, docs] of Object.entries(seed)) {
    const m = getCol(name); let auto = 0;
    for (const d of docs) { const { __id, ...rest } = d; m.set(__id ?? `auto_${auto++}`, rest); }
  }
  return {
    _cols: cols,
    collection(name: string) {
      const store = getCol(name);
      return {
        doc(id: string) { return { _col: name, _id: id, get: async () => ({ exists: store.has(id), data: () => store.get(id) }) }; },
        where(field: string, _op: string, value: unknown) {
          // Supports the paged, projected out-edge read (orderBy(documentId) / select / limit / startAfter).
          const q = { limit: Infinity, after: null as string | null, fields: null as string[] | null };
          const chain = {
            orderBy: () => chain,
            select: (...fields: string[]) => { q.fields = fields; return chain; },
            limit: (n: number) => { q.limit = n; return chain; },
            startAfter: (id: string) => { q.after = id; return chain; },
            get: async () => {
              const docs = [...store.entries()]
                .filter(([, v]) => v[field] === value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .filter(([id]) => q.after === null || id > q.after)
                .slice(0, q.limit)
                .map(([id, v]) => ({ id, data: () => (q.fields ? Object.fromEntries(q.fields.filter((f) => f in v).map((f) => [f, v[f]])) : v) }));
              return { docs, size: docs.length, empty: docs.length === 0 };
            },
          };
          return chain;
        },
      };
    },
    batch() {
      const ops: Array<{ col: string; id: string; data: Record<string, unknown> }> = [];
      return { set(ref: { _col: string; _id: string }, data: Record<string, unknown>) { ops.push({ col: ref._col, id: ref._id, data }); }, commit: async () => { for (const o of ops) getCol(o.col).set(o.id, o.data); } };
    },
  } as never;
}
const cache = {} as never;
const UNLINKED: BeneficiaryCacheEntry = { linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null };
const unlinked = async (): Promise<BeneficiaryCacheEntry> => UNLINKED;
const addr = (c: string) => `0x${c.repeat(40)}`;
const SELF = addr('1');
const BOB = addr('b');
const AA = addr('a');
const BB = addr('c');
const nativeRow = (address: string, agentId: string): Doc => ({
  __id: nativeWalletAddressIndexId(address), schema_version: CANONICAL_NATIVE_ADDRESS_INDEX_SCHEMA,
  chain_id: 8453, address, wallet_id: `wallet_aw_${agentId}`, owner_type: 'agent', owner_id: agentId, created_at_ms: 1,
});

const CHAIN = relayObservationWitness(RELAY_WITNESS_CHAIN_WATCHER, 'eip155:8453');
const FORGE = relayObservationWitness(RELAY_WITNESS_FORGE_WEBHOOK, 'github_app');
const base = {
  economicActorId: 'atlas', walletAddress: null as string | null, peId: 'pe_1', nowMs: 1000,
  submissionWitness: null, witnessObservedTokens: null, bodyDeclaredTokens: null,
};

/** What generatePE does: normalize the sealed origins, key the emitter's derived set against them. */
function sealed(inputOrigins: InputOrigin[], derived: InputOrigin[], witness = CHAIN) {
  const norm = normalizeInputOrigins(inputOrigins) ?? [];
  return { inputOrigins: norm, relayWitnessedOrigins: relayWitnessedOriginsFor({ witness, derivedOrigins: derived }, norm) };
}

describe('relayWitnessedOriginsFor — the boundary', () => {
  it('keys ONLY derived origins actually sealed on the PE; a pe: origin is never relay-derived', () => {
    const w = chainWatcherWitness('eip155:8453');
    const counterparty = resolvableOrigin(`evm:${BOB}`, w);
    const notSealed = resolvableOrigin(`evm:${AA}`, w);
    const pe = { hash: 'sha256:x', origin_identifier: 'pe:pe_other', witnessed: false } as InputOrigin;
    const r = relayWitnessedOriginsFor({ witness: CHAIN, derivedOrigins: [counterparty, notSealed, pe] }, normalizeInputOrigins([counterparty, pe])!);
    expect(r).not.toBeNull();
    expect(r!.originKeys).toEqual([originKey(counterparty)]);
    expect(r!.witness).toEqual({ identity: 'relay:chain_watcher:eip155:8453', tier: null });
  });

  it('RED: no observation, an empty sealed set, or a non-relay witness identity → null (byte-identical path)', () => {
    const o = resolvableOrigin(`evm:${BOB}`);
    expect(relayWitnessedOriginsFor(null, [o])).toBeNull();
    expect(relayWitnessedOriginsFor({ witness: CHAIN, derivedOrigins: [o] }, [])).toBeNull();
    expect(relayWitnessedOriginsFor({ witness: { identity: 'atlas_daemon', tier: 'software' }, derivedOrigins: [o] }, [o])).toBeNull();
  });
});

describe('relay-composed lanes — the witnessed origins face the unchanged tests', () => {
  it('chain lane: the relay-derived counterparty OUTSIDE the identity set counts 1 (witnessed by the relay)', async () => {
    const w = chainWatcherWitness('eip155:8453');
    const cp = resolvableOrigin(`evm:${BOB}`, w);
    const settlement = resolvableOrigin('chaintx:eip155:8453:0xabc:0', w);
    const r = await resolveOriginPricingInputs(fakeDb(), cache, { ...base, walletAddress: SELF, ...sealed([cp, settlement], [cp, settlement]) }, unlinked);
    expect(r.independentOriginCount).toBe(1);
    const c = r.origins.find((o) => o.origin_identifier === `evm:${BOB}`)!;
    expect(c).toMatchObject({ witnessed: true, counted: true, witness: { identity: 'relay:chain_watcher:eip155:8453', tier: null } });
    // the settlement is witnessed too, but a chaintx identifier has no owner → counts 0
    expect(r.origins.find((o) => o.origin_identifier.startsWith('chaintx:'))!).toMatchObject({ witnessed: true, counted: false });
  });

  it('RED — the SAME origins with no relay observation (today\'s behavior) → count 0, unwitnessed', async () => {
    const cp = resolvableOrigin(`evm:${BOB}`, chainWatcherWitness('eip155:8453'));
    const r = await resolveOriginPricingInputs(fakeDb(), cache, { ...base, walletAddress: SELF, inputOrigins: [cp] }, unlinked);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0]).toMatchObject({ witnessed: false, reason: 'unwitnessed' });
  });

  it('RED — same-party control: the counterparty is the signer\'s own address → witnessed but same_party, count 0', async () => {
    const cp = resolvableOrigin(`evm:${SELF}`, chainWatcherWitness('eip155:8453'));
    const r = await resolveOriginPricingInputs(fakeDb(), cache, { ...base, walletAddress: SELF, ...sealed([cp], [cp]) }, unlinked);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party' });
  });

  it('forge lane: the relay-derived repo owned by someone else counts 1; the forge host URL and a unioned device origin do NOT', async () => {
    const fw = forgeWebhookWitness('github_app');
    const repo = resolvableOrigin('repo:someone-else/project', fw);
    const parent = resolvableOrigin('commit:' + 'a'.repeat(40), fw);
    const host = resolvableOrigin('domain:github.com', fw);        // forge's own URL host — NOT derived
    const deviceUnion = resolvableOrigin('domain:example.org', { type: 'observer_device', identity: 'dev_1' }); // actor-reported
    const pathHash = privateOrigin('private_url_path', 'https://github.com/x/y/commit/z', fw);
    const r = await resolveOriginPricingInputs(fakeDb(), cache, {
      ...base, ...sealed([repo, parent, host, pathHash, deviceUnion], [repo, parent], FORGE),
    }, unlinked);
    expect(r.independentOriginCount).toBe(1);
    expect(r.origins.find((o) => o.origin_identifier === 'repo:someone-else/project')).toMatchObject({ witnessed: true, counted: true, owner: 'repo-owner:someone-else' });
    expect(r.origins.find((o) => o.origin_identifier === 'domain:github.com')).toMatchObject({ witnessed: false, counted: false });
    expect(r.origins.find((o) => o.origin_identifier === 'domain:example.org')).toMatchObject({ witnessed: false, counted: false });
  });

  it('RED — forge same-party control: a push to the signer\'s OWN repo (its forge login is in its identity set) → witnessed but same_party, 0', async () => {
    const fw = forgeWebhookWitness('github_app');
    const repo = resolvableOrigin('repo:atlas-login/project', fw);
    const db = fakeDb({ service_installs: [{ __id: 'inst_1', user_id: 'atlas', provider: 'github', forge_account_login: 'atlas-login' }] });
    const r = await resolveOriginPricingInputs(db, cache, { ...base, ...sealed([repo], [repo], FORGE) }, unlinked);
    expect(r.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
    expect(r.independentOriginCount).toBe(0);
  });

  it('forge same-party in PRODUCTION shape: installs are keyed by the WALLET DOC id, the PE actor by user/agent id — own repo is still same_party, 0', async () => {
    const fw = forgeWebhookWitness('github_app');
    // human: actor user_alice, wallet doc wallet_alice, install keyed wallet_alice
    const human = fakeDb({
      wallets: [{ __id: 'wallet_alice', user_id: 'user_alice', type: 'human' }],
      service_installs: [{ __id: 'inst_h', user_id: 'wallet_alice', provider: 'github', forge_account_login: 'alice' }],
    });
    const own = resolvableOrigin('repo:alice/project', fw);
    const rh = await resolveOriginPricingInputs(human, cache, { ...base, economicActorId: 'user_alice', ...sealed([own], [own], FORGE) }, unlinked);
    expect(rh.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
    expect(rh.independentOriginCount).toBe(0);
    // agent: actor aw_bot, agent wallet doc wallet_aw_bot, install keyed wallet_aw_bot
    const agent = fakeDb({
      agent_wallets: [{ __id: 'wallet_aw_bot', agent_id: 'aw_bot' }],
      service_installs: [{ __id: 'inst_a', user_id: 'wallet_aw_bot', provider: 'github', forge_account_login: 'botlogin' }],
    });
    const ownBot = resolvableOrigin('repo:botlogin/tool', fw);
    const ra = await resolveOriginPricingInputs(agent, cache, { ...base, economicActorId: 'aw_bot', ...sealed([ownBot], [ownBot], FORGE) }, unlinked);
    expect(ra.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
    // linked agent pushing to its HUMAN's repo: the human's install (keyed by the human's wallet doc) is same-party
    const linked = fakeDb({
      wallets: [{ __id: 'wallet_alice', user_id: 'user_alice', type: 'human' }],
      service_installs: [{ __id: 'inst_h', user_id: 'wallet_alice', provider: 'github', forge_account_login: 'alice' }],
    });
    const linkedTo = async (): Promise<BeneficiaryCacheEntry> => ({ linked: true, humanWalletId: 'wallet_alice', humanUserId: 'user_alice', humanAddress: null, agentShareBps: 2000 } as BeneficiaryCacheEntry);
    const rl = await resolveOriginPricingInputs(linked, cache, { ...base, economicActorId: 'aw_bot', ...sealed([own], [own], FORGE) }, linkedTo);
    expect(rl.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
  });

  it('forge same-party through the relationship: a SIBLING agent\'s install, and a human signer\'s own agent\'s install, are same_party', async () => {
    const fw = forgeWebhookWitness('github_app');
    const db = fakeDb({
      wallets: [{ __id: 'wallet_h', user_id: 'user_h', type: 'human' }],
      agent_wallets: [
        { __id: 'wallet_aw_A', agent_id: 'agent_A', linked_human_user_id: 'user_h' },
        { __id: 'wallet_aw_B', agent_id: 'agent_B', linked_human_user_id: 'user_h' },
      ],
      service_installs: [{ __id: 'inst_b', user_id: 'wallet_aw_B', provider: 'github', forge_account_login: 'b-bot' }],
    });
    const bRepo = resolvableOrigin('repo:b-bot/tool', fw);
    const linkedToH = async (): Promise<BeneficiaryCacheEntry> => ({ linked: true, humanWalletId: 'wallet_h', humanUserId: 'user_h', humanAddress: null, agentShareBps: 2000 } as BeneficiaryCacheEntry);
    const ra = await resolveOriginPricingInputs(db, cache, { ...base, economicActorId: 'agent_A', ...sealed([bRepo], [bRepo], FORGE) }, linkedToH);
    expect(ra.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
    // the human itself pushing to its agent B's repo
    const rh = await resolveOriginPricingInputs(db, cache, { ...base, economicActorId: 'user_h', ...sealed([bRepo], [bRepo], FORGE) }, unlinked);
    expect(rh.origins[0]).toMatchObject({ witnessed: true, reason: 'same_party', counted: false });
  });

  it('RED — the production-shape control counts a repo owned by SOMEONE ELSE (the fix is scoped to the signer\'s own installs)', async () => {
    const fw = forgeWebhookWitness('github_app');
    const db = fakeDb({
      wallets: [{ __id: 'wallet_alice', user_id: 'user_alice', type: 'human' }, { __id: 'wallet_carol', user_id: 'user_carol', type: 'human' }],
      service_installs: [
        { __id: 'inst_h', user_id: 'wallet_alice', provider: 'github', forge_account_login: 'alice' },
        { __id: 'inst_c', user_id: 'wallet_carol', provider: 'github', forge_account_login: 'carol' },
      ],
    });
    const carolRepo = resolvableOrigin('repo:carol/lib', fw);
    const r = await resolveOriginPricingInputs(db, cache, { ...base, economicActorId: 'user_alice', ...sealed([carolRepo], [carolRepo], FORGE) }, unlinked);
    expect(r.origins[0]).toMatchObject({ witnessed: true, counted: true });
    expect(r.independentOriginCount).toBe(1);
  });

  it('RED — a closed ring built through a relay-composed (chain) lane is flagged closed_loop and adds 0', async () => {
    const db = fakeDb({
      [NATIVE_WALLET_ADDRESS_INDEX_COLLECTION]: [nativeRow(AA, 'atlas'), nativeRow(BB, 'sibling')],
      [ORIGIN_REFERENCE_GRAPH_COLLECTION]: [{ __id: 'edge_hist', signer: 'sibling', owner: `evm:${AA}`, counted: true }],
    });
    const cp = resolvableOrigin(`evm:${BB}`, chainWatcherWitness('eip155:8453'));
    const r = await resolveOriginPricingInputs(db, cache, { ...base, walletAddress: AA, ...sealed([cp], [cp]) }, unlinked);
    expect(r.origins[0]).toMatchObject({ witnessed: true, reason: 'closed_loop', counted: false });
    expect(r.independentOriginCount).toBe(0);
  });
});
