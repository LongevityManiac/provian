/**
 * writeCredentialsToProfile — the shell-profile credentials block must export
 * PROVIAN_DEVICE_ID alongside the key/secret.
 *
 * Bug (found in the invite-path recon): the block exported PROVIAN_DEVICE_KEY /
 * _SECRET / _RELAY_URL but NOT _DEVICE_ID. An operator who runs the observer
 * from those env vars alone (no ~/.provian/credentials file) then gets
 * config.credentials.deviceId = undefined, so ProvianObserver derives a null
 * attestedDeviceId + no ordinal store and economic_session_lineage mints NULL
 * for every observed PE — the exact end-state the invite path must reach
 * (a durably-reserved ordinal so lineage mints non-null) silently fails.
 * The file-write path always persisted device_id; the shell-profile path must too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCredentialsToProfile } from './register-device';
import { mintSessionLineageClaim } from '../observer/session-lineage';

describe('writeCredentialsToProfile', () => {
  let dir: string;
  let profile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-cred-profile-'));
    profile = path.join(dir, '.zshrc');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports PROVIAN_DEVICE_ID alongside key/secret/relay', () => {
    writeCredentialsToProfile(
      profile, 'pdk_key', 'pds_secret', 'https://api.provian.ai', 'atlas-mac-mini', 'dev_abc123',
    );
    const content = fs.readFileSync(profile, 'utf-8');
    expect(content).toContain('export PROVIAN_DEVICE_KEY=pdk_key');
    expect(content).toContain('export PROVIAN_DEVICE_SECRET=pds_secret');
    expect(content).toContain('export PROVIAN_RELAY_URL=https://api.provian.ai');
    // The fix: the device id — without which lineage mints null — is exported.
    expect(content).toContain('export PROVIAN_DEVICE_ID=dev_abc123');
  });

  // NEGATIVE CONTROL: the DEVICE_ID line is conditional; an empty id emits no
  // bogus `export PROVIAN_DEVICE_ID=` line, while key/secret still export.
  it('NEGATIVE CONTROL: no device id → no PROVIAN_DEVICE_ID line', () => {
    writeCredentialsToProfile(profile, 'pdk_key', 'pds_secret', 'https://api.provian.ai', 'd', '');
    const content = fs.readFileSync(profile, 'utf-8');
    expect(content).toContain('export PROVIAN_DEVICE_KEY=pdk_key');
    expect(content).not.toContain('PROVIAN_DEVICE_ID');
  });

  // The dependency the fix serves: a present device id is what lets lineage
  // mint non-null; its absence is the null-lineage failure the bug caused.
  it('device id present → lineage mints non-null; absent → null (why the export matters)', () => {
    const withId = mintSessionLineageClaim({
      attestedDeviceId: 'dev_abc123', sessionStartedAtMs: 1_700_000_000_000, sessionOrdinal: 1,
      nonce: '0'.repeat(32),
    });
    expect(withId).not.toBeNull();

    const withoutId = mintSessionLineageClaim({
      attestedDeviceId: null, sessionStartedAtMs: 1_700_000_000_000, sessionOrdinal: 1,
      nonce: '0'.repeat(32),
    });
    expect(withoutId).toBeNull();
  });
});
