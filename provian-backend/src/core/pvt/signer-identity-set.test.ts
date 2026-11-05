/**
 * signer-identity-set (, Prompt 3). Resolves the signer's own identities as canonical
 * owner-party strings. RED controls: a read error is UNRESOLVABLE (never a partial set that would
 * over-count); an external party is NOT in the set.
 */

import { resolveSignerIdentitySet } from './signer-identity-set';
import type { BeneficiaryCacheEntry } from './beneficiary';

type Row = Record<string, unknown>;

function fakeDb(data: Record<string, Row[]>, throwOn?: string) {
  return {
    collection(name: string) {
      if (throwOn === name) {
        return { where: () => ({ get: async () => { throw new Error(`read failed: ${name}`); } }) };
      }
      const rows = data[name] ?? [];
      return {
        where(field: string, _op: string, value: unknown) {
          const matched = rows.filter((r) => r[field] === value);
          return { get: async () => ({ docs: matched.map((r) => ({ data: () => r })) }) };
        },
      };
    },
  } as never;
}

const cache = {} as never;
const unlinked: BeneficiaryCacheEntry = {
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
};
const stubBeneficiary = (entry: BeneficiaryCacheEntry) => async () => entry;

const ADDR_SELF = '0xAAaA00000000000000000000000000000000AAaA';
const ADDR_PROVEN = '0xBb0000000000000000000000000000000000bBbB';
const ADDR_HUMAN = '0xCc0000000000000000000000000000000000cCcC';
const ADDR_SIBLING = '0xDd0000000000000000000000000000000000dDdD';

describe('resolveSignerIdentitySet', () => {
  it('gathers native + proven + retired addresses of the signer', async () => {
    const db = fakeDb({
      proven_addresses: [{ address: ADDR_PROVEN, agent_id: 'atlas' }],
      agent_wallet_address_retirements_v1: [{ old_address: '0xEe0000000000000000000000000000000000eEeE', agent_id: 'atlas' }],
    });
    const r = await resolveSignerIdentitySet(db, cache,
      { economicActorId: 'atlas', walletAddress: ADDR_SELF }, stubBeneficiary(unlinked));
    expect(r.unresolvable).toBe(false);
    expect(r.identities.has(`evm:${ADDR_SELF.toLowerCase()}`)).toBe(true);
    expect(r.identities.has(`evm:${ADDR_PROVEN.toLowerCase()}`)).toBe(true);
    expect(r.identities.has('evm:0xee0000000000000000000000000000000000eeee')).toBe(true);
    // RED control: an unrelated external party is NOT in the signer's identity set.
    expect(r.identities.has('evm:0x1111111111111111111111111111111111111111')).toBe(false);
  });

  it('linked agent — includes the human address, sibling agents, and the human forge login', async () => {
    const db = fakeDb({
      agent_wallets: [
        { address: ADDR_SIBLING, linked_human_user_id: 'user_h' },
        { address: '0x9999999999999999999999999999999999999999', linked_human_user_id: 'someone_else' },
      ],
      service_installs: [{ user_id: 'user_h', forge_account_login: 'frankdrew' }],
    });
    const linked: BeneficiaryCacheEntry = {
      linked: true, humanWalletId: 'wallet_h', humanUserId: 'user_h', humanAddress: ADDR_HUMAN, agentShareBps: 2000 as never,
    };
    const r = await resolveSignerIdentitySet(db, cache,
      { economicActorId: 'atlas', walletAddress: null }, stubBeneficiary(linked));
    expect(r.unresolvable).toBe(false);
    expect(r.identities.has(`evm:${ADDR_HUMAN.toLowerCase()}`)).toBe(true);       // principal
    expect(r.identities.has(`evm:${ADDR_SIBLING.toLowerCase()}`)).toBe(true);      // sibling agent
    expect(r.identities.has('repo-owner:frankdrew')).toBe(true);                   // human forge login
    expect(r.identities.has('repo-owner:github.com/frankdrew')).toBe(true);        // host-qualified
    // the OTHER human's agent must NOT be in this signer's set
    expect(r.identities.has('evm:0x9999999999999999999999999999999999999999')).toBe(false);
  });

  // RED control: a registry read that THROWS is UNRESOLVABLE — never a partial set that over-counts.
  it('RED — a read error yields unresolvable:true (caller counts zero independent origins)', async () => {
    const db = fakeDb({ proven_addresses: [{ address: ADDR_PROVEN, agent_id: 'atlas' }] }, 'proven_addresses');
    const r = await resolveSignerIdentitySet(db, cache,
      { economicActorId: 'atlas', walletAddress: ADDR_SELF }, stubBeneficiary(unlinked));
    expect(r.unresolvable).toBe(true);
  });

  it('empty actor id is unresolvable (no set to build)', async () => {
    const r = await resolveSignerIdentitySet(fakeDb({}), cache,
      { economicActorId: '', walletAddress: null }, stubBeneficiary(unlinked));
    expect(r.unresolvable).toBe(true);
  });
});
