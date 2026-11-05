/**
 * work package O7 — wants board + want→fulfiller match tests.
 *
 * Harness: a compact in-memory Firestore fake (supporting exactly the query shapes
 * `wants.ts` issues), with a `runTransaction` that delegates to the same store so the
 * fulfil/cancel ownership guards run for real. The want board records plain documents
 * (no PE — see wants.ts header), so no generatePE mock is needed.
 *
 * negative controls are marked `[ control]`. Each was proven RED by mutation
 * (verified in the session log): the zero-overlap gate, the self-fulfil guard, the
 * budget-fit gate, and the linked-job ownership guard each fail when removed. Every match
 * assertion first asserts `candidates_considered > 0` so no exclusion claim passes
 * vacuously over an empty set.
 */

import type { AgentBankDeps } from '../agent-bank/types';

import { TEST_WINDOW } from './__test-helpers__/speech';
import {
  postWant as postWantRaw,
  browseWants,
  getWant,
  matchWant,
  fulfillWant,
  cancelWant,
  scoreFulfiller,
  COMMONS_WANTS_COLLECTION,
  type WantDocument,
} from './wants';
import type { AgentDirectoryDocument } from '../agent-bank/types';
import { METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from '../meter/meter-relay-authored';
const postWant = (deps: Parameters<typeof postWantRaw>[0], poster: Parameters<typeof postWantRaw>[1], input: Parameters<typeof postWantRaw>[2]) => postWantRaw(deps, poster, input, TEST_WINDOW);

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;

function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}

class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get(): Promise<{ exists: boolean; id: string; data: () => Row | undefined }> {
    const row = coll(this.store, this.collection).get(this.id);
    return { exists: row !== undefined, id: this.id, data: () => (row ? { ...row } : undefined) };
  }
  set(data: Row, opts?: { merge?: boolean }): void {
    const c = coll(this.store, this.collection);
    if (opts?.merge) c.set(this.id, { ...(c.get(this.id) ?? {}), ...data });
    else c.set(this.id, { ...data });
  }
  create(data: Row): void {
    const c = coll(this.store, this.collection);
    if (c.has(this.id)) { const e = new Error('ALREADY_EXISTS') as Error & { code: number }; e.code = 6; throw e; }
    c.set(this.id, { ...data });
  }
}

interface Constraint {
  kind: 'where' | 'order' | 'startAfter' | 'limit';
  field?: string | { _documentId: true };
  op?: string;
  value?: unknown;
  dir?: 'asc' | 'desc';
  values?: unknown[];
  n?: number;
}

