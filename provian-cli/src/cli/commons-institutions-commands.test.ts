/**
 * Workstream 4 - Provian Commons institutions CLI tests.
 *
 * Covers:
 *   - Help output formatting: PVT example appears BEFORE USDC in every
 *     command's --help text
 *   - Missing credentials returns a clear error (no silent 401)
 *   - Each command's help text contains the currency flag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cmdPayAgent,
  cmdCreateEscrow,
  cmdCreatePromise,
  cmdCreatePool,
  cmdPostJob,
  cmdSearchAgents,
  printPayAgentHelp,
  printCreateEscrowHelp,
  printCreatePromiseHelp,
  printCreatePoolHelp,
  printPostJobHelp,
  printSearchAgentsHelp,
} from './commons-institutions-commands';

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    lines.push(String(msg));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

function clearCreds() {
  delete process.env.PROVIAN_API_KEY;
  delete process.env.PROVIAN_API_SECRET;
  delete process.env.PROVIAN_AGENT_WALLET_ID;
}

describe('Commons institutions CLI - help output', () => {
  it('pay-agent --help shows a PVT example and no USDC example', () => {
    const out = captureLog(() => printPayAgentHelp());
    expect(out).toMatch(/PVT example/);
    // payAgentPVT is PVT-only by design - explicitly calls out the USDC
    // alternative path (create-escrow) rather than showing a USDC example.
    expect(out).toMatch(/provian pay-agent/);
    expect(out).toMatch(/--to/);
    expect(out).toMatch(/--amount/);
    expect(out).toMatch(/PVT-only by design/);
  });

  function assertPvtBeforeUsdc(out: string, command: string) {
    const pvtIdx = out.indexOf('PVT example');
    const usdcIdx = out.indexOf('USDC alternative');
    expect(pvtIdx).toBeGreaterThan(-1);
    expect(usdcIdx).toBeGreaterThan(-1);
    expect(pvtIdx).toBeLessThan(usdcIdx);
    expect(out).toMatch(new RegExp(`provian ${command}`));
  }

  it('create-escrow --help lists PVT example before USDC', () => {
    assertPvtBeforeUsdc(captureLog(() => printCreateEscrowHelp()), 'create-escrow');
  });
  it('create-promise --help lists PVT example before USDC', () => {
    assertPvtBeforeUsdc(captureLog(() => printCreatePromiseHelp()), 'create-promise');
  });
  it('create-pool --help lists PVT example before USDC', () => {
    assertPvtBeforeUsdc(captureLog(() => printCreatePoolHelp()), 'create-pool');
  });
  it('post-job --help lists PVT example before USDC', () => {
    assertPvtBeforeUsdc(captureLog(() => printPostJobHelp()), 'post-job');
  });

  it('search-agents --help documents both rate fields with PVT first', () => {
    const out = captureLog(() => printSearchAgentsHelp());
    const pvtIdx = out.indexOf('hourly_rate_pvt');
    const usdcIdx = out.indexOf('hourly_rate_usdc');
    expect(pvtIdx).toBeGreaterThan(-1);
    expect(usdcIdx).toBeGreaterThan(-1);
    expect(pvtIdx).toBeLessThan(usdcIdx);
  });

  it('every command --help surfaces the --currency flag or notes the currency choice', () => {
    // pay-agent is PVT-only - mentions PVT-only rather than --currency.
    expect(captureLog(() => printPayAgentHelp())).toMatch(/PVT-only/);
    // Multi-currency commands all surface --currency prominently.
    expect(captureLog(() => printCreateEscrowHelp())).toMatch(/--currency/);
    expect(captureLog(() => printCreatePromiseHelp())).toMatch(/--currency/);
    expect(captureLog(() => printCreatePoolHelp())).toMatch(/--currency/);
    expect(captureLog(() => printPostJobHelp())).toMatch(/--currency/);
  });
});

describe('Commons institutions CLI - missing credentials', () => {
  beforeEach(() => {
    clearCreds();
  });

  afterEach(() => {
    clearCreds();
  });

  it('pay-agent returns a credentials error when env is unset', async () => {
    const result = await cmdPayAgent({ to: 'wallet_r', amount: '5' });
    expect(result).toBeDefined();
    expect((result as { status?: string }).status).toBe('error');
    expect(((result as { error: string }).error)).toMatch(/PROVIAN_API_KEY/);
  });

  it('create-escrow returns a credentials error when env is unset', async () => {
    const result = await cmdCreateEscrow({
      currency: 'pvt',
      to: 'wallet_r',
      amount: '5',
      description: 'desc',
      deliverables: 'x',
      'deadline-hours': '24',
    });
    expect((result as { status?: string }).status).toBe('error');
  });

  it('create-promise returns a credentials error when env is unset', async () => {
    const result = await cmdCreatePromise({ currency: 'pvt', principal: '10', repay: '11', purpose: 'x', 'deadline-hours': '24' });
    expect((result as { status?: string }).status).toBe('error');
  });

  it('create-pool returns a credentials error when env is unset', async () => {
    const result = await cmdCreatePool({ currency: 'pvt', threshold: '50', target: '0xabc', description: 'x', 'deadline-hours': '24', 'max-contributors': '10' });
    expect((result as { status?: string }).status).toBe('error');
  });

  it('post-job returns a credentials error when env is unset', async () => {
    const result = await cmdPostJob({ currency: 'pvt', budget: '100', title: 't', description: 'd', capabilities: 'x', 'deadline-hours': '72' });
    expect((result as { status?: string }).status).toBe('error');
  });

  it('search-agents returns a credentials error when env is unset', async () => {
    const result = await cmdSearchAgents({});
    expect((result as { status?: string }).status).toBe('error');
  });
});

describe('Commons institutions CLI - currency validation', () => {
  beforeEach(() => {
    process.env.PROVIAN_API_KEY = 'pvn_live_test';
    process.env.PROVIAN_API_SECRET = 'pvns_' + 'x'.repeat(64);
    process.env.PROVIAN_AGENT_WALLET_ID = 'wallet_aw_test';
  });

  afterEach(() => {
    clearCreds();
  });

  it('create-escrow rejects missing currency', async () => {
    const result = await cmdCreateEscrow({
      to: 'wallet_r',
      amount: '5',
      description: 'desc',
      deliverables: 'x',
      'deadline-hours': '24',
    });
    expect((result as { status?: string }).status).toBe('error');
    expect(((result as { error: string }).error)).toMatch(/currency/);
  });

  it('create-escrow rejects currency other than pvt|usdc', async () => {
    const result = await cmdCreateEscrow({
      currency: 'eth',
      to: 'wallet_r',
      amount: '5',
      description: 'desc',
      deliverables: 'x',
      'deadline-hours': '24',
    });
    expect((result as { status?: string }).status).toBe('error');
  });
});

