import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { createHash } from 'crypto';
import {
  verifyReleaseManifest,
  validateReleaseManifest,
  nodeVersionBelow,
  runSelfUpdateOnce,
  isTransientSelfUpdateOutcome,
  resolveSelfUpdateConfig,
  selfUpdateEntryFor,
  selfUpdateOptedOut,
  RELEASE_PUBLIC_KEY,
  type ReleaseManifest,
  type ReleaseEnvelope,
  type SelfUpdateIO,
} from './self-update';
import { canonicalJson } from './release-signature';
// the rotated release key, and the exposed one it replaced (no longer trusted for anything).
const ROTATED_RELEASE_KEY = '2c7555655c152d8c328b1647a0b06d38a26dd32e48b91fb0e0354d563e7805ce';
const EXPOSED_RELEASE_KEY = '29ade696293550fa238c0443e557429be2df9ce01bfc15b11d2179c08eaceb6d';
// A REAL release the exposed key signed: release 68 exactly as the relay served it on 2026-10-09
// (public data; the test never holds a private key).
const EXPOSED_KEY_RELEASE_68: ReleaseEnvelope = {"manifest": {"version": 68, "issued_at": "2026-10-09T03:57:34.984Z", "bundle": {"sha256": "f63414e4938ed8807024302a33fa2926a725d67b48d688c3499306903d353670", "bytes": 1282375}}, "signature": "1f3a5a28a074812f3a2eda902751b308ba3e6094459f106349b8ef2b43d0a35630c80ec92542bf9db13b5f7c6b48620cef6e1edeb518e925002bc4965396c20d"};

// Throwaway signer standing in for Provian's. The REAL private key lives only in
// Secret Manager; these tests prove the mechanism, never possess the key. The
// orchestrator is exercised against this pub via runSelfUpdateOnce's test seam.
const SIGNER = ed25519.utils.randomPrivateKey();
const SIGNER_PUB = Buffer.from(ed25519.getPublicKey(SIGNER)).toString('hex');

const BUNDLE = Buffer.from('#!/usr/bin/env node\nconsole.log("provian agent bundle v7");\n');
const BUNDLE_SHA = createHash('sha256').update(BUNDLE).digest('hex');

function manifest(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: 7,
    issued_at: '2026-09-13T00:00:00.000Z',
    bundle: { sha256: BUNDLE_SHA, bytes: BUNDLE.length, ...(over.bundle ?? {}) },
    ...('version' in over ? { version: over.version! } : {}),
    ...('issued_at' in over ? { issued_at: over.issued_at! } : {}),
  } as ReleaseManifest;
}

function sign(m: ReleaseManifest, key: Uint8Array = SIGNER): string {
  return Buffer.from(ed25519.sign(new TextEncoder().encode(canonicalJson(m)), key)).toString('hex');
}

function envelope(m: ReleaseManifest = manifest(), key?: Uint8Array): ReleaseEnvelope {
  return { manifest: m, signature: sign(m, key) };
}

