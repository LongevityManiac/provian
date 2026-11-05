/**
 * register-device --agent-token tests.
 *
 * Verifies the byte-exact Authorization header contract and the mode-resolution
 * for the agent device-invite token path:
 *   - agent-token mode → "Bearer <token>" (single value, NO colon).
 *   - it does NOT require / validate the agent api-key/secret.
 *   - it does NOT route the api-key:api-secret pair into the header.
 *
 * The header logic is exercised through the pure, exported buildRegisterAuthHeader
 * helper that main() delegates to (main() is intentionally not driven here - it
 * performs FS mutation, git-hook installation, and observer start that have no
 * place in a unit test).
 */

import { describe, it, expect } from 'vitest';
import {
  buildRegisterAuthHeader,
  isExactDeviceRegistrationResponse,
} from './register-device';

const AGENT_TOKEN = 'a'.repeat(64); // crypto.randomBytes(32).toString('hex') shape

describe('register-device --agent-token auth header', () => {
  it('uses Bearer <token> with a single value (no colon)', () => {
    const header = buildRegisterAuthHeader({
      isAgentTokenMode: true,
      isAgentDevice: true, // token mode forces isAgentDevice=true
      agentToken: AGENT_TOKEN,
    });
    expect(header).toBe(`Bearer ${AGENT_TOKEN}`);
    // No colon → the api_key:api_secret pair never made it into the header.
    expect(header).not.toContain(':');
    // 64-hex token + the literal "Bearer " prefix, nothing else.
    expect(header).toBe('Bearer ' + AGENT_TOKEN);
  });

  it('ignores api key/secret when in agent-token mode (token wins)', () => {
    // Even if api-key/secret are somehow present, token mode must isolate the
    // token as the sole credential (S2).
    const header = buildRegisterAuthHeader({
      isAgentTokenMode: true,
      isAgentDevice: true,
      agentToken: AGENT_TOKEN,
      apiKey: 'pvn_live_should_not_appear',
      apiSecret: 'pvns_should_not_appear',
      token: 'wallet_session_should_not_appear',
    });
    expect(header).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(header).not.toContain('pvn_live_');
    expect(header).not.toContain('pvns_');
    expect(header).not.toContain('wallet_session');
  });

  it('throws (does not silently emit "Bearer undefined") when token mode lacks a token', () => {
    expect(() =>
      buildRegisterAuthHeader({
        isAgentTokenMode: true,
        isAgentDevice: true,
        agentToken: undefined,
      }),
    ).toThrow(/agent-token/);
  });

  it('agent (api-key) mode still produces Bearer key:secret', () => {
    const header = buildRegisterAuthHeader({
      isAgentTokenMode: false,
      isAgentDevice: true,
      apiKey: 'pvn_live_abc',
      apiSecret: 'pvns_def',
    });
    expect(header).toBe('Bearer pvn_live_abc:pvns_def');
  });

  it('human mode produces Bearer <wallet-session-token>', () => {
    const header = buildRegisterAuthHeader({
      isAgentTokenMode: false,
      isAgentDevice: false,
      token: 'pst_wallet_session',
    });
    expect(header).toBe('Bearer pst_wallet_session');
  });
});

describe('register-device response identity binding', () => {
  const pending = {
    schema_version: 'provian-device-registration/v2' as const,
    context: {
      relay_url: 'https://relay.test',
      authorization_sha256: 'a'.repeat(64),
      owner_type: 'agent' as const,
      device_name: 'Agent device',
      platform: 'darwin',
      attestation_capability: 'software',
      hardware_signing_required: false,
      signing_method: 'bearer' as const,
      signing_public_key: null,
      signing_key_alias: null,
    },
    context_sha256: 'a'.repeat(64),
    registration_id: 'device-registration-response-fixture',
    device_key: `pdk_${'b'.repeat(32)}`,
    device_secret: `pds_${'c'.repeat(64)}`,
    created_at_ms: 1,
  };
  const valid = {
    device_id: `dev_${'d'.repeat(64)}`,
    device_name: 'Agent device',
    device_key: pending.device_key,
    device_secret: pending.device_secret,
    owner_wallet_id: 'wallet_aw_owner',
    registration_pe_id: `pe_device_register_${'e'.repeat(64)}`,
  };

  it('accepts only the exact pending credentials and canonical identities', () => {
    expect(isExactDeviceRegistrationResponse(valid, pending)).toBe(true);
    expect(isExactDeviceRegistrationResponse({
      ...valid,
      device_secret: `pds_${'f'.repeat(64)}`,
    }, pending)).toBe(false);
    expect(isExactDeviceRegistrationResponse({ ...valid, device_name: 'Relabeled' }, pending)).toBe(false);
    expect(isExactDeviceRegistrationResponse({ ...valid, device_id: 'dev_short' }, pending)).toBe(false);
    expect(isExactDeviceRegistrationResponse({ ...valid, owner_wallet_id: '' }, pending)).toBe(false);
    expect(isExactDeviceRegistrationResponse({ ...valid, owner_wallet_id: 'human_owner' }, pending)).toBe(false);
    expect(isExactDeviceRegistrationResponse({ ...valid, registration_pe_id: 'pe_wrong' }, pending)).toBe(false);
  });
});
