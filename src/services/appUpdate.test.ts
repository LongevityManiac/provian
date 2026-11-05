import { describe, it, expect } from 'vitest';
import { evaluateUpdate, parseVersionManifest, type VersionManifest } from './appUpdate';

const manifest = (over: Partial<VersionManifest> = {}): VersionManifest => ({
  latestVersionCode: 5,
  latestVersionName: '1.0.5',
  minSupportedVersionCode: 0,
  downloadUrl: 'https://provian.ai/download',
  ...over,
});

describe('evaluateUpdate', () => {
  it('is up_to_date when installed == latest', () => {
    expect(evaluateUpdate(5, manifest()).kind).toBe('up_to_date');
  });

  it('is up_to_date when installed > latest (dev/ahead build never nagged)', () => {
    expect(evaluateUpdate(9, manifest()).kind).toBe('up_to_date');
  });

  it('offers update_available when installed < latest', () => {
    const d = evaluateUpdate(3, manifest({ latestVersionName: '1.0.5' }));
    expect(d.kind).toBe('update_available');
    if (d.kind !== 'up_to_date') {
      expect(d.latestVersionName).toBe('1.0.5');
      expect(d.downloadUrl).toBe('https://provian.ai/download');
    }
  });

  it('escalates to update_required when installed < minSupportedVersionCode', () => {
    const d = evaluateUpdate(2, manifest({ minSupportedVersionCode: 4, latestVersionCode: 5 }));
    expect(d.kind).toBe('update_required');
  });

  it('required takes precedence over available', () => {
    // installed(1) < min(3) AND < latest(5) → required, not merely available
    const d = evaluateUpdate(1, manifest({ minSupportedVersionCode: 3, latestVersionCode: 5 }));
    expect(d.kind).toBe('update_required');
  });

  it('at the min boundary (installed == min) is NOT required', () => {
    const d = evaluateUpdate(4, manifest({ minSupportedVersionCode: 4, latestVersionCode: 5 }));
    expect(d.kind).toBe('update_available'); // still behind latest, but not forced
  });

  // Fail-safe: never nag/block on bad data (a wallet must not lock out on a bad manifest)
  it('is up_to_date when manifest is null', () => {
    expect(evaluateUpdate(1, null).kind).toBe('up_to_date');
  });

  it('is up_to_date when installedVersionCode is NaN/invalid', () => {
    expect(evaluateUpdate(Number.NaN, manifest()).kind).toBe('up_to_date');
  });
});

describe('parseVersionManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseVersionManifest({
      latestVersionCode: 7,
      latestVersionName: '1.0.7',
      minSupportedVersionCode: 3,
      downloadUrl: 'https://provian.ai/download',
      notes: 'security fix',
    });
    expect(m).not.toBeNull();
    expect(m?.latestVersionCode).toBe(7);
    expect(m?.minSupportedVersionCode).toBe(3);
  });

  it('defaults minSupportedVersionCode to 0 when absent', () => {
    const m = parseVersionManifest({
      latestVersionCode: 7,
      latestVersionName: '1.0.7',
      downloadUrl: 'https://provian.ai/download',
    });
    expect(m?.minSupportedVersionCode).toBe(0);
  });

  it('rejects a non-https downloadUrl (no plaintext update pointer)', () => {
    expect(
      parseVersionManifest({
        latestVersionCode: 7,
        latestVersionName: '1.0.7',
        downloadUrl: 'http://provian.ai/download',
      }),
    ).toBeNull();
  });

  it('rejects missing/garbage shapes', () => {
    expect(parseVersionManifest(null)).toBeNull();
    expect(parseVersionManifest('nope')).toBeNull();
    expect(parseVersionManifest({ latestVersionName: '1.0.0' })).toBeNull(); // no code
    expect(parseVersionManifest({ latestVersionCode: 'x', latestVersionName: '1', downloadUrl: 'https://provian.ai' })).toBeNull();
  });
});