describe('verifyReleaseManifest', () => {
  it('accepts a correctly signed, valid, newer manifest', () => {
    const v = verifyReleaseManifest(envelope(), 6, SIGNER_PUB);
    expect(v.accepted).toBe(true);
    expect(v.version).toBe(7);
    expect(v.manifest?.bundle.sha256).toBe(BUNDLE_SHA);
  });

  it('THE CONTROL — a flipped byte in the manifest breaks the signature', () => {
    const env = envelope();
    const tampered = { ...env, manifest: { ...env.manifest, version: 99 } };
    expect(verifyReleaseManifest(tampered, 6, SIGNER_PUB).reason).toBe('bad_signature');
  });

  it('THE CONTROL — a manifest signed by ANYONE ELSE is refused', () => {
    const other = ed25519.utils.randomPrivateKey();
    expect(verifyReleaseManifest(envelope(manifest(), other), 6, SIGNER_PUB).reason).toBe('bad_signature');
  });

  it('THE CONTROL — an unsigned / malformed envelope is refused', () => {
    expect(verifyReleaseManifest({ manifest: manifest(), signature: '' }, 6, SIGNER_PUB).reason)
      .toBe('malformed_envelope');
    expect(verifyReleaseManifest({ manifest: manifest() }, 6, SIGNER_PUB).reason).toBe('malformed_envelope');
  });

  it('refuses a REPLAY of an older signed manifest (monotonic version)', () => {
    expect(verifyReleaseManifest(envelope(), 7, SIGNER_PUB).reason).toBe('not_newer');
    expect(verifyReleaseManifest(envelope(), 9, SIGNER_PUB).reason).toBe('not_newer');
  });

  it('refuses a SIGNED but structurally invalid manifest — origin is not sanity', () => {
    const bad = manifest({ bundle: { sha256: 'not-a-hash', bytes: BUNDLE.length } });
    const v = verifyReleaseManifest(envelope(bad), 6, SIGNER_PUB);
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe('invalid_manifest');
    expect(v.problems?.join(' ')).toMatch(/sha256/);
  });

  it('ONE AUTHORITY — the rotated release key is the pinned default', () => {
    expect(RELEASE_PUBLIC_KEY).toBe(ROTATED_RELEASE_KEY);
    expect(RELEASE_PUBLIC_KEY).not.toBe(EXPOSED_RELEASE_KEY);
    // Signed by our throwaway key but verified against the PINNED one: refused.
    expect(verifyReleaseManifest(envelope(), 6).reason).toBe('bad_signature');
  });

  it('a REAL release signed by the exposed key is refused by the pinned key', () => {
    // Positive control: the same bytes verify under the exposed key, so the refusal below is the
    // key, not a malformed fixture.
    expect(verifyReleaseManifest(EXPOSED_KEY_RELEASE_68, 1, EXPOSED_RELEASE_KEY).accepted).toBe(true);
    const v = verifyReleaseManifest(EXPOSED_KEY_RELEASE_68, 1);
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe('bad_signature');
  });

  it('the orchestrator refuses an exposed-key release before fetching any bundle', async () => {
    let bundleFetches = 0;
    let applied = false;
    const body = EXPOSED_KEY_RELEASE_68;
    const io: SelfUpdateIO = {
      fetchManifest: async () => ({ body, bytes: JSON.stringify(body).length }),
      fetchBundle: async () => { bundleFetches++; return BUNDLE; },
      readCurrent: () => null,
      applyBytes: () => { applied = true; },
      readVersion: () => 1,
      writeVersion: () => undefined,
      reExec: () => undefined,
      log: () => undefined,
      nodeVersion: '22.0.0',
    };
    const out = await runSelfUpdateOnce(io);
    expect(out).toEqual({ status: 'rejected', reason: 'bad_signature' });
    expect(bundleFetches).toBe(0);
    expect(applied).toBe(false);
  });
});

