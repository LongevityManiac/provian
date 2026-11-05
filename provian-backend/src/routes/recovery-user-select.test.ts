/**
 * F46 — the recover selection is FAIL-CLOSED on ambiguity. RED controls: several
 * users docs for one address must NEVER resolve to an arbitrary one; they resolve
 * only when exactly one is backed by a human wallets doc, else refuse.
 */
import { describe, it, expect } from '@jest/globals';
import { lookupRecoveryUser, selectRecoveryUser, type RecoveryLookupDb } from './recovery-user-select';

const u = (id: string) => ({ id, data: { id, wallet_address: '0xabc' } });

describe('selectRecoveryUser (F46 fail-closed)', () => {
  it('none when no users doc matches (caller bootstraps a fresh account)', () => {
    expect(selectRecoveryUser([], new Set())).toEqual({ kind: 'none' });
  });

  it('unique when exactly one users doc matches', () => {
    expect(selectRecoveryUser([u('user_real')], new Set())).toEqual({ kind: 'unique', user: u('user_real').data });
  });

  it('RED: several matches with NO human-wallet backing → ambiguous (never an arbitrary pick)', () => {
    const matches = [u('user_attacker1'), u('user_attacker2'), u('user_victim')];
    expect(selectRecoveryUser(matches, new Set())).toEqual({ kind: 'ambiguous' });
  });

  it('several matches resolve to the SINGLE human-wallet-backed doc (the real key holder)', () => {
    const matches = [u('user_attacker1'), u('user_victim'), u('user_attacker2')];
    const res = selectRecoveryUser(matches, new Set(['user_victim']));
    expect(res).toEqual({ kind: 'unique', user: u('user_victim').data });
  });

  it('RED: several matches with MORE THAN ONE human-wallet-backed doc → ambiguous', () => {
    const matches = [u('user_a'), u('user_b')];
    expect(selectRecoveryUser(matches, new Set(['user_a', 'user_b']))).toEqual({ kind: 'ambiguous' });
  });

  // (moto restore): the human-wallet OWNER is authoritative.
  it('owner: NO users doc carries the address but a human wallet names its owner → that owner (never a fresh shell)', () => {
    expect(selectRecoveryUser([], new Set(['user_owner']))).toEqual({ kind: 'owner', userId: 'user_owner' });
  });

  it('owner beats a lone NON-owner users doc carrying the address (the shell a pre-fix restore minted)', () => {
    expect(selectRecoveryUser([u('user_shell')], new Set(['user_owner']))).toEqual({ kind: 'owner', userId: 'user_owner' });
  });

  it('owner whose users doc matches → unique with that doc', () => {
    expect(selectRecoveryUser([u('user_shell'), u('user_owner')], new Set(['user_owner'])))
      .toEqual({ kind: 'unique', user: u('user_owner').data });
  });

  it('RED: more than one human-wallet owner for the address → ambiguous, even with zero users matches', () => {
    expect(selectRecoveryUser([], new Set(['user_a', 'user_b']))).toEqual({ kind: 'ambiguous' });
    expect(selectRecoveryUser([u('user_a')], new Set(['user_a', 'user_b']))).toEqual({ kind: 'ambiguous' });
  });
});

/**
 * lookupRecoveryUser is the route's whole account lookup, run here against an
 * in-memory Firestore so the type filter, both-case wallets read, owner load and
 * missing-owner refusal are exercised, not pattern-matched.
 */
type Doc = { id: string; data: Record<string, unknown> };
function fakeDb(collections: Record<string, Doc[]>): RecoveryLookupDb {
  return {
    collection(name: string) {
      const docs = collections[name] ?? [];
      return {
        where(field: string, _op: '==', value: unknown) {
          return {
            limit(n: number) {
              return {
                async get() {
                  const hit = docs.filter((d) => d.data[field] === value).slice(0, n);
                  return { size: hit.length, docs: hit.map((d) => ({ id: d.id, data: () => d.data })) };
                },
              };
            },
          };
        },
        doc(id: string) {
          return {
            async get() {
              const d = docs.find((x) => x.id === id);
              return { exists: !!d, id, data: () => d?.data };
            },
          };
        },
      };
    },
  };
}

const ADDR = '0xDf00873bF00C026C66982eD4Ea3E325276Fe8422';
const ADDR_LC = ADDR.toLowerCase();
const user = (id: string, extra: Record<string, unknown> = {}): Doc => ({ id, data: { id, ...extra } });
const wallet = (id: string, type: string, userId: string, address: string): Doc =>
  ({ id, data: { id, type, user_id: userId, address } });

