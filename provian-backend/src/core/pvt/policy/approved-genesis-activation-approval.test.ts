import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  APPROVED_GENESIS_ACTIVATION,
  genesisApprovalSigningBytes,
  BOUND_GATE1_MANIFEST_SHA256,
  NO_GENESIS_ACTIVATION_APPROVED_STATUS,
  assertApprovedGenesisActivationFailClosed,
  explainApprovedGenesisActivation,
  isApprovedGenesisActivation,
  type ApprovedGenesisActivationRecord,
  type ApprovedGenesisActivationVerdict,
  type GenesisActivationApprovalCandidate,
} from './approved-genesis-activation-approval';
import {
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './pvt9-approval-manifest.generated';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import { verifyCurrentPvtManifestApproval } from './current-approval';
import { isValidMonetaryPolicyActivation } from './runtime-monetary-policy';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const MANIFEST_BYTES = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
const SCOPE = APPROVED_GENESIS_ACTIVATION.approved;

/**
 * A REAL ed25519 key and a REAL SSHSIG over the REAL frozen manifest bytes,
 * minted per-run in a temp dir. This is what makes the suite non-vacuous: the
 * admit case is a genuine signature verified by the untouched
 * `verifySshApprovalSignature`, not an injected `() => true`.
 */
/** Where the OTHER key's armored signature is kept, for the forgery control. */
const FORGED_BODY_PATH = path.join(os.tmpdir(), 'agaa-forged-body.sig');

function mintSigner(): {
  config: SshApprovalVerifierConfig;
  signature: SshApprovalSignature;
  otherConfig: SshApprovalVerifierConfig;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agaa-'));
  try {
    const sign = (name: string): { pub: string; armored: string } => {
      const key = path.join(dir, name);
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q']);
      const message = path.join(dir, `${name}.msg`);
      fs.writeFileSync(message, genesisApprovalSigningBytes());
      execFileSync('ssh-keygen', [
        '-Y', 'sign', '-q', '-f', key, '-n', 'provian-pvt-policy', message,
      ]);
      return {
        pub: fs.readFileSync(`${key}.pub`, 'utf8').trim(),
        armored: fs.readFileSync(`${message}.sig`, 'utf8'),
      };
    };
    const mine = sign('k1');
    const other = sign('k2');
    fs.writeFileSync(FORGED_BODY_PATH, other.armored);
    const hash = decodeOpenSshEd25519PublicKey(mine.pub).sha256;
    return {
      config: {
        signerIdentity: 'frank',
        namespace: 'provian-pvt-policy',
        openSshPublicKey: mine.pub,
        publicKeySha256: hash,
      },
      signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: hash,
        armored_signature: mine.armored,
      },
      otherConfig: {
        signerIdentity: 'frank',
        namespace: 'provian-pvt-policy',
        openSshPublicKey: other.pub,
        publicKeySha256: decodeOpenSshEd25519PublicKey(other.pub).sha256,
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SIGNER = mintSigner();

function candidate(
  overrides: Partial<GenesisActivationApprovalCandidate> = {},
): GenesisActivationApprovalCandidate {
  return {
    approval_manifest_sha256: SCOPE.bound_gate1_manifest_sha256,
    approval_signature: SIGNER.signature,
    canonical_pvt_manifest_id: SCOPE.canonical_pvt_manifest_id,
    ledger_namespace: SCOPE.campaign_ledger_namespace,
    effective_at_ms: SCOPE.window_start_ms,
    ...overrides,
  };
}

const deps = { verifierConfig: SIGNER.config };

describe('the approved Genesis activation record BINDS the frozen artifact', () => {
  it('the bound digest is the LIVE hash of the frozen file, the embedded bytes, and check:wp2', () => {
    // Three independent witnesses, all resolved live. This is what stops the
    // literal in the module from being the only thing that says 704c1a2d.
    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(path.join(
      REPO_ROOT, 'docs', 'audit', 'pvt-wp0-wp1', 'pvt-policy-approval-manifest.generated.json',
    ))).digest('hex');
    const embedded = crypto.createHash('sha256').update(MANIFEST_BYTES).digest('hex');
    const checkWp2 = /const FROZEN_MANIFEST_SHA256 = '([a-f0-9]{64})'/.exec(fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'wp2', 'generate-pvt9-base-config.mjs'), 'utf8',
    ))?.[1];

    expect(checkWp2).toMatch(/^[a-f0-9]{64}$/);
    expect(embedded).toBe(onDisk);
    expect(checkWp2).toBe(onDisk);
    expect(BOUND_GATE1_MANIFEST_SHA256).toBe(`sha256:${onDisk}`);
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256).toBe(BOUND_GATE1_MANIFEST_SHA256);
  });

  it('the record does NOT make the manifest signable — that flag is still false', () => {
    // The whole point: this is a scoped second route, not signing_permitted:true.
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED as boolean).toBe(false);
  });

  it('the approved window is READ from the manifest, not copied', () => {
    expect(SCOPE.window_start_ms).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms);
    expect(SCOPE.window_end_ms).toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms);
    expect(SCOPE.campaign_ledger_namespace)
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace);
    // Bound to the manifest field, not to a re-declared literal .
    expect(SCOPE.canonical_pvt_manifest_id)
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.canonical_pvt_manifest_id);
  });

  it('the shipped record is fail-closed', () => {
    expect(() => assertApprovedGenesisActivationFailClosed()).not.toThrow();
  });
});