// Cross-package canonicalization parity (pitfall #55): the SDK verifier's
// canonicalJson and the backend signer's stableStringify must produce byte-
// identical output. This pins the sha of a FIXED sample manifest's canonical
// bytes; the backend `release-manifest-signer.test` pins the SAME sha over the
// SAME object. A drift in either canonicalizer breaks one of the two suites.
describe('canonicalization parity with the backend signer (golden vector)', () => {
  it('the sample manifest canonical bytes hash to the pinned sha', () => {
    const SAMPLE = {
      version: 1,
      issued_at: '2026-09-13T00:00:00.000Z',
      bundle: {
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        bytes: 369599,
        node_min: '20.0.0',
      },
    };
    const sha = createHash('sha256').update(canonicalJson(SAMPLE)).digest('hex');
    expect(sha).toBe('a9ec4aad329416ad40ff49360f51796bf595636040977931a4b90f0cb267b6f9');
  });
  it('a manifest carrying observer_measurements (measured observer, 2026-10-10) hashes to the same pinned sha as the backend signer', () => {
    const SAMPLE_MEASURED = {
      version: 1,
      issued_at: '2026-09-13T00:00:00.000Z',
      bundle: { sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', bytes: 369599, node_min: '20.0.0' },
      observer_measurements: [
        { scheme: 'tpm2_quote', measurement: 'sha256:' + '07'.repeat(32), note: 'illustrative measured-boot digest' },
        { scheme: 'gcp_confidential_space', measurement: 'sha256:' + 'ef'.repeat(32) },
      ],
    };
    expect(createHash('sha256').update(canonicalJson(SAMPLE_MEASURED)).digest('hex')).toBe('82dbb1f8eae9e3699bb0a503a8e5b00189f286a0eb8d17f970c526351d86f449');
    // The daemon's validator ignores the field (it is the relay's pricing input, not the daemon's) — a measured release still installs.
    expect(validateReleaseManifest(SAMPLE_MEASURED as unknown as Parameters<typeof validateReleaseManifest>[0]).ok).toBe(true);
  });
});

describe('validateReleaseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateReleaseManifest(manifest())).toEqual({ ok: true, problems: [] });
  });
  it('rejects a bad version / sha / bytes', () => {
    expect(validateReleaseManifest(manifest({ version: 0 })).ok).toBe(false);
    expect(validateReleaseManifest(manifest({ bundle: { sha256: 'zz', bytes: 10 } })).ok).toBe(false);
    expect(validateReleaseManifest(manifest({ bundle: { sha256: BUNDLE_SHA, bytes: 0 } })).ok).toBe(false);
  });
  it('rejects a malformed node_min', () => {
    expect(validateReleaseManifest(manifest({ bundle: { sha256: BUNDLE_SHA, bytes: BUNDLE.length, node_min: 'twenty' } })).ok).toBe(false);
  });
});

describe('nodeVersionBelow', () => {
  it('compares numerically, tolerating a leading v', () => {
    expect(nodeVersionBelow('v18.19.0', '20.0.0')).toBe(true);
    expect(nodeVersionBelow('v20.0.0', '20.0.0')).toBe(false);
    expect(nodeVersionBelow('v26.0.0', '20.0.0')).toBe(false);
  });
});

// A fake IO records every side effect so the decision logic is asserted without
// touching a real file or ever re-exec'ing this test runner.
function fakeIO(over: Partial<SelfUpdateIO> & { bundleForFetch?: Buffer; currentBytes?: Buffer | null } = {}): {
  io: SelfUpdateIO;
  calls: { applied: Buffer[]; reExec: number; versions: number[]; logs: Array<{ level: string; msg: string }> };
} {
  const calls = { applied: [] as Buffer[], reExec: 0, versions: [] as number[], logs: [] as Array<{ level: string; msg: string }> };
  const io: SelfUpdateIO = {
    fetchManifest: over.fetchManifest ?? (async () => ({ body: envelope(), bytes: 200 })),
    fetchBundle: over.fetchBundle ?? (async () => over.bundleForFetch ?? BUNDLE),
    readCurrent: over.readCurrent ?? (() => (over.currentBytes !== undefined ? over.currentBytes : Buffer.from('OLD BYTES'))),
    applyBytes: over.applyBytes ?? ((b) => { calls.applied.push(b); }),
    readVersion: over.readVersion ?? (() => 6),
    writeVersion: over.writeVersion ?? ((v) => { calls.versions.push(v); }),
    reExec: over.reExec ?? (() => { calls.reExec += 1; }),
    log: over.log ?? ((level, msg) => { calls.logs.push({ level, msg }); }),
    nodeVersion: over.nodeVersion ?? 'v26.0.0',
  };
  return { io, calls };
}

