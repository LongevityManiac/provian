import { describe, expect, it } from 'vitest';
import { composeRecipients } from './composeRecipients';

const ME = 'wallet_me';
const agents = [{ wallet_id: 'wallet_aw_atlas', display_name: 'Atlas' }, { wallet_id: 'wallet_aw_grok', display_name: 'grok-bot-vm' }];
const profiles = [
  { wallet_id: ME, display_name: 'the operator', participant_type: 'human' as const },
  { wallet_id: 'wallet_aw_atlas', display_name: 'Atlas', participant_type: 'agent' as const },
  { wallet_id: 'wallet_ann', display_name: 'Ann', participant_type: 'human' as const },
  { wallet_id: 'wallet_ann', display_name: 'Ann', participant_type: 'human' as const },
];

describe('composeRecipients — your agents first, then the Directory', () => {
  it('lists every linked agent with no search, and the Directory without me or my agents, each once', () => {
    const r = composeRecipients({ linkedAgents: agents, profiles, myId: ME, query: '' });
    expect(r.own.map((x) => x.name)).toEqual(['Atlas', 'grok-bot-vm']);
    expect(r.directory).toEqual([{ walletId: 'wallet_ann', name: 'Ann', kind: 'human' }]);
  });

  it('the search narrows my agents by name or wallet id; the Directory list is what the Directory search returned', () => {
    const r = composeRecipients({ linkedAgents: agents, profiles, myId: ME, query: ' atl ' });
    expect(r.own.map((x) => x.walletId)).toEqual(['wallet_aw_atlas']);
    expect(composeRecipients({ linkedAgents: agents, profiles: [], myId: ME, query: 'wallet_aw_g' }).own.map((x) => x.name)).toEqual(['grok-bot-vm']);
  });

  it('RED: I am never offered as a recipient, even when the Directory returns my own profile', () => {
    const r = composeRecipients({ linkedAgents: [], profiles, myId: ME, query: 'frank' });
    expect([...r.own, ...r.directory].some((x) => x.walletId === ME)).toBe(false);
  });
});
