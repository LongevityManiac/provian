/**
 * The in-memory deps the forge-witness suites (GitHub / GitLab / Bitbucket webhooks, GitHub
 * connect) share.
 *
 * PE METER : `generatePE` no longer enqueues a readable PE or writes
 * `provenance_envelopes` / `pe_history`. It stages a transient intake (`meter_relay_acts_v1`) in
 * the chain-tip transaction — the act record (identity + pe_hash + the PE's pricing projection) —
 * and prices it through `recordPEAccrual` with a `meter` context. This fake observes exactly that:
 *
 * - `staged` lists every intake the relay committed, with `pe` = the act record's identity +
 * pricing projection (metadata, wallet_id, attestation_type, …) — what the relay keeps;
 * - the fake accrual mirrors the REAL meter commit's output for a priced act: the 31-day act key
 * (`meter_act_keys_v1/{pe_id}`) built by the shared, contract-pinned `makeMeterActKeyDoc`, whose
 * row carries `commit_sha` so a later witness finds the act by commit exactly as production
 * does (`findPEsByCommitSha` reads `row.commit_sha`).
 *
 * Writes follow Firestore semantics the code under test relies on: `set(…, { merge: true })` deep-
 * merges nested maps, and `update` applies dotted field paths (`row.corroboration_status`).
 */
import { makeMeterActKeyDoc } from '../../../__test-helpers__/pe-doc-fixtures';
import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import { METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from '../../meter/meter-relay-authored';

type Doc = Record<string, unknown>;

export interface WitnessDocSnap {
  exists: boolean;
  id: string;
  data: () => Doc | undefined;
}

export interface WitnessFakeRef {
  readonly path: string;
  get(): Promise<WitnessDocSnap>;
  set(value: Doc, opts?: { merge?: boolean }): Promise<void>;
  update(patch: Doc): Promise<void>;
  delete(): Promise<void>;
}

export interface WitnessStagedAct {
  readonly peId: string;
  /** The act record's identity + pricing projection (what the relay keeps of the PE). */
  readonly pe: Doc;
  readonly intake: RelayActIntake;
}

export interface WitnessFakeTxn {
  get(ref: WitnessFakeRef): Promise<WitnessDocSnap>;
  set(ref: WitnessFakeRef, value: Doc, opts?: { merge?: boolean }): Promise<void>;
  update(ref: WitnessFakeRef, patch: Doc): Promise<void>;
  create(ref: WitnessFakeRef, value: Doc): Promise<void>;
  delete(ref: WitnessFakeRef): Promise<void>;
}

function isMap(value: unknown): value is Doc {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Doc, patch: Doc): Doc {
  const out: Doc = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isMap(v) && isMap(out[k]) ? deepMerge(out[k] as Doc, v) : v;
  }
  return out;
}

function applyDottedUpdate(base: Doc, patch: Doc): Doc {
  const out: Doc = { ...base };
  for (const [path, value] of Object.entries(patch)) {
    const segs = path.split('.');
    let cur: Doc = out;
    for (const seg of segs.slice(0, -1)) {
      cur[seg] = isMap(cur[seg]) ? { ...(cur[seg] as Doc) } : {};
      cur = cur[seg] as Doc;
    }
    cur[segs[segs.length - 1]] = value;
  }
  return out;
}

/** The view of a staged act a witness suite asserts on: identity + the PE's pricing projection. */
export function stagedActView(intake: RelayActIntake): Doc {
  return {
    ...intake.act.pricing,
    pe_id: intake.pe_id,
    action_type: intake.act.action_type,
    prev_hash: intake.act.prev_hash,
    timestamp: intake.act.timestamp,
    pe_hash: intake.act.pe_hash,
    actor_id: intake.actor_id,
  };
}

export function makeWitnessFakeDeps(): {
  deps: {
    db: { collection(name: string): unknown; runTransaction<T>(fn: (tx: WitnessFakeTxn) => Promise<T>): Promise<T> };
    peBuffer: { enqueue(): void };
    recordPEAccrual(params: Doc): Promise<void>;
  };
  store: Map<string, Map<string, Doc>>;
  enqueued: WitnessStagedAct[];
} {
  const store: Map<string, Map<string, Doc>> = new Map();
  const enqueued: WitnessStagedAct[] = [];
  const docsOf = (name: string): Map<string, Doc> => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };

  function collectionApi(name: string) {
    const docs = docsOf(name);
    return {
      doc: (id: string): WitnessFakeRef => ({
        path: `${name}/${id}`,
        async get() {
          return { exists: docs.has(id), id, data: () => docs.get(id) };
        },
        async set(value: Doc, opts?: { merge?: boolean }) {
          docs.set(id, opts?.merge ? deepMerge(docs.get(id) ?? {}, value) : value);
          if (name === METER_RELAY_ACTS_COLLECTION) {
            const intake = value as unknown as RelayActIntake;
            enqueued.push({ peId: intake.pe_id, pe: stagedActView(intake), intake });
          }
        },
        async update(patch: Doc) {
          docs.set(id, applyDottedUpdate(docs.get(id) ?? {}, patch));
        },
        async delete() {
          docs.delete(id);
        },
      }),
      where: (path: string, _op: string, value: unknown) => ({
        async get() {
          const out: WitnessDocSnap[] = [];
          for (const [id, v] of docs) {
            let cur: unknown = v;
            for (const seg of path.split('.')) {
              if (isMap(cur) && seg in cur) cur = cur[seg];
              else { cur = undefined; break; }
            }
            if (cur === value) out.push({ exists: true, id, data: () => v });
          }
          return { empty: out.length === 0, docs: out };
        },
      }),
    };
  }

  docsOf('pe_chain_tips');

  const db = {
    collection: (name: string) => collectionApi(name),
    // Simple non-isolating mock - fine for unit tests.
    runTransaction: async <T>(fn: (tx: WitnessFakeTxn) => Promise<T>): Promise<T> => fn({
      get: async (ref) => ref.get(),
      set: async (ref, value, opts) => ref.set(value, opts),
      update: async (ref, patch) => ref.update(patch),
      // Duplicate semantics are covered by the suites that run the faithful fake.
      create: async (ref, value) => ref.set(value),
      delete: async (ref) => ref.delete(),
    }),
  };

  const deps = {
    db,
    // The relay never enqueues a readable PE any more; a call here is a regression.
    peBuffer: { enqueue: () => { throw new Error('a readable PE was enqueued'); } },
    recordPEAccrual: async (params: Doc) => {
      const meter = params.meter as { prevHash?: unknown } | undefined;
      if (!meter) return;
      const peId = String(params.peId);
      docsOf(METER_ACT_KEYS_COLLECTION).set(peId, makeMeterActKeyDoc({
        peId,
        actorId: String(params.userId),
        peHash: String(params.peHash),
        actionType: String(params.actionType),
        prevHash: typeof meter.prevHash === 'string' ? meter.prevHash : undefined,
        timestamp: typeof params.timestamp === 'number' ? params.timestamp : undefined,
        commitSha: typeof params.commitSha === 'string' ? params.commitSha : null,
      }));
    },
  };

  return { deps, store, enqueued };
}