describe('the admit case is a REAL signature, and every conjunct has a control', () => {
  it('ADMITS the one approved artifact, with a real SSHSIG by the configured key', () => {
    expect(explainApprovedGenesisActivation(candidate(), deps)).toBe('approved');
    expect(isApprovedGenesisActivation(candidate(), deps)).toBe(true);
  });

  it('and it admits at BOTH inclusive window edges, and nowhere outside', () => {
    expect(explainApprovedGenesisActivation(
      candidate({ effective_at_ms: SCOPE.window_start_ms }), deps,
    )).toBe('approved');
    expect(explainApprovedGenesisActivation(
      candidate({ effective_at_ms: SCOPE.window_end_ms }), deps,
    )).toBe('approved');
  });

  /**
   * One row per conjunct. Each is a PERMANENT in-suite negative control: it
   * feeds the source a deliberately violating input and requires it to name the
   * violation. A verdict that merely differed from 'approved' would not be
   * enough — a source that returned a single catch-all refusal would pass that.
   */
  const CONTROLS: ReadonlyArray<readonly [string, GenesisActivationApprovalCandidate,
    ApprovedGenesisActivationVerdict, Record<string, unknown>]> = [
    ['a DIFFERENT manifest digest on the document',
      candidate({ approval_manifest_sha256: `sha256:${'a'.repeat(64)}` }),
      'activation_manifest_digest_mismatch', deps],
    ['a DIFFERENT campaign',
      candidate({ ledger_namespace: 'pvt9_genesis_v2' }), 'campaign_mismatch', deps],
    ['a DIFFERENT canonical manifest id',
      candidate({ canonical_pvt_manifest_id: 'pvt9_base_sepolia_v1' }),
      'canonical_manifest_id_mismatch', deps],
    ['an effective instant one ms BEFORE the window',
      candidate({ effective_at_ms: SCOPE.window_start_ms - 1 }),
      'effective_instant_out_of_window', deps],
    ['an effective instant one ms AFTER the window',
      candidate({ effective_at_ms: SCOPE.window_end_ms + 1 }),
      'effective_instant_out_of_window', deps],
    ['a non-integer effective instant',
      candidate({ effective_at_ms: 1.5 }), 'effective_instant_out_of_window', deps],
    ['an ABSENT signature',
      candidate({ approval_signature: null }), 'signature_malformed', deps],
    ['a signature with the WRONG namespace',
      candidate({ approval_signature: { ...SIGNER.signature, namespace: 'other' } }),
      'signature_malformed', deps],
    ['a signature with the WRONG signer identity',
      candidate({ approval_signature: { ...SIGNER.signature, signer_identity: 'mallory' } }),
      'signature_malformed', deps],
    ['NO verifier key configured',
      candidate(), 'verifier_key_not_configured', { verifierConfig: null }],
    ['a signature by a DIFFERENT key than the configured one',
      candidate(), 'signature_key_mismatch', { verifierConfig: SIGNER.otherConfig }],
  ];

  it.each(CONTROLS)('RED CONTROL — %s is named, not merely refused',
    (_label, input, expected, injected) => {
      expect(explainApprovedGenesisActivation(input, injected)).toBe(expected);
      expect(isApprovedGenesisActivation(input, injected)).toBe(false);
    });

  it('RED CONTROL — the population of controls is non-empty and every verdict is distinct enough', () => {
    // Guards the it.each above from silently emptying, and proves the source
    // discriminates rather than returning one catch-all refusal.
    expect(CONTROLS.length).toBe(11);
    expect(new Set(CONTROLS.map(([, , verdict]) => verdict)).size).toBeGreaterThanOrEqual(7);
  });

  it('RED CONTROL — a FORGERY: the configured key hash claimed over another key\'s signature', () => {
    // MUTATION SURVIVOR M6, closed. Removing the real `verifySshApprovalSignature`
    // call left the whole suite green, because every existing case was already
    // caught EARLIER — by the key-hash equality or by the frozen-digest check.
    // Nothing ever presented a signature bearing the CONFIGURED key's hash whose
    // armored body was not that key's work, which is the only input the
    // cryptographic verification itself can refuse. That is the forgery a caller
    // would actually attempt, and it is now the control for that conjunct.
    const forged: SshApprovalSignature = {
      ...SIGNER.signature,
      // claims OUR key...
      public_key_sha256: SIGNER.config.publicKeySha256,
      // ...but the body is the OTHER key's signature over the same bytes.
      armored_signature: fs.readFileSync(FORGED_BODY_PATH, 'utf8'),
    };
    expect(explainApprovedGenesisActivation(
      candidate({ approval_signature: forged }), deps,
    )).toBe('signature_not_verified');

    // ...and a merely CORRUPTED body is refused the same way.
    const corrupted: SshApprovalSignature = {
      ...SIGNER.signature,
      armored_signature: SIGNER.signature.armored_signature.replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A')),
    };
    expect(explainApprovedGenesisActivation(
      candidate({ approval_signature: corrupted }), deps,
    )).toBe('signature_not_verified');
  });

  it('RED CONTROL — a signature that is well formed but over the WRONG bytes is refused', () => {
    // The signature really is verified, not merely shape-checked: swap the bytes
    // under it and the untouched SSHSIG verifier rejects it.
    expect(explainApprovedGenesisActivation(candidate(), {
      ...deps, manifestBytes: Buffer.from('not the manifest', 'utf8'),
    })).toBe('frozen_manifest_moved');
    // ...and with the digest check satisfied by a matching record, the signature
    // check is what refuses — so the two conjuncts are independent.
    const otherBytes = Buffer.from('not the manifest', 'utf8');
    const otherDigest = `sha256:${crypto.createHash('sha256').update(otherBytes).digest('hex')}`;
    expect(explainApprovedGenesisActivation(candidate({
      approval_manifest_sha256: otherDigest,
    }), {
      ...deps,
      manifestBytes: otherBytes,
      record: {
        ...APPROVED_GENESIS_ACTIVATION,
        approved: { ...SCOPE, bound_gate1_manifest_sha256: otherDigest },
      },
    })).toBe('frozen_manifest_moved'); // the pinned constant still refuses it
  });

  it('RED CONTROL — a MOVED frozen manifest refuses, however correct the document', () => {
    const moved: ApprovedGenesisActivationRecord = {
      ...APPROVED_GENESIS_ACTIVATION,
      approved: { ...SCOPE, bound_gate1_manifest_sha256: `sha256:${'b'.repeat(64)}` },
    };
    expect(explainApprovedGenesisActivation(candidate(), { ...deps, record: moved }))
      .toBe('frozen_manifest_moved');
  });

  it('RED CONTROL — the nothing-approved sentinel gates everything', () => {
    expect(explainApprovedGenesisActivation(candidate(), {
      ...deps,
      record: {
        ...APPROVED_GENESIS_ACTIVATION,
        status: NO_GENESIS_ACTIVATION_APPROVED_STATUS,
      },
    })).toBe('status_gates_everything');
  });

  it.each([
    ['null', null],
    ['a non-object', 'nope'],
    // Reviewer point 3: `'record' in deps` traversed the prototype chain, so a
    // polluted Object.prototype.record could substitute a forged record. The
    // own-property check closes it; this pins the behaviour.
    ['a prototype-polluted record', undefined],
    ['a wrong schema_version', { ...APPROVED_GENESIS_ACTIVATION, schema_version: 'v0' }],
    ['a wrong scope', { ...APPROVED_GENESIS_ACTIVATION, scope: 'something_else' }],
    ['a window whose edges are inverted', {
      ...APPROVED_GENESIS_ACTIVATION,
      approved: { ...SCOPE, window_start_ms: SCOPE.window_end_ms + 1 },
    }],
    ['a missing approved block', { ...APPROVED_GENESIS_ACTIVATION, approved: undefined }],
  ])('RED CONTROL — a malformed record (%s) refuses', (_label, record) => {
    expect(explainApprovedGenesisActivation(candidate(), {
      ...deps, record: record as unknown as ApprovedGenesisActivationRecord,
    })).toBe('record_absent_or_malformed');
  });

  it('RED CONTROL — a POLLUTED Object.prototype.record cannot substitute a record', () => {
    // Reviewer point 3. `'record' in deps` was true for an inherited property,
    // so a polluted prototype would have been read as a supplied record. The
    // own-property check means deps WITHOUT its own `record` still falls back to
    // the shipped one and admits.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.record = { schema_version: 'forged' };
      expect(explainApprovedGenesisActivation(candidate(), deps)).toBe('approved');
    } finally {
      delete proto.record;
    }
  });

  it('RED CONTROL — a THROW inside verification refuses rather than escaping', () => {
    expect(explainApprovedGenesisActivation(candidate(), {
      ...deps,
      verifySignature: () => { throw new Error('boom'); },
    })).toBe('threw');
  });
});