class FakeQuery {
  constructor(private store: Store, private collection: string, private constraints: Constraint[] = []) {}
  private add(c: Constraint): FakeQuery {
    return new FakeQuery(this.store, this.collection, [...this.constraints, c]);
  }
  where(field: string, op: string, value: unknown): FakeQuery {
    return this.add({ kind: 'where', field, op, value });
  }
  orderBy(field: string | { _documentId: true }, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return this.add({ kind: 'order', field, dir });
  }
  startAfter(...values: unknown[]): FakeQuery {
    return this.add({ kind: 'startAfter', values });
  }
  limit(n: number): FakeQuery {
    return this.add({ kind: 'limit', n });
  }
  async get(): Promise<{ docs: { id: string; data: () => Row }[] }> {
    const c = coll(this.store, this.collection);
    let rows = [...c.entries()].map(([id, data]) => ({ id, data }));
    for (const con of this.constraints) {
      if (con.kind === 'where') {
        const f = con.field as string;
        rows = rows.filter(({ data }) => {
          const v = data[f];
          if (con.op === '==') return v === con.value;
          if (con.op === 'array-contains') return Array.isArray(v) && v.includes(con.value);
          if (con.op === 'array-contains-any') {
            return Array.isArray(v) && Array.isArray(con.value)
              && (con.value as unknown[]).some((x) => v.includes(x));
          }
          if (con.op === '>=') return typeof v === 'number' && typeof con.value === 'number' && v >= con.value;
          return true;
        });
      }
    }
    const orders = this.constraints.filter((c2) => c2.kind === 'order');
    if (orders.length > 0) {
      rows.sort((a, b) => {
        for (const o of orders) {
          const isDocId = typeof o.field !== 'string';
          const av = isDocId ? a.id : a.data[o.field as string];
          const bv = isDocId ? b.id : b.data[o.field as string];
          let cmp = 0;
          if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
          else cmp = String(av).localeCompare(String(bv));
          if (o.dir === 'desc') cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }
    const sa = this.constraints.find((c2) => c2.kind === 'startAfter');
    if (sa && sa.values && orders.length > 0) {
      const [cursorCreated, cursorId] = sa.values as [number, string];
      const idx = rows.findIndex((r) => r.id === cursorId
        && (r.data.created_at as number) === cursorCreated);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    const lim = this.constraints.find((c2) => c2.kind === 'limit');
    if (lim && typeof lim.n === 'number') rows = rows.slice(0, lim.n);
    return { docs: rows.map((r) => ({ id: r.id, data: () => ({ ...r.data }) })) };
  }
}

class FakeCollection {
  constructor(private store: Store, private name: string) {}
  doc(id: string): FakeDocRef { return new FakeDocRef(this.store, this.name, id); }
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.name).where(field, op, value);
  }
  orderBy(field: string | { _documentId: true }, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store, this.name).orderBy(field, dir);
  }
}

// FieldPath.documentId() shim so browseWants' dynamic import resolves in-test.
jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => ({ _documentId: true }) },
  // PE METER: the relay-act intake generatePE stages carries a Timestamp TTL (`expire_at`).
  Timestamp: { fromMillis: (ms: number) => ({ _millis: ms }) },
}));

// A transaction whose get/set/create/update delegate to the shared fake store. No real
// isolation/retry is needed for these unit tests (reads-before-writes is exercised by
// the code under test, not enforced by the fake).
function makeTxn() {
  return {
    get: (ref: FakeDocRef) => ref.get(),
    set: (ref: FakeDocRef, data: Row, opts?: { merge?: boolean }) => ref.set(data, opts),
    create: (ref: FakeDocRef, data: Row) => ref.create(data),
    update: (ref: FakeDocRef, data: Row) => ref.set(data, { merge: true }),
  };
}

function makeDeps(store: Store): AgentBankDeps {
  return {
    db: {
      collection: (name: string) => new FakeCollection(store, name),
      runTransaction: async (fn: (txn: ReturnType<typeof makeTxn>) => Promise<unknown>) => fn(makeTxn()),
    } as unknown as AgentBankDeps['db'],
    cache: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }) } as unknown as AgentBankDeps['cache'],
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn().mockResolvedValue(undefined),
  };
}

const POSTER = { walletId: 'wallet_h1', isAgent: false };

