/**
 * Agent-SDK version advertisement — relay side.
 *
 * Every assertion here ships with a RED negative control: a test that has only
 * ever been GREEN proves nothing. For each "flags X" we also assert the
 * guard does NOT flag the complementary case, so a hard-wired `return true`
 * would fail.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  SDK_LATEST,
  SDK_MIN_SUPPORTED,
  sdkVersionInfo,
  parseSemver,
  compareSemver,
  evaluateSdkVersion,
} from './sdk-version';

describe('parseSemver', () => {
  it('parses X.Y.Z and tolerates a v-prefix / pre-release suffix', () => {
    expect(parseSemver('1.5.0')).toEqual([1, 5, 0]);
    expect(parseSemver('v2.0.3')).toEqual([2, 0, 3]);
    expect(parseSemver('1.5.0-rc.1')).toEqual([1, 5, 0]);
    expect(parseSemver('1.4')).toEqual([1, 4, 0]);
  });

  it('RED control: returns null for garbage (does NOT coerce to a version)', () => {
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('1.x.0')).toBeNull();
    expect(parseSemver('1.2.3.4')).toBeNull();
    // The proof this isn't hardwired: a real version DOES parse.
    expect(parseSemver('0.0.1')).toEqual([0, 0, 1]);
  });
});

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('1.4.0', '1.5.0')).toBeLessThan(0);
    expect(compareSemver('1.5.0', '1.5.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.5.1', '1.5.0')).toBeGreaterThan(0);
  });

  it('fail-open: unparseable operand compares equal (never trips a check)', () => {
    expect(compareSemver('garbage', '1.5.0')).toBe(0);
    expect(compareSemver('1.5.0', '')).toBe(0);
  });
});

describe('evaluateSdkVersion', () => {
  it('flags a stale-but-supported version', () => {
    const v = evaluateSdkVersion('1.4.0'); // < latest 1.5.0, >= min 1.0.0
    expect(v.stale).toBe(true);
    expect(v.belowMin).toBe(false);
  });

  it('flags a below-minimum version (RED control for the belowMin guard)', () => {
    // Feed a deliberately-violating input and assert the guard REPORTS it.
    const v = evaluateSdkVersion('0.9.0'); // < min 1.0.0
    expect(v.belowMin).toBe(true);
    expect(v.stale).toBe(true); // below min is also below latest
  });

  it('does NOT flag the current version — proves the guard can be GREEN', () => {
    const v = evaluateSdkVersion(SDK_LATEST);
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });

  it('does NOT flag a version ahead of latest', () => {
    const v = evaluateSdkVersion('9.9.9');
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });

  it('fail-open: an unparseable client version is never flagged', () => {
    const v = evaluateSdkVersion('unknown');
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });

  it('carries the advertised targets and upgrade command through', () => {
    const v = evaluateSdkVersion('1.0.0');
    expect(v.latest).toBe(SDK_LATEST);
    expect(v.minSupported).toBe(SDK_MIN_SUPPORTED);
    expect(v.upgradeCommand).toContain('@provian/agent-sdk');
  });
});

describe('sdkVersionInfo payload', () => {
  it('exposes latest / minSupported / upgrade command / notes', () => {
    const info = sdkVersionInfo();
    expect(info.latest).toBe(SDK_LATEST);
    expect(info.minSupported).toBe(SDK_MIN_SUPPORTED);
    expect(info.upgradeCommand).toContain('npm');
    expect(typeof info.notes).toBe('string');
  });
});

describe('cross-package drift guard', () => {
  it('SDK_LATEST matches the actual @provian/agent-sdk package version', () => {
    // The relay's advertised "latest" MUST equal the SDK it points agents at.
    // RED control: bump the SDK package.json without bumping SDK_LATEST -> fail.
    const pkgPath = path.resolve(__dirname, '../../../provian-agent-sdk/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.name).toBe('@provian/agent-sdk');
    expect(SDK_LATEST).toBe(pkg.version);
  });

  it('minSupported is <= latest (never advertise an impossible floor)', () => {
    expect(compareSemver(SDK_MIN_SUPPORTED, SDK_LATEST)).toBeLessThanOrEqual(0);
  });
});