describe('runSelfUpdateOnce — the apply decision', () => {
  it('applies a signed, newer, hash-matching bundle and re-execs', async () => {
    const { io, calls } = fakeIO();
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'applied', version: 7 });
    expect(calls.applied).toHaveLength(1);
    expect(calls.applied[0].equals(BUNDLE)).toBe(true);
    expect(calls.versions).toContain(7);
    expect(calls.reExec).toBe(1);
  });

  // THE FAIL-CLOSED CONTROL: the single most important test here. A bundle whose
  // bytes do NOT match the SIGNED manifest's hash is NEVER written and NEVER run —
  // this is what makes "the signed bytes are the only bytes that run" true. If the
  // hash gate were ever removed, this goes red (applyBytes/reExec would fire).
  it('RED CONTROL — a hash-MISMATCHED bundle is refused, never applied, never re-exec', async () => {
    const { io, calls } = fakeIO({ bundleForFetch: Buffer.from('TAMPERED BYTES not the signed ones') });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'rejected', reason: 'bundle_hash_mismatch' });
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
    expect(calls.versions).toHaveLength(0);
  });

  it('RED CONTROL — a wrong-key signature never reaches the bundle at all', async () => {
    const other = ed25519.utils.randomPrivateKey();
    const { io, calls } = fakeIO({ fetchManifest: async () => ({ body: envelope(manifest(), other), bytes: 200 }) });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'rejected', reason: 'bad_signature' });
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
  });

  it('does not apply a manifest that is not newer', async () => {
    const { io, calls } = fakeIO({ readVersion: () => 7 });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out.status).toBe('not_newer');
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
  });

  it('does not apply a bundle that needs a newer Node than this runtime', async () => {
    const m = manifest({ bundle: { sha256: BUNDLE_SHA, bytes: BUNDLE.length, node_min: '99.0.0' } });
    const { io, calls } = fakeIO({ fetchManifest: async () => ({ body: envelope(m), bytes: 200 }) });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out.status).toBe('node_too_old');
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
  });

  // No re-exec loop: if the running file ALREADY is the signed bytes, record the
  // version and stop — never swap identical bytes and re-exec.
  it('already-current bytes → records version, no swap, no re-exec', async () => {
    const { io, calls } = fakeIO({ currentBytes: BUNDLE });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'already_current', version: 7 });
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
    expect(calls.versions).toContain(7);
  });

  it('a manifest fetch fault leaves the daemon running (no_manifest)', async () => {
    const { io, calls } = fakeIO({ fetchManifest: async () => { throw new Error('ECONNREFUSED'); } });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out.status).toBe('no_manifest');
    expect(calls.applied).toHaveLength(0);
  });

  it('an over-cap manifest body is refused before verifying', async () => {
    const { io, calls } = fakeIO({ fetchManifest: async () => ({ body: envelope(), bytes: 999_999 }) });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'rejected', reason: 'too_large' });
    expect(calls.applied).toHaveLength(0);
  });

  // (1B): a 409 from the relay (manifest exists, its bundle not yet in place on
  // the serving revision) surfaces as `pending: true`. The updater must NOT fetch a
  // bundle it knows cannot match — it returns pending_bundle so the loop retries.
  it('pending_bundle — a 409 (bundle not in place) fetches NO bundle and applies nothing', async () => {
    let bundleFetched = false;
    const { io, calls } = fakeIO({
      fetchManifest: async () => ({ body: null, bytes: 0, pending: true }),
      fetchBundle: async () => { bundleFetched = true; return BUNDLE; },
    });
    const out = await runSelfUpdateOnce(io, SIGNER_PUB);
    expect(out).toEqual({ status: 'pending_bundle' });
    expect(bundleFetched).toBe(false);
    expect(calls.applied).toHaveLength(0);
    expect(calls.reExec).toBe(0);
  });
});

describe('isTransientSelfUpdateOutcome ((1B)) — which outcomes warrant a FAST retry', () => {
  it('TRANSIENT: pending_bundle, bundle_hash_mismatch, bundle_fetch_failed, apply_failed', () => {
    expect(isTransientSelfUpdateOutcome({ status: 'pending_bundle' })).toBe(true);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'bundle_hash_mismatch' })).toBe(true);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'bundle_fetch_failed' })).toBe(true);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'apply_failed' })).toBe(true);
  });

  // RED CONTROL: a terminal outcome must NOT fast-retry (else a machine with genuinely
  // no update, or a bad-signature manifest, would poll every minute forever).
  it('TERMINAL (control): no_manifest / not_newer / already_current / node_too_old / signature+structure rejections', () => {
    expect(isTransientSelfUpdateOutcome({ status: 'no_manifest' })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'not_newer', version: 7 })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'already_current', version: 7 })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'node_too_old', need: '99.0.0', have: 'v20.0.0' })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'applied', version: 7 })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'bad_signature' })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'invalid_manifest' })).toBe(false);
    expect(isTransientSelfUpdateOutcome({ status: 'rejected', reason: 'too_large' })).toBe(false);
  });
});

