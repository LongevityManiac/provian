/**
 * buildDeviceCaptureStatus — coercion of the untrusted capture-status report a
 * device's observer daemon PUTs to /v1/devices/me/capture-status.
 *
 * Display-only field, but a device is still an untrusted client: every value
 * must be type-coerced so a daemon can never write a raw string/object/number
 * onto its device doc.
 */

import { describe, it, expect } from '@jest/globals';
import { buildDeviceCaptureStatus } from './devices';

describe('buildDeviceCaptureStatus', () => {
  it('passes through a well-formed daemon report and stamps updated_at server-side', () => {
    const out = buildDeviceCaptureStatus(
      {
        llm_session_enabled: true,
        platform: 'darwin',
        active: true,
        permissions_checked: true,
        accessibility: false,
        input_monitoring: true,
      },
      'linux',
      1234,
    );
    expect(out).toEqual({
      llm_session_enabled: true,
      platform: 'darwin',
      active: true,
      permissions_checked: true,
      accessibility: false,
      input_monitoring: true,
      updated_at: 1234,
    });
  });

  it('NEGATIVE CONTROL: non-boolean fields coerce to false (never leak a raw type)', () => {
    const out = buildDeviceCaptureStatus(
      {
        llm_session_enabled: 'true',
        active: 1,
        permissions_checked: 'yes',
        accessibility: {},
        input_monitoring: null,
      },
      'darwin',
      1,
    );
    expect(out.llm_session_enabled).toBe(false);
    expect(out.active).toBe(false);
    expect(out.permissions_checked).toBe(false);
    expect(out.accessibility).toBe(false);
    expect(out.input_monitoring).toBe(false);
  });

  it('falls back to the registered device platform for an absent/non-string platform, and bounds length', () => {
    expect(buildDeviceCaptureStatus({}, 'win32', 1).platform).toBe('win32');
    expect(buildDeviceCaptureStatus({ platform: 123 }, 'win32', 1).platform).toBe('win32');
    expect(buildDeviceCaptureStatus({ platform: 'x'.repeat(100) }, 'win32', 1).platform.length).toBe(32);
  });

  it('handles a non-object body (null / string / array) without throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, ['a']]) {
      const out = buildDeviceCaptureStatus(bad, 'darwin', 7);
      expect(out.active).toBe(false);
      expect(out.platform).toBe('darwin');
      expect(out.updated_at).toBe(7);
    }
  });

  it('persists advisory SDK-staleness fields when the daemon reports a version', () => {
    const out = buildDeviceCaptureStatus(
      { sdk_version: '1.4.0', sdk_stale: true, sdk_below_min: false },
      'darwin',
      1,
    );
    expect(out.sdk_version).toBe('1.4.0');
    expect(out.sdk_stale).toBe(true);
    expect(out.sdk_below_min).toBe(false);
  });

  it('NEGATIVE CONTROL: omits SDK fields entirely when no version is reported (no misleading false)', () => {
    // Without a version string the fields must be ABSENT, not written as false —
    // an older SDK that never reports them must not look "not stale".
    const out = buildDeviceCaptureStatus({ sdk_stale: true }, 'darwin', 1);
    expect(out.sdk_version).toBeUndefined();
    expect(out.sdk_stale).toBeUndefined();
    expect(out.sdk_below_min).toBeUndefined();
  });

  it('boolean-coerces the SDK flags and bounds the version string', () => {
    const out = buildDeviceCaptureStatus(
      { sdk_version: 'x'.repeat(100), sdk_stale: 'yes', sdk_below_min: 1 },
      'darwin',
      1,
    );
    expect(out.sdk_version!.length).toBe(32);
    expect(out.sdk_stale).toBe(false); // 'yes' is not === true
    expect(out.sdk_below_min).toBe(false); // 1 is not === true
  });
});
