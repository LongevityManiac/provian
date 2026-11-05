import { projectLinkedAgentIdentity } from './linked-agent-identity';

describe('projectLinkedAgentIdentity', () => {
  it('returns only the cheap linked-identity fields needed by Earn', () => {
    const result = projectLinkedAgentIdentity('wallet_atlas', {
      agent_id: 'atlas',
      display_name: 'Atlas',
      address: '0xabc',
      platform: 'claude',
      created_at: 123,
      last_pe_date: '2026-09-21',
      chain_addresses: { solana: 'solana-atlas' },
      api_secret_hash: 'must-not-leak',
      linked_human_user_id: 'must-not-leak-either',
    });

    expect(result).toEqual({
      wallet_id: 'wallet_atlas',
      agent_id: 'atlas',
      display_name: 'Atlas',
      address: '0xabc',
      platform: 'claude',
      created_at: 123,
      solana_address: 'solana-atlas',
      last_pe_date: '2026-09-21',
    });
    expect(Object.keys(result)).toHaveLength(8);
  });

  it('RED: malformed optional data cannot smuggle fields into the projection', () => {
    const result = projectLinkedAgentIdentity('wallet_unknown', {
      agent_id: 'agent_unknown',
      chain_addresses: { solana: 123, private_key: 'never' },
      last_pe_date: false,
    });

    expect(result.solana_address).toBeNull();
    expect(result.last_pe_date).toBeNull();
    expect(result).not.toHaveProperty('private_key');
    expect(result).not.toHaveProperty('linked_human_user_id');
  });
});
