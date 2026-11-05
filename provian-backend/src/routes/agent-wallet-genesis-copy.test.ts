import { describe, it, expect, afterEach } from '@jest/globals';
import { agentGenesisWhatEarns } from './agent-wallet-genesis-copy';

describe('agent wallet creation: genesis.what_earns and the accrual end line', () => {
  const saved = process.env.PVT_ACCRUAL_END_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
    else process.env.PVT_ACCRUAL_END_MS = saved;
  });

  it('CONTROL: no end line → the armed Genesis grant is described', () => {
    delete process.env.PVT_ACCRUAL_END_MS;
    expect(agentGenesisWhatEarns()).toContain('fixed gross grants of 75 PVT');
  });

  it('RED: past the end line no grant is claimed for the act just completed', () => {
    process.env.PVT_ACCRUAL_END_MS = '1';
    const copy = agentGenesisWhatEarns();
    expect(copy).toContain('Provian has ended PVT minting');
    expect(copy).not.toContain('75 PVT');
  });

  it('an end line still ahead changes nothing', () => {
    process.env.PVT_ACCRUAL_END_MS = String(Date.now() + 86_400_000);
    expect(agentGenesisWhatEarns()).toContain('fixed gross grants of 75 PVT');
  });
});