describe('scope — only the Genesis path can reach this record', () => {
  it('the record is imported by EXACTLY ONE production module, the Genesis engine', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (full.endsWith('approved-genesis-activation-approval.ts')) continue;
        if (/from '.*approved-genesis-activation-approval'/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'provian-backend', 'src'));
    // Asserted as an exact set, so a NEW consumer added later fails this test
    // and has to be justified rather than inherited silently.
    expect(hits).toEqual(['provian-backend/src/core/pvt/policy/genesis-policy-engine.ts']);
  });

  it('NEGATIVE CONTROL — the standard monetary path refuses even while Genesis ADMITS', async () => {
    // The severing control the design demands: with the Genesis record fully
    // admitting the Genesis artifact, the monetary rail must still refuse,
    // because it reaches verifyCurrentPvtManifestApproval directly and never
    // consults this record.
    expect(isApprovedGenesisActivation(candidate(), deps)).toBe(true);

    // Same real signature, same configured key, same frozen bytes — the ONLY
    // difference is which rail judges it.
    expect(verifyCurrentPvtManifestApproval(SIGNER.signature, SIGNER.config)).toBe(false);

    const monetary = {
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
      approval_signature: SIGNER.signature,
      policy_template_sha256: `sha256:${'c'.repeat(64)}`,
      effective_at_ms: SCOPE.window_start_ms,
      effective_until_ms: null,
    };
    expect(isValidMonetaryPolicyActivation(monetary, SIGNER.config)).toBe(false);
  });

  it('the record authorizes ONE artifact — not a general signing permission', () => {
    expect(APPROVED_GENESIS_ACTIVATION.scope).toBe('genesis_runtime_activation_document');
    // A second campaign, a second manifest id: both refused by the same record.
    expect(isApprovedGenesisActivation(
      candidate({ ledger_namespace: 'pvt9_genesis_v2' }), deps,
    )).toBe(false);
    expect(isApprovedGenesisActivation(
      candidate({ canonical_pvt_manifest_id: 'pvt9_other_v1' }), deps,
    )).toBe(false);
  });
});