describe('lookupRecoveryUser (the route lookup, executed)', () => {
  it('the moto case: owner users doc lacks wallet_address, a pre-fix shell carries it → the OWNER', async () => {
    const db = fakeDb({
      users: [user('user_owner'), user('user_shell', { wallet_address: ADDR_LC })],
      wallets: [wallet('wallet_h', 'human', 'user_owner', ADDR_LC)],
    });
    const r = await lookupRecoveryUser(db, ADDR);
    expect(r).toEqual({ kind: 'existing', user: { id: 'user_owner' } });
  });

  it('owner found through a MIXED-case wallets address (the as-supplied read)', async () => {
    const db = fakeDb({ users: [user('user_owner')], wallets: [wallet('w', 'human', 'user_owner', ADDR)] });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'existing', user: { id: 'user_owner' } });
  });

  it('owner found through a lowercased wallets address when the caller sends mixed case', async () => {
    const db = fakeDb({ users: [user('user_owner')], wallets: [wallet('w', 'human', 'user_owner', ADDR_LC)] });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'existing', user: { id: 'user_owner' } });
  });

  it('RED: an AGENT wallets doc carrying a user_id never names an owner (no agent-key takeover of a human account)', async () => {
    const db = fakeDb({
      users: [user('user_victim')],
      wallets: [wallet('w_agent', 'agent', 'user_victim', ADDR_LC)],
    });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'none' });
  });

  it('RED: the owner users doc is gone → owner_missing (never a fresh shell)', async () => {
    const db = fakeDb({ users: [], wallets: [wallet('w', 'human', 'user_gone', ADDR_LC)] });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'owner_missing', userId: 'user_gone' });
  });

  it(' RED: a DISPLACED squat is not an owner — the key holder who displaced it recovers (old: ambiguous 409)', async () => {
    const db = fakeDb({
      users: [user('user_squatter', { wallet_address: ADDR_LC }), user('user_victim', { wallet_address: ADDR_LC })],
      wallets: [
        { id: 'w_squat', data: { id: 'w_squat', type: 'human', user_id: 'user_squatter', address: ADDR_LC, displaced_at_ms: 5 } },
        wallet('w_victim', 'human', 'user_victim', ADDR_LC),
      ],
    });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'existing', user: { id: 'user_victim', wallet_address: ADDR_LC } });
  });

  it('a RELEASED registration (owner deleted their data) names no owner → none (fresh account, then reclaim with proof)', async () => {
    const db = fakeDb({
      users: [],
      wallets: [{ id: 'w_rel', data: { id: 'w_rel', type: 'human', user_id: 'user_gone', address: ADDR_LC, released_at_ms: 9 } }],
    });
    expect(await lookupRecoveryUser(db, ADDR)).toEqual({ kind: 'none' });
  });

  it('RED: two human owners for one address → ambiguous', async () => {
    const db = fakeDb({
      users: [user('user_a'), user('user_b')],
      wallets: [wallet('w1', 'human', 'user_a', ADDR_LC), wallet('w2', 'human', 'user_b', ADDR)],
    });
    expect(await lookupRecoveryUser(db, ADDR)).toMatchObject({ kind: 'ambiguous', owners: 2 });
  });

  it('no human wallet: a single users-doc match still recovers; none → none', async () => {
    const one = fakeDb({ users: [user('user_x', { wallet_address: ADDR_LC })], wallets: [] });
    expect(await lookupRecoveryUser(one, ADDR)).toEqual({ kind: 'existing', user: { id: 'user_x', wallet_address: ADDR_LC } });
    expect(await lookupRecoveryUser(fakeDb({ users: [], wallets: [] }), ADDR)).toEqual({ kind: 'none' });
  });
});

describe('POST /v1/users/recover wiring ', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
  const start = src.indexOf("app.post('/v1/users/recover'");
  const route = src.slice(start, src.indexOf('\n});', start));

  it('the route delegates to lookupRecoveryUser, refuses ambiguity, and backfills the address', () => {
    expect(start).toBeGreaterThan(-1);
    expect(route).toMatch(/await lookupRecoveryUser\(/);
    expect(route).toMatch(/lookup\.kind === 'ambiguous'\)[\s\S]{0,300}status\(409\)/);
    // an orphaned owner (users doc gone) no longer locks the key holder out with a 409
    // forever — the proven key holder gets a fresh account and reclaims the orphan with proof.
    expect(route).not.toMatch(/recovery_owner_record_missing/);
    expect(route).toMatch(/lookup\.kind === 'existing' \? /);
    expect(route).toMatch(/\{ devices, wallet_address: addressLc \}/);
  });
});