function seedFulfiller(store: Store, id: string, over: Partial<Row> = {}): void {
  coll(store, 'agent_directory').set(id, {
    wallet_id: id,
    agent_id: id,
    display_name: id,
    address: `0x${id}`,
    capabilities: ['code-review'],
    availability: 'available',
    governance_score: 80,
    pe_count: 40,
    preferred_chains: ['base'],
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Validation + post
// ---------------------------------------------------------------------------

describe('postWant validation', () => {
  it('posts a valid want under a live window and seals it as a `want_posted` speech PE ', async () => {
    const store: Store = new Map();
    const deps = makeDeps(store);
    const view = await postWant(deps, POSTER, { outcome: 'need a code review', capabilities: ['Code-Review', 'code-review'] });
    expect(view.status).toBe('open');
    expect(view.capabilities).toEqual(['code-review']); // deduped + lowercased
    expect(view.want_id).toMatch(/^want_/);
    // durably persisted as a want doc AND a PE in the poster's chain (the want IS speech)
    const stored = coll(store, COMMONS_WANTS_COLLECTION).get(view.want_id) as unknown as WantDocument;
    expect(stored.outcome).toBe('need a code review');
    expect(view.pe_id).toBeTruthy();
    // PE METER: the relay keeps no readable PE; the act is staged in the poster's chain-tip
    // transaction as its intake (the stub accrual never prices it), and the tip advanced to it.
    expect(store.has('provenance_envelopes')).toBe(false);
    const intake = coll(store, METER_RELAY_ACTS_COLLECTION).get(view.pe_id ?? '') as unknown as RelayActIntake | undefined;
    expect(intake?.act.action_type).toBe('want_posted');
    expect(intake?.actor_id).toBe(POSTER.walletId);
    expect(intake?.act.pe_hash).toBe(coll(store, 'pe_chain_tips').get(POSTER.walletId)?.hash);
  });

  it('rejects empty outcome / empty capabilities / bad budget / past expiry', async () => {
    const store: Store = new Map();
    const deps = makeDeps(store);
    await expect(postWant(deps, POSTER, { outcome: '  ', capabilities: ['x'] })).rejects.toThrow('outcome_required');
    await expect(postWant(deps, POSTER, { outcome: 'x', capabilities: [] })).rejects.toThrow('capabilities_required');
    await expect(postWant(deps, POSTER, { outcome: 'x', capabilities: ['a'], budgetMaxPvt: '1.5' })).rejects.toThrow('budget_max_pvt_invalid');
    await expect(postWant(deps, POSTER, { outcome: 'x', capabilities: ['a'], expiry: 1 })).rejects.toThrow('expiry_in_past');
  });
});

// ---------------------------------------------------------------------------
// Browse + expiry projection
// ---------------------------------------------------------------------------

describe('browseWants', () => {
  it('keeps a marked test want in storage but removes it from browse and direct lookup', async () => {
    const store: Store = new Map();
    const wanted = {
      poster_wallet_id: 'wallet_h1', poster_type: 'human', outcome: 'test', capabilities: ['test'],
      budget_max_pvt: null, budget_max_usdc: null, preferred_chains: [], expiry: null,
      status: 'open', matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: 2, updated_at: 2, pe_id: 'pe_test',
    };
    coll(store, COMMONS_WANTS_COLLECTION).set('want_test', {
      ...wanted, want_id: 'want_test', public_visibility: 'hidden_prelaunch_test',
    });
    coll(store, COMMONS_WANTS_COLLECTION).set('want_public', { ...wanted, want_id: 'want_public', created_at: 1 });
    const deps = makeDeps(store);
    expect((await browseWants(deps, {})).items.map(w => w.want_id)).toEqual(['want_public']);
    await expect(getWant(deps, 'want_test')).rejects.toThrow('want_not_found');
    expect(coll(store, COMMONS_WANTS_COLLECTION).get('want_test')).toMatchObject({ pe_id: 'pe_test' });
  });

  it('projects an open, past-expiry want as expired without a write', async () => {
    const store: Store = new Map();
    const now = Date.now();
    coll(store, COMMONS_WANTS_COLLECTION).set('want_x', {
      want_id: 'want_x', poster_wallet_id: 'wallet_h1', poster_type: 'human',
      outcome: 'o', capabilities: ['a'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: now - 1000, status: 'open',
      matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: now - 5000, updated_at: now - 5000, pe_id: 'pe_x',
    });
    const deps = makeDeps(store);
    const page = await browseWants(deps, {});
    expect(page.items[0].status).toBe('expired');
    // stored doc unchanged (projection only)
    expect((coll(store, COMMONS_WANTS_COLLECTION).get('want_x') as unknown as WantDocument).status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// matchWant — the centrepiece
// ---------------------------------------------------------------------------

describe('matchWant', () => {
  async function seedOpenWant(store: Store, over: Partial<WantDocument> = {}): Promise<string> {
    const now = Date.now();
    const id = 'want_match';
    coll(store, COMMONS_WANTS_COLLECTION).set(id, {
      want_id: id, poster_wallet_id: POSTER.walletId, poster_type: 'human',
      outcome: 'o', capabilities: ['code-review'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: null, status: 'open',
      matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: now, updated_at: now, pe_id: 'pe_seed', ...over,
    });
    return id;
  }

  it('ranks overlapping fulfillers and returns a score breakdown', async () => {
    const store: Store = new Map();
    const id = await seedOpenWant(store);
    seedFulfiller(store, 'f_strong', { governance_score: 90, pe_count: 60, availability: 'available' });
    seedFulfiller(store, 'f_weak', { governance_score: 10, pe_count: 2, availability: 'busy' });
    const deps = makeDeps(store);
    const result = await matchWant(deps, id);
    expect(result.candidates_considered).toBeGreaterThan(0); // non-vacuous
    expect(result.matches.map((m) => m.wallet_id)).toEqual(['f_strong', 'f_weak']);
    expect(result.matches[0].breakdown.capability_overlap).toBe(1);
    expect(result.matches[0].score).toBeGreaterThan(result.matches[1].score);
  });

  it('[ control] scoreFulfiller returns null for a ZERO-overlap fulfiller', () => {
    // Tested on the pure function because the branch is unreachable through matchWant
    // (the array-contains-any probe never returns a zero-overlap doc). Proven RED by
    // mutation: replacing `if (matched.length === 0) return null;` with `return`-less
    // makes this return a FulfillerMatch and the test fails.
    const want: WantDocument = {
      want_id: 'w', poster_wallet_id: 'p', poster_type: 'human', outcome: 'o',
      capabilities: ['code-review'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: null, status: 'open',
      matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: 0, updated_at: 0,
    };
    const overlapping = { wallet_id: 'a', agent_id: 'a', display_name: 'a', address: '0xa', capabilities: ['code-review'], availability: 'available', governance_score: 1, pe_count: 1, preferred_chains: [] } as unknown as AgentDirectoryDocument;
    const nonOverlapping = { ...overlapping, wallet_id: 'b', capabilities: ['gardening'] } as unknown as AgentDirectoryDocument;
    expect(scoreFulfiller(want, overlapping)).not.toBeNull();
    expect(scoreFulfiller(want, nonOverlapping)).toBeNull();
  });

  it('[ control] EXCLUDES the poster from its own want matches (no self-fulfilment)', async () => {
    const store: Store = new Map();
    const id = await seedOpenWant(store);
    // poster ALSO has a directory entry with a matching capability
    seedFulfiller(store, POSTER.walletId, { capabilities: ['code-review'] });
    seedFulfiller(store, 'f_other', { capabilities: ['code-review'] });
    const deps = makeDeps(store);
    const result = await matchWant(deps, id);
    expect(result.candidates_considered).toBeGreaterThan(0); // non-vacuous
    expect(result.matches.some((m) => m.wallet_id === POSTER.walletId)).toBe(false);
    expect(result.matches.some((m) => m.wallet_id === 'f_other')).toBe(true);
  });

  it('[ control] a fulfiller whose PVT rate EXCEEDS the budget scores budget_fit 0', async () => {
    const store: Store = new Map();
    const id = await seedOpenWant(store, { budget_max_pvt: (10n * 10n ** 18n).toString() });
    seedFulfiller(store, 'f_cheap', { hourly_rate_pvt: (5n * 10n ** 18n).toString() });
    seedFulfiller(store, 'f_dear', { hourly_rate_pvt: (50n * 10n ** 18n).toString() });
    const deps = makeDeps(store);
    const result = await matchWant(deps, id);
    const cheap = result.matches.find((m) => m.wallet_id === 'f_cheap');
    const dear = result.matches.find((m) => m.wallet_id === 'f_dear');
    expect(cheap?.breakdown.budget_fit).toBe(1);
    expect(dear?.breakdown.budget_fit).toBe(0);
  });

  it('returns no matches for a closed/expired want (status carries the reason)', async () => {
    const store: Store = new Map();
    const id = await seedOpenWant(store, { status: 'cancelled' });
    seedFulfiller(store, 'f_any');
    const deps = makeDeps(store);
    const result = await matchWant(deps, id);
    expect(result.status).toBe('cancelled');
    expect(result.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fulfill + cancel guards
// ---------------------------------------------------------------------------

describe('fulfillWant guards', () => {
  function seedWant(store: Store, over: Partial<WantDocument> = {}): string {
    const now = Date.now();
    const id = 'want_f';
    coll(store, COMMONS_WANTS_COLLECTION).set(id, {
      want_id: id, poster_wallet_id: POSTER.walletId, poster_type: 'human',
      outcome: 'o', capabilities: ['a'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: null, status: 'open',
      matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: now, updated_at: now, pe_id: 'pe_seed', ...over,
    });
    return id;
  }

  it('links a poster-owned job and marks the want fulfilled', async () => {
    const store: Store = new Map();
    const id = seedWant(store);
    coll(store, 'jobs').set('job_1', { poster_wallet_id: POSTER.walletId });
    const deps = makeDeps(store);
    const view = await fulfillWant(deps, id, POSTER, { fulfillerWalletId: 'f_1', linkedJobId: 'job_1' });
    expect(view.status).toBe('fulfilled');
    expect(view.linked_job_id).toBe('job_1');
  });

  it('[ control] rejects linking a job NOT owned by the poster', async () => {
    const store: Store = new Map();
    const id = seedWant(store);
    coll(store, 'jobs').set('job_other', { poster_wallet_id: 'someone_else' });
    const deps = makeDeps(store);
    await expect(
      fulfillWant(deps, id, POSTER, { fulfillerWalletId: 'f_1', linkedJobId: 'job_other' }),
    ).rejects.toThrow('linked_job_not_owned');
    // want NOT mutated
    expect((coll(store, COMMONS_WANTS_COLLECTION).get(id) as unknown as WantDocument).status).toBe('open');
  });

  it('rejects fulfilling a want owned by someone else (precondition guard)', async () => {
    const store: Store = new Map();
    const id = seedWant(store, { poster_wallet_id: 'other_owner' });
    coll(store, 'jobs').set('job_1', { poster_wallet_id: POSTER.walletId });
    const deps = makeDeps(store);
    await expect(
      fulfillWant(deps, id, POSTER, { fulfillerWalletId: 'f_1', linkedJobId: 'job_1' }),
    ).rejects.toThrow('want_not_owned');
  });

  it('rejects self as fulfiller', async () => {
    const store: Store = new Map();
    const id = seedWant(store);
    coll(store, 'jobs').set('job_1', { poster_wallet_id: POSTER.walletId });
    const deps = makeDeps(store);
    await expect(
      fulfillWant(deps, id, POSTER, { fulfillerWalletId: POSTER.walletId, linkedJobId: 'job_1' }),
    ).rejects.toThrow('cannot_fulfill_own_want');
  });
});

describe('cancelWant guards', () => {
  it('cancels an open want (poster)', async () => {
    const store: Store = new Map();
    const now = Date.now();
    coll(store, COMMONS_WANTS_COLLECTION).set('want_c', {
      want_id: 'want_c', poster_wallet_id: POSTER.walletId, poster_type: 'human',
      outcome: 'o', capabilities: ['a'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: null, status: 'open',
      matched_fulfiller_wallet_id: null, linked_job_id: null,
      created_at: now, updated_at: now, pe_id: 'pe_seed',
    });
    const deps = makeDeps(store);
    const view = await cancelWant(deps, 'want_c', POSTER);
    expect(view.status).toBe('cancelled');
  });

  it('rejects cancelling a fulfilled want', async () => {
    const store: Store = new Map();
    const now = Date.now();
    coll(store, COMMONS_WANTS_COLLECTION).set('want_c', {
      want_id: 'want_c', poster_wallet_id: POSTER.walletId, poster_type: 'human',
      outcome: 'o', capabilities: ['a'], budget_max_pvt: null, budget_max_usdc: null,
      preferred_chains: [], expiry: null, status: 'fulfilled',
      matched_fulfiller_wallet_id: 'f', linked_job_id: 'job', created_at: now, updated_at: now, pe_id: 'pe',
    });
    const deps = makeDeps(store);
    await expect(cancelWant(deps, 'want_c', POSTER)).rejects.toThrow('want_already_fulfilled');
  });
});
