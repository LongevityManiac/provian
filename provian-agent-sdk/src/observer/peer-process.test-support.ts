/**
 * Test support: a process-table lookup that names one harness (or process) as the sender of every
 * connection — the OS, faked — for tests of the lanes that decide by sender (peer-process.ts).
 */
import { PeerAttributor } from './peer-process';
/** A process-table lookup that names `harness` as the sender of every connection (the OS, faked). */
export function fakePeers(harness: string | null): PeerAttributor {
  // What the process table shows for each (peer-process.test.ts pins these against the real lookup):
  // the desktop Code tab's executable under a path with spaces; OpenClaw's gateway under its title.
  const codeTab = '/Users/a/Library/Application Support/Claude/claude-code/2.1.288/48d54124d3c3/claude.app/Contents/MacOS/claude';
  const entry = harness === null ? null
    : harness === 'claude-code' ? { args: `${codeTab} --output-format stream-json`, exe: codeTab }
      : harness === 'openclaw' ? { args: 'openclaw-gateway  ', exe: 'openclaw-gateway' }
        : harness.startsWith('proc:') ? { args: '/usr/bin/python3 agent.py', exe: '/usr/bin/python3' }
          : { args: `/usr/local/bin/${harness} run`, exe: `/usr/local/bin/${harness}` };
  const pid = harness?.startsWith('proc:') ? Number(harness.slice(5)) : 4242;
  return new PeerAttributor({
    lookup: async () => (entry === null ? null : [{ pid, ...entry }]),
    identifyProgram: () => harness,
  });
}