describe('resolveSelfUpdateConfig — DEFAULT ON, opt-out (close, the operator )', () => {
  it('ON by default — no env var at all', () => {
    // The reversal: the fix must land on every machine with no user action, so an
    // UNSET variable means ON. (Under the old opt-in, this returned null.)
    const c = resolveSelfUpdateConfig({}, '/home/me/.provian/agent.js');
    expect(c?.targetPath).toBe('/home/me/.provian/agent.js');
    expect(c?.pollIntervalMs).toBeGreaterThan(0);
  });
  it('THE OPT-OUT CONTROL — OFF only when explicitly opted out', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(resolveSelfUpdateConfig({ PROVIAN_SELF_UPDATE: v }, '/home/me/.provian/agent.js')).toBeNull();
    }
  });
  it('stays ON for any non-opt-out value (including the old "1")', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      expect(resolveSelfUpdateConfig({ PROVIAN_SELF_UPDATE: v }, '/home/me/.provian/agent.js')?.targetPath)
        .toBe('/home/me/.provian/agent.js');
    }
  });
  it('honors an explicit target override', () => {
    const c = resolveSelfUpdateConfig(
      { PROVIAN_SELF_UPDATE_TARGET: '/opt/provian/agent.js' },
      '/home/me/.provian/agent.js',
    );
    expect(c?.targetPath).toBe('/opt/provian/agent.js');
  });
  it('inert when there is no target to replace — NOT the same as opting out', () => {
    // A missing bundle target yields null regardless of opt-in/out: nothing safe
    // to swap. This is "no bundle", not "disabled".
    expect(resolveSelfUpdateConfig({}, undefined)).toBeNull();
  });
});

describe('selfUpdateOptedOut', () => {
  it('true only for explicit opt-out values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'NO', '  0 ']) expect(selfUpdateOptedOut(v)).toBe(true);
  });
  it('false for unset and every non-opt-out value (default-on)', () => {
    for (const v of [undefined, '', '1', 'true', 'on', 'enabled', 'x']) {
      expect(selfUpdateOptedOut(v)).toBe(false);
    }
  });
});

describe('selfUpdateEntryFor — only the hosted bundle is a swappable entry (2026-10-10)', () => {
  it('GREEN: inside the hosted bundle the running entry is the target', () => {
    expect(selfUpdateEntryFor(true, '/home/me/.provian/agent.js')).toBe('/home/me/.provian/agent.js');
    expect(resolveSelfUpdateConfig({}, selfUpdateEntryFor(true, '/home/me/.provian/agent.js'))?.targetPath).toBe('/home/me/.provian/agent.js');
  });
  it('RED: an npm / tarball install (dist/scripts/start-observer.js) is never swapped for the bundle', () => {
    const npmEntry = '/home/me/sdk/node_modules/@provian/agent-sdk/dist/scripts/start-observer.js';
    expect(selfUpdateEntryFor(false, npmEntry)).toBeUndefined();
    expect(resolveSelfUpdateConfig({}, selfUpdateEntryFor(false, npmEntry))).toBeNull();
    // the control: the same entry WOULD have been taken under the old rule
    expect(resolveSelfUpdateConfig({}, npmEntry)?.targetPath).toBe(npmEntry);
  });
  it('an explicit PROVIAN_SELF_UPDATE_TARGET still overrides on either install', () => {
    expect(resolveSelfUpdateConfig({ PROVIAN_SELF_UPDATE_TARGET: '/opt/agent.js' }, selfUpdateEntryFor(false, '/x/start-observer.js'))?.targetPath).toBe('/opt/agent.js');
  });
});
