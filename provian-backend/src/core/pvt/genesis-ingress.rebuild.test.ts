/**
 * PE METER: a registration's first PE is never stored by the relay. A replay rebuilds it from the
 * marker (human) or marker + device record (device) and must hash to the marker's pe hash — a
 * metered registration as a v2 act, a pre-meter one as its v1 content. Anything else is refused.
 */
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  rebuildDeviceRegistrationPE,
  rebuildHumanRegistrationPE,
  type DeviceRegistrationMarker,
  type HumanRegistrationMarker,
} from './genesis-ingress';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const KEY = 'a'.repeat(128);
const ADDR = '0x1111111111111111111111111111111111111111';

function humanMarker(peHash: string): HumanRegistrationMarker {
  return {
    schema_version: 'human-wallet-registration/v2',
    user_id: 'user-1',
    request_fingerprint: 'b'.repeat(64),
    wallet_id: 'wallet-1',
    pe_id: 'pe_1',
    pe_hash: peHash,
    prev_hash: 'genesis',
    address: ADDR,
    public_key_sha256: sha256(KEY),
    economic_device_id: null,
    created_at_ms: 1_790_000_000_000,
    genesis_qualification_id: null,
    standard_accrual_status: 'complete',
    standard_accrual_acknowledged_at_ms: 1_790_000_000_001,
  };
}

describe('rebuildHumanRegistrationPE', () => {
  const legacyContent = {
    id: 'pe_1', wallet_id: 'wallet-1', user_id: 'user-1', action_type: 'wallet_created',
    actor_address: ADDR, timestamp: 1_790_000_000_000, prev_hash: 'genesis',
    attestation_type: 'software', metadata: { wallet_type: 'human', public_key: KEY },
  };

  it('a pre-meter registration rebuilds its v1 PE from the marker', () => {
    const marker = humanMarker(sha256(stableStringify(legacyContent) || ''));
    const out = rebuildHumanRegistrationPE(marker, KEY);
    expect(out.meter).toBe(false);
    expect(out.pe).toMatchObject({ id: 'pe_1', hash: marker.pe_hash });
  });

  it('RED: a marker whose hash matches neither scheme is refused', () => {
    expect(() => rebuildHumanRegistrationPE(humanMarker('f'.repeat(64)), KEY))
      .toThrow(expect.objectContaining({ code: 'human_wallet_registration_pe_invalid' }));
  });

  it('RED: a different public key does not rebuild the same PE', () => {
    const marker = humanMarker(sha256(stableStringify(legacyContent) || ''));
    expect(() => rebuildHumanRegistrationPE(marker, 'c'.repeat(128)))
      .toThrow(expect.objectContaining({ code: 'human_wallet_registration_pe_invalid' }));
  });
});

describe('rebuildDeviceRegistrationPE', () => {
  const device = {
    owner_address: ADDR, device_name: 'Box', device_type: 'coding_workstation',
    platform: 'linux', attestation_capability: 'software',
  };
  const legacy = {
    id: 'pe_d', wallet_id: 'wallet-1', action_type: 'device_register', actor_address: ADDR,
    timestamp: 1_790_000_000_000, prev_hash: 'genesis', attestation_type: 'software',
    metadata: {
      device_id: 'dev_1', device_name: 'Box', device_type: 'coding_workstation', platform: 'linux',
      attestation_capability: 'software', owner_type: 'human', attribution_model: 'device_owner',
    },
  };
  const marker = (peHash: string): DeviceRegistrationMarker => ({
    schema_version: 'device-registration-request/v1',
    request_id: 'req_1', request_fingerprint: 'b'.repeat(64), owner_user_id: 'user-1',
    owner_wallet_id: 'wallet-1', owner_type: 'human', device_id: 'dev_1', pe_id: 'pe_d',
    pe_hash: peHash, prev_hash: 'genesis', device_key_prefix: 'pdk_1',
    created_at_ms: 1_790_000_000_000, genesis_qualification_id: null,
  });

  it('a pre-meter registration rebuilds its v1 PE', () => {
    const out = rebuildDeviceRegistrationPE(marker(sha256(stableStringify(legacy) || '')), device);
    expect(out.meter).toBe(false);
  });

  it('RED: a rewritten device record no longer rebuilds the PE', () => {
    expect(() => rebuildDeviceRegistrationPE(
      marker(sha256(stableStringify(legacy) || '')),
      { ...device, platform: 'windows' },
    )).toThrow(expect.objectContaining({ code: 'device_registration_pe_invalid' }));
  });
});
