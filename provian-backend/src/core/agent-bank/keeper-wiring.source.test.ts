/**
 * the B8 keeper gap was WIRING, not keys: escrowChain / poolKeeper /
 * bondKeeper are optional AgentBankDeps fields, and server.ts's agentBankDeps
 * literal did not construct them, so the mounted keeper keys loaded into
 * nothing and every scheduler tick took the keeper-unavailable branch (the
 * silent-no-op class, invisible behind zero-due 200s). This pin fails
 * if any injection ever drops out of the deps literal again.
 */
import fs from 'fs';
import path from 'path';

const serverSource = fs.readFileSync(path.join(__dirname, '../../server.ts'), 'utf8');

const INJECTIONS = [
  'escrowChain: createEscrowChainGateway()',
  'poolKeeper: createPoolKeeperGateway()',
  'bondKeeper: createBondKeeperGateway()',
] as const;

function agentBankDepsLiteral(source: string): string {
  const start = source.indexOf('const agentBankDeps = {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('};', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('B8 keeper wiring (source pin)', () => {
  it('server.ts injects all three keeper gateways into agentBankDeps', () => {
    const literal = agentBankDepsLiteral(serverSource);
    for (const injection of INJECTIONS) {
      expect(literal).toContain(injection);
    }
  });

  it('RED control: the pin detects a literal with an injection removed', () => {
    // Mutate the real source the way the defect actually presented (a deps
    // literal missing one gateway) and assert the assertion above would fail.
    for (const injection of INJECTIONS) {
      const mutated = serverSource.replace(`${injection},`, '');
      expect(agentBankDepsLiteral(mutated)).not.toContain(injection);
    }
  });
});
