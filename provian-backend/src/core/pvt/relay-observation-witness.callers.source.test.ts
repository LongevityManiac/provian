/**
 * Fact-base fixes item 4 — WHO may pass a relay observation. Only relay-composed emitters that
 * verified the event themselves, independent of the actor (the GitHub App webhook, the two USDC
 * watchers, the chain-verified transfer record). The sovereign lane and the relay/action self-report
 * are the actor's own word and must never carry one; neither may GitLab or Bitbucket, whose deliveries
 * are authenticated only by a per-install secret the actor holds. The allowed set is exact: a new caller must be added here deliberately.
 * RED control: the sovereign route and the action recorder are asserted absent by name.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../..');
const ALLOWED = [
  'core/agent-bank/pe-utils.ts',          // the plumbing (normalize + key + forward)
  'core/pvt/relay-observation-witness.ts', // the module itself
  'core/witnesses/github-webhook.ts',
  'core/pvt/inbound-usdc-watcher.ts',
  'core/pvt/outbound-usdc-watcher.ts',
  // the chain-record lane re-reads the whole transaction through the two operator legs at
  // finality itself; the actor's record call is only the pointer, never the evidence.
  'core/pvt/chain-record-watcher.ts',
  // : the x402 facilitator lane, likewise — the facilitator's report is only the
  // pointer; the relay re-reads the transaction through the two operator legs at finality itself.
  'core/pvt/x402-facilitator-lane.ts',
  // the Solana chain-record lane: the relay discovers the signature itself and re-reads the
  // transaction through its two operator legs at finality.
  'core/pvt/solana-chain-record-lane.ts',
  'routes/agent-wallet.ts',              // transfer/record — only when the tx-verifier passed
].sort();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

describe('relayObservation callers', () => {
  const callers = walk(SRC)
    .filter((p) => fs.readFileSync(p, 'utf8').includes('relayObservation'))
    .map((p) => path.relative(SRC, p).split(path.sep).join('/'))
    .sort();

  it('the set of files that pass a relay observation is exactly the relay-composed emitters (never empty)', () => {
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toEqual(ALLOWED);
  });

  it('RED: the sovereign lane and the relay/action self-report never pass one', () => {
    expect(callers).not.toContain('routes/sovereign-pe.ts');
    expect(callers).not.toContain('core/pe/action-pe-recorder.ts');
    expect(fs.readFileSync(path.join(SRC, 'routes/sovereign-pe.ts'), 'utf8').includes('relayObservation')).toBe(false);
  });

  it('RED: the actor-secret forge lanes (GitLab, Bitbucket) never pass one', () => {
    for (const f of ['core/witnesses/gitlab-webhook.ts', 'core/witnesses/bitbucket-webhook.ts']) {
      expect(callers).not.toContain(f);
      expect(fs.readFileSync(path.join(SRC, f), 'utf8').includes('relayObservation')).toBe(false);
    }
  });

  it('the transfer record passes it only behind the on-chain verification verdict', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes/agent-wallet.ts'), 'utf8');
    const i = src.indexOf('{ relayObservation: {');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, i - 80), i)).toMatch(/\.\.\.\(verified\s*\?\s*$/);
  });
});
