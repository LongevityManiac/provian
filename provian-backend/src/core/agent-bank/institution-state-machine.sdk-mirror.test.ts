/**
 * beneficiary routing — cross-package drift guard: the SDK/CLI institution-state mirror
 * (provian-agent-sdk/src/institution-state.ts) must reproduce the relay
 * machine's transition set EXACTLY. This reads the SDK source as text,
 * regex-extracts its flat `[kind, from, to, class]` rows, and set-compares them
 * to the relay's `canonicalTransitionKeys()`. Either side gaining or dropping an
 * edge fails this test (same cross-package pattern as the shared session-file /
 * DeviceSignature canonicalization checks).
 *
 * Text-based on purpose: the SDK is a separate package, not a backend import.
 */

import fs from 'fs';
import path from 'path';
import { canonicalTransitionKeys } from './institution-state-machine';

const SDK_MIRROR_PATH = path.resolve(
  __dirname,
  '../../../../provian-agent-sdk/src/institution-state.ts',
);

// Matches a flat row: ['escrow', 'created', 'funded', 'economic'] or with INITIAL.
// INITIAL is written as the bare identifier `INITIAL`, resolving to '__initial__'.
const ROW_RE =
  /\[\s*'([a-z_]+)'\s*,\s*(?:'([a-z_]+)'|INITIAL)\s*,\s*'([a-z_]+)'\s*,\s*'(economic|record_only)'\s*\]/g;

function extractSdkTransitionKeys(source: string): string[] {
  const keys: string[] = [];
  for (const m of source.matchAll(ROW_RE)) {
    const kind = m[1];
    const from = m[2] ?? '__initial__'; // INITIAL branch
    const to = m[3];
    const cls = m[4];
    keys.push(`${kind}|${from}|${to}|${cls}`);
  }
  return keys.sort();
}

describe('institution-state-machine — SDK mirror is in lockstep with the relay', () => {
  const source = fs.readFileSync(SDK_MIRROR_PATH, 'utf8');
  const sdkKeys = extractSdkTransitionKeys(source);
  const relayKeys = canonicalTransitionKeys();

  it('the SDK mirror file exists and declares transition rows', () => {
    expect(source.length).toBeGreaterThan(0);
    expect(sdkKeys.length).toBeGreaterThan(0);
  });

  it('the SDK mirror transition set EQUALS the relay transition set', () => {
    expect(sdkKeys).toEqual(relayKeys);
  });

  it('there are no duplicate edges on either side', () => {
    expect(new Set(sdkKeys).size).toBe(sdkKeys.length);
    expect(new Set(relayKeys).size).toBe(relayKeys.length);
  });
});
