/**
 * INSTALLED-BASE COMPATIBILITY — SDK side (close-out, item 8).
 *
 * The relay-side half lives in `provian-backend/src/installed-base-compat.test.ts`.
 * This half pins the SDK's DURABLE-IDENTITY fingerprint (`contextHash`), which
 * every fielded snapshot's encrypted-keystore walletId binding was computed from.
 * A dropped / added / reordered key here — e.g. removing the
 * `agent_session_id: null` would make every already-installed agent unable to
 * resume its own registration (the walletId cross-check in `readPending` fails
 * before any networking). The ordinary SDK suites recompute the hash at HEAD, so
 * they never see a lockstep change that strands the installed base; this frozen
 * golden does.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { normalizedContext, contextHash } from './pending-wallet-registration';
import type { AgentWalletConfig } from './types';

// A frozen config representative of a fielded agent, and the contextHash HEAD
// MUST reproduce. Captured 2026-09-16 from `contextHash` at HEAD.
const GOLDEN_CONFIG: AgentWalletConfig = {
  relayUrl: 'https://api.provian.ai/',
  agentId: 'compat-golden-agent',
  agentName: 'Compat Golden Agent',
  platform: 'sdk',
  constitutionAccepted: true,
  constitutionVersion: '1.0.0',
  constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
};
const GOLDEN_CONTEXT_HASH = '3283a1639c0fee9625531a531511e5bbc85f00025bca8178bd483e8ae0a5cfb4';

// The exact key set the durable identity binds, in order. Reordering or
// dropping any of these re-keys every fielded snapshot.
const GOLDEN_KEYS = [
  'relay_url',
  'agent_id',
  'agent_name',
  'platform',
  'constitution_accepted',
  'constitution_version',
  'constitution_accepted_at',
  'agent_session_id',
  'governance',
];

describe('installed-base compatibility — SDK durable identity (item 8)', () => {
  it('HEAD reproduces the frozen contextHash for a fielded config', () => {
    expect(contextHash(GOLDEN_CONFIG)).toBe(GOLDEN_CONTEXT_HASH);
  });

  it('the durable-identity key set is unchanged (retiring agent_session_id would strand every snapshot)', () => {
    expect(Object.keys(normalizedContext(GOLDEN_CONFIG))).toEqual(GOLDEN_KEYS);
    // agent_session_id stays present-as-null even though the relay session is retired.
    expect('agent_session_id' in normalizedContext(GOLDEN_CONFIG)).toBe(true);
    expect(normalizedContext(GOLDEN_CONFIG).agent_session_id).toBeNull();
  });

  it('RED control: a config that drops the session key would hash differently', () => {
    // Simulate a canonical that omits agent_session_id and confirm it is NOT the
    // golden — proving the key is load-bearing for the durable identity.
    const withoutSession = { ...normalizedContext(GOLDEN_CONFIG) };
    delete (withoutSession as Record<string, unknown>).agent_session_id;
    const alt = createHash('sha256')
      .update(JSON.stringify(withoutSession), 'utf8').digest('hex');
    expect(alt).not.toBe(GOLDEN_CONTEXT_HASH);
  });
});
