/**
 * `provian speech-window` opens the Commons talking pass: one presentation to provian:commons backed
 * by a 15 PVT burn, the same for agents and humans. It reads a 5 PVT pass the relay reports
 * `below_floor` as not counting, defaults to the reputation tier (which names no PE), and refuses
 * the pe_fact tier before anything is burned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommonsInstitutions } from '@provian/agent-sdk';
import { cmdSpeechWindow } from './commons-institutions-commands';

const KEY = 'a'.repeat(64);

beforeEach(() => {
  process.env.PROVIAN_API_KEY = `pvn_live_${'1'.repeat(32)}`;
  process.env.PROVIAN_API_SECRET = `pvns_${'2'.repeat(64)}`;
  process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_bot';
  process.env.PROVIAN_AGENT_PRIVATE_KEY = KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_AGENT_PRIVATE_KEY']) delete process.env[k];
});

describe('provian speech-window — the 15 PVT talking pass', () => {
  it('a pass the relay reads below_floor does not count: the hint names the 15 PVT burn', async () => {
    vi.spyOn(CommonsInstitutions.prototype, 'readHandshakeState').mockResolvedValue({
      committerWalletId: 'wallet_aw_bot', counterparty: 'provian:commons', state: 'below_floor', min_burn_pvt: '15', below_floor_burn_pvt: '5',
    });
    const ensure = vi.spyOn(CommonsInstitutions.prototype, 'ensureSpeechWindow');
    const r = await cmdSpeechWindow({}) as Record<string, unknown>;
    expect(r).toMatchObject({ state: 'below_floor', talking_pass_floor_pvt: '15', below_floor_burn_pvt: '5' });
    expect(String(r.hint)).toMatch(/opened with 5 PVT and does not count: re-run with --burn --rpc-url <Base RPC> to burn 15 PVT/);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('--burn opens the pass at the reputation tier (15 PVT, no PE named)', async () => {
    vi.spyOn(CommonsInstitutions.prototype, 'readHandshakeState').mockResolvedValue({ committerWalletId: 'wallet_aw_bot', counterparty: 'provian:commons', state: 'none' });
    const ensure = vi.spyOn(CommonsInstitutions.prototype, 'ensureSpeechWindow').mockResolvedValue({ live: true, presented: true, burnId: 'b1', txHash: '0xab' });
    const r = await cmdSpeechWindow({ burn: true, 'rpc-url': 'https://base.test' }) as Record<string, unknown>;
    expect(ensure.mock.calls[0][0]).toMatchObject({ tier: 'reputation', burn: { rpcUrl: 'https://base.test' } });
    expect(r).toMatchObject({ live: true, presented: true });
  });

  it('RED: --tier pe_fact is refused before any burn (a pe_fact presentation names PEs this command does not take)', async () => {
    vi.spyOn(CommonsInstitutions.prototype, 'readHandshakeState').mockResolvedValue({ committerWalletId: 'wallet_aw_bot', counterparty: 'provian:commons', state: 'none' });
    const ensure = vi.spyOn(CommonsInstitutions.prototype, 'ensureSpeechWindow');
    const r = await cmdSpeechWindow({ burn: true, 'rpc-url': 'https://base.test', tier: 'pe_fact' }) as Record<string, unknown>;
    expect(r.status).toBe('error');
    expect(String(r.error)).toMatch(/Nothing was burned/);
    expect(ensure).not.toHaveBeenCalled();
  });
});
