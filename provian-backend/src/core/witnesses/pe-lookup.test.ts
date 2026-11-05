/**
 * pe-lookup tests. Asserts findPEsByCommitSha queries metadata.commit_sha
 * (the canonical nesting that generatePE emits - see
 * core/agent-bank/pe-utils.ts:103-114 which writes `metadata` at the PE
 * top level, not under `action_report.metadata`).
 */

import { findPEsByCommitSha } from './pe-lookup';

interface DocSnap {
  exists: boolean;
  id: string;
  data: () => unknown;
}

function makeFakeDb(): { db: any; store: Map<string, Map<string, Record<string, unknown>>> } {
  const store: Map<string, Map<string, Record<string, unknown>>> = new Map();

  function collectionApi(name: string) {
    if (!store.has(name)) store.set(name, new Map());
    const docs = store.get(name)!;
    return {
      where: (path: string, _op: string, value: unknown) => ({
        async get() {
          const out: DocSnap[] = [];
          for (const [id, v] of docs) {
            let cur: unknown = v;
            for (const seg of path.split('.')) {
              if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
                cur = (cur as Record<string, unknown>)[seg];
              } else {
                cur = undefined;
                break;
              }
            }
            if (cur === value) {
              out.push({ exists: true, id, data: () => v });
            }
          }
          return { docs: out };
        },
      }),
    };
  }

  const db = {
    collection: (name: string) => collectionApi(name),
  };
  return { db, store };
}

function seedPE(
  store: Map<string, Map<string, Record<string, unknown>>>,
  id: string,
  pe: Record<string, unknown>,
): void {
  // findPEsByCommitSha reads the IMMUTABLE envelope store (the only collection
  // carrying metadata.commit_sha + the canonical hash), not pe_history.
  if (!store.has('provenance_envelopes')) store.set('provenance_envelopes', new Map());
  store.get('provenance_envelopes')!.set(id, pe);
}

describe('findPEsByCommitSha', () => {
  it('returns empty array for empty commit hash', async () => {
    const { db } = makeFakeDb();
    const result = await findPEsByCommitSha(db, '');
    expect(result).toEqual([]);
  });

  it('returns matching PEs by metadata.commit_sha (generatePE nesting)', async () => {
    const { db, store } = makeFakeDb();
    seedPE(store, 'pe_match_1', {
      user_id: 'user_1',
      metadata: { commit_sha: 'abc123' },
    });
    seedPE(store, 'pe_match_2', {
      user_id: 'user_2',
      metadata: { commit_sha: 'abc123' },
    });
    seedPE(store, 'pe_other', {
      user_id: 'user_3',
      metadata: { commit_sha: 'deadbeef' },
    });

    const matches = await findPEsByCommitSha(db, 'abc123');
    expect(matches).toHaveLength(2);
    const ids = matches.map((m) => m.envelopeId).sort();
    expect(ids).toEqual(['pe_match_1', 'pe_match_2']);
    const users = matches.map((m) => m.userId).sort();
    expect(users).toEqual(['user_1', 'user_2']);
  });

  it('returns the canonical hash + agent_id from the envelope (no second read needed)', async () => {
    const { db, store } = makeFakeDb();
    seedPE(store, 'pe_full', {
      user_id: 'user_1',
      agent_id: 'agent_1',
      hash: 'realhash',
      metadata: { commit_sha: 'abc123' },
    });
    const matches = await findPEsByCommitSha(db, 'abc123');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      envelopeId: 'pe_full',
      userId: 'user_1',
      agentId: 'agent_1',
      hash: 'realhash',
    });
  });

  it('falls back agent_id to user_id and hash to "" when absent', async () => {
    const { db, store } = makeFakeDb();
    seedPE(store, 'pe_min', {
      user_id: 'user_1',
      metadata: { commit_sha: 'abc123' },
    });
    const matches = await findPEsByCommitSha(db, 'abc123');
    expect(matches[0]).toEqual({
      envelopeId: 'pe_min',
      userId: 'user_1',
      agentId: 'user_1',
      hash: '',
    });
  });

  it('returns empty array when no PE matches', async () => {
    const { db, store } = makeFakeDb();
    seedPE(store, 'pe_x', {
      user_id: 'user_1',
      metadata: { commit_sha: 'deadbeef' },
    });
    const matches = await findPEsByCommitSha(db, 'abc123');
    expect(matches).toEqual([]);
  });

  it('handles PEs with missing user_id by returning empty string', async () => {
    const { db, store } = makeFakeDb();
    seedPE(store, 'pe_anon', {
      metadata: { commit_sha: 'cafef00d' },
    });
    const matches = await findPEsByCommitSha(db, 'cafef00d');
    expect(matches).toHaveLength(1);
    expect(matches[0].userId).toBe('');
  });
});
