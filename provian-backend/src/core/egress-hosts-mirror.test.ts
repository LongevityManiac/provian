import * as fs from 'fs';
import * as path from 'path';
import { EGRESS_ALLOW_HOSTS, buildAgentBootstrapScript } from './agent-bootstrap-script';

// The install script (relay-served, before any Node runs) and the bundle (provian-agent-sdk)
// must name the same hosts, so an agent asks its human for one standing allow that covers all.
const SDK_FILE = path.resolve(__dirname, '../../../provian-agent-sdk/src/egress-hosts.ts');

function sdkHosts(): Array<{ host: string; use: string }> {
  const src = fs.readFileSync(SDK_FILE, 'utf8');
  const block = src.slice(src.indexOf('export const EGRESS_ALLOW_HOSTS'), src.indexOf('];', src.indexOf('export const EGRESS_ALLOW_HOSTS')));
  return [...block.matchAll(/\{ host: '([^']+)', use: (['"])(.*?)\2 \}/g)].map((m) => ({ host: m[1], use: m[3] }));
}

describe('egress allow list: relay script mirrors the SDK', () => {
  it('names the same hosts with the same uses', () => {
    const sdk = sdkHosts();
    expect(sdk.length).toBeGreaterThanOrEqual(5);
    expect(EGRESS_ALLOW_HOSTS).toEqual(sdk);
  });

  it('the agent install script prints every host before anything runs', () => {
    const sh = buildAgentBootstrapScript({ token: 'PROV-ABCD-2345', relayUrl: 'https://api.provian.ai', bundleSha256: 'a'.repeat(64) });
    const head = sh.slice(0, sh.indexOf('Ensure a Node.js'));
    for (const h of ['api.provian.ai', ...EGRESS_ALLOW_HOSTS.map((x) => x.host)]) expect(head).toContain(`  ${h} — `);
  });

  it('RED control: a host missing from one side is caught', () => {
    const sdk = sdkHosts();
    expect(EGRESS_ALLOW_HOSTS.slice(1)).not.toEqual(sdk);
  });
});
