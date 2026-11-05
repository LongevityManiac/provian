/**
 * The Genesis settlement EPOCH-ZERO PIN — the scissor, and its resolution.
 *
 * BACKGROUND. `loadAuthorizedGenesisSettlementPolicyEvent` requires the first
 * event in the chain to be `effective_epoch: 0` AND to name one exact approval
 * manifest hash. That pin used to name the frozen Gate 1 manifest, which can
 * never be admitted for two independent reasons — it declares
 * `signing_permitted: false`, and its embedded settlement subject names the
 * pre-arming campaign `pvt9_genesis_pending` rather than the live
 * `pvt9_genesis_v1`. The two conjuncts were mutually exclusive: no manifest
 * could satisfy both, so no epoch-zero event could exist and nothing could ever
 * settle.
 *
 * THE RESOLUTION. The pin now names a SUCCESSOR settlement manifest that is
 * signable and carries the live campaign's subject. It is still ONE
 * exact-equality check against ONE hash — the admit surface is not widened, its
 * target is corrected. The Gate 1 artifact is untouched and still refused.
 *
 * EVERY assertion below ships with its RED control. The GREEN case (G1) and the
 * five REDs exercise the same call; if the pin were removed or loosened, R2–R5
 * would admit and this suite would fail.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION,
  INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
  createGenesisSettlementBudgetPolicyEvent,
  loadAuthorizedGenesisSettlementPolicyEvent,
} from './genesis-settlement-budget';
import {
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
} from './policy/approval-signature';
import {
  PVT_APPROVAL_MANIFEST_BYTES_COLLECTION,
  approvalManifestSha256,
} from './policy/current-approval';
import {
  GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
  genesisSettlementApprovalManifestBytes,
} from './policy/genesis-settlement-approval-manifest';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './policy/pvt9-approval-manifest.generated';
import {
  GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
  GENESIS_SETTLEMENT_CAMPAIGN_ID,
  GENESIS_SETTLEMENT_CHAIN_ID,
  GENESIS_SETTLEMENT_KERNEL_ID,
  GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
  createGenesisSettlementAuthorizationSubject,
  genesisSettlementAuthorizationSubjectSha256,
} from './policy/genesis-settlement-authorization';

const ARTIFACT = path.join(
  __dirname, 'policy', '__artifacts__', 'genesis-settlement-approval-manifest.json',
);

let dir: string;
let keyPath: string;
let otherKeyPath: string;
const savedEnv: Record<string, string | undefined> = {};

function signWith(key: string, bytes: Buffer): SshApprovalSignature {
  const msg = path.join(dir, `m${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(msg, bytes, { mode: 0o600 });
  execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', 'provian-pvt-policy', msg]);
  const armored = fs.readFileSync(`${msg}.sig`, 'utf8');
  const pub = execFileSync('ssh-keygen', ['-y', '-f', key]).toString('utf8').trim();
  return {
    scheme: 'sshsig-ed25519',
    signer_identity: 'frank',
    namespace: 'provian-pvt-policy',
    public_key_sha256: decodeOpenSshEd25519PublicKey(pub).sha256,
    armored_signature: armored,
  };
}

const sign = (bytes: Buffer) => signWith(keyPath, bytes);

/**
 * A locally-built signable manifest. Used ONLY as the impostor in R3 — the
 * GREEN case binds to the shipped artifact, never to a local copy, because a
 * test that declares its own copy of what the code reads is the
 * self-referential control that proves nothing.
 */
function localSignableManifest(extra: Record<string, unknown> = {}): Buffer {
  const subject = createGenesisSettlementAuthorizationSubject({
    event_id: GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
    policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    authorized_at_epoch: 0,
    effective_epoch: 0,
    cap_atomic: INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
    previous_event_hash: null,
    authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
    chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
    campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
    settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
  });
  return Buffer.from(JSON.stringify({
    schema_version: 'pvt9-policy-approval-manifest/v1',
    approval_status: 'approvable_after_independent_review',
    signing_permitted: true,
    genesis_settlement_authorization_subject: subject,
    genesis_settlement_authorization_subject_sha256:
      genesisSettlementAuthorizationSubjectSha256(subject),
    ...extra,
  }, null, 2), 'utf8');
}

function epochZeroEvent(opts: {
  manifestHash: string;
  signature: SshApprovalSignature;
  cap_atomic?: string;
  effective_epoch?: number;
  authorized_at_epoch?: number;
  event_id?: string;
}) {
  return createGenesisSettlementBudgetPolicyEvent({
    event_id: opts.event_id ?? GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
    policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    authorized_at_epoch: opts.authorized_at_epoch ?? 0,
    effective_epoch: opts.effective_epoch ?? 0,
    cap_atomic: opts.cap_atomic ?? INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: opts.manifestHash,
    approval_signature: opts.signature,
    approval_audit_id: 'epoch-zero-pin-suite',
    authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
    chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
    campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
    settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
    automation_generated: false,
    previous_event_hash: null,
    evented_at_ms: 1,
    evented_by: 'epoch-zero-pin-suite',
  });
}

/** Drive the REAL reader. Returns the admitted event id, or the refusal message. */
async function load(
  events: readonly unknown[],
  manifests: readonly Buffer[],
  epoch = 0,
): Promise<{ admitted: boolean; detail: string }> {
  const db = createFakeFirestore();
  for (const b of manifests) {
    const h = approvalManifestSha256(b);
    await (db as unknown as {
      collection: (c: string) => { doc: (d: string) => { set: (v: unknown) => Promise<unknown> } };
    }).collection(PVT_APPROVAL_MANIFEST_BYTES_COLLECTION)
      .doc(h.slice('sha256:'.length))
      .set({
        schema_version: 'pvt-approval-manifest-bytes/v1',
        approval_manifest_sha256: h,
        manifest_utf8_base64: b.toString('base64'),
        registered_at_ms: 1,
        registered_by: 'epoch-zero-pin-suite',
      });
  }
  for (const e of events as { event_id: string }[]) {
    await (db as unknown as {
      collection: (c: string) => { doc: (d: string) => { set: (v: unknown) => Promise<unknown> } };
    }).collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION).doc(e.event_id).set(e);
  }
  try {
    const r = await loadAuthorizedGenesisSettlementPolicyEvent(
      db as unknown as Parameters<typeof loadAuthorizedGenesisSettlementPolicyEvent>[0],
      epoch,
    );
    return { admitted: true, detail: r.event_id };
  } catch (e) {
    return { admitted: false, detail: (e as Error).message };
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-suite-'));
  fs.chmodSync(dir, 0o700);
  keyPath = path.join(dir, 'k');
  otherKeyPath = path.join(dir, 'other');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'suite', '-f', keyPath], { stdio: 'pipe' });
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'other', '-f', otherKeyPath], { stdio: 'pipe' });
  const pub = execFileSync('ssh-keygen', ['-y', '-f', keyPath]).toString('utf8').trim();
  savedEnv.pk = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  savedEnv.sha = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = pub;
  process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = decodeOpenSshEd25519PublicKey(pub).sha256;
});

afterAll(() => {
  process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = savedEnv.pk;
  process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = savedEnv.sha;
  if (savedEnv.pk === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  if (savedEnv.sha === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('the successor settlement manifest is what it claims to be', () => {
  it('has three independent witnesses to its digest, so the literal is never the only one', () => {
    const embedded = genesisSettlementApprovalManifestBytes();
    const onDisk = fs.readFileSync(ARTIFACT);
    expect(onDisk.equals(embedded)).toBe(true);
    expect(approvalManifestSha256(embedded)).toBe(GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256);
    expect(approvalManifestSha256(onDisk)).toBe(GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256);
  });

  it('embeds the subject the reader itself constructs — derived, never copied', () => {
    const parsed = JSON.parse(genesisSettlementApprovalManifestBytes().toString('utf8'));
    const expected = createGenesisSettlementAuthorizationSubject({
      event_id: GENESIS_SETTLEMENT_LAUNCH_EVENT_ID,
      policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
      authorized_at_epoch: 0,
      effective_epoch: 0,
      cap_atomic: INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC,
      previous_event_hash: null,
      authorization_scope: GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
      chain_id: GENESIS_SETTLEMENT_CHAIN_ID,
      campaign_id: GENESIS_SETTLEMENT_CAMPAIGN_ID,
      settlement_kernel_id: GENESIS_SETTLEMENT_KERNEL_ID,
    });
    expect(parsed.genesis_settlement_authorization_subject).toEqual(expected);
    expect(parsed.genesis_settlement_authorization_subject_sha256)
      .toBe(genesisSettlementAuthorizationSubjectSha256(expected));
  });

  it('is a DIFFERENT artifact from the Gate 1 manifest, which is unmoved', () => {
    expect(GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256)
      .not.toBe(PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256);
    const frozen = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    expect(approvalManifestSha256(frozen))
      .toBe('sha256:704c1a2d9e555b56d9b4a5803b3f641b0e29e5e3012af0c0c3dc5ae665be6e71');
  });

  it('exists because Gate 1 is BOTH non-signable AND names a campaign that no longer runs', () => {
    const frozen = JSON.parse(
      Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64').toString('utf8'),
    );
    expect(frozen.signing_permitted).toBe(false);
    expect(frozen.genesis_settlement_authorization_subject.campaign_id).toBe('pvt9_genesis_pending');
    expect(GENESIS_SETTLEMENT_CAMPAIGN_ID).toBe('pvt9_genesis_v1');
    expect(frozen.genesis_settlement_authorization_subject.campaign_id)
      .not.toBe(GENESIS_SETTLEMENT_CAMPAIGN_ID);
  });
});

describe('the epoch-zero pin: one GREEN, five REDs on the same call', () => {
  it('G1 GREEN — an epoch-zero event naming the PINNED successor is admitted', async () => {
    const succ = genesisSettlementApprovalManifestBytes();
    const r = await load(
      [epochZeroEvent({ manifestHash: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256, signature: sign(succ) })],
      [],
    );
    expect(r).toEqual({ admitted: true, detail: GENESIS_SETTLEMENT_LAUNCH_EVENT_ID });
  });

  it('R1 RED — the frozen Gate 1 manifest is still refused, with a genuine signature over it', async () => {
    const frozen = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
    const r = await load(
      [epochZeroEvent({ manifestHash: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256, signature: sign(frozen) })],
      [],
    );
    expect(r.admitted).toBe(false);
    expect(r.detail).toMatch(/approval signature is invalid/);
  });

  it('R2 RED — a later epoch cannot stand alone; an epoch-zero event is mandatory', async () => {
    const succ = genesisSettlementApprovalManifestBytes();
    const r = await load(
      [epochZeroEvent({
        manifestHash: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
        signature: sign(succ),
        effective_epoch: 4,
        authorized_at_epoch: 1,
        event_id: 'later-only',
      })],
      [],
      4,
    );
    expect(r.admitted).toBe(false);
  });

  it('R3 RED — a DIFFERENT valid, signable, correctly-signed manifest is still refused', async () => {
    const impostor = localSignableManifest({ note: 'valid and signable, but not the pinned artifact' });
    expect(approvalManifestSha256(impostor)).not.toBe(GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256);
    const r = await load(
      [epochZeroEvent({ manifestHash: approvalManifestSha256(impostor), signature: sign(impostor) })],
      [impostor],
    );
    expect(r.admitted).toBe(false);
    expect(r.detail).toMatch(/does not match formal approval/);
  });

  it('R4 RED — different settlement economics are refused, BY THE EMBEDDED-SUBJECT MATCH', async () => {
    const succ = genesisSettlementApprovalManifestBytes();
    const r = await load(
      [epochZeroEvent({
        manifestHash: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
        signature: sign(succ),
        cap_atomic: (BigInt(INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC) + 1n).toString(),
      })],
      [],
    );
    expect(r.admitted).toBe(false);
    // ATTRIBUTED, not merely refused. The reviewer of established that the
    // later `Current approval manifest cannot authorize different settlement
    // economics` block is UNREACHABLE: the manifest's embedded subject fixes
    // `cap_atomic` and `policy_version`, so the mismatch dies at the subject
    // comparison first. Asserting the exact message keeps this test honest about
    // WHICH guard is doing the work — a test named after a guard that did not fire
    // is how a dead guard gets mistaken for a live one.
    expect(r.detail).toMatch(/signed authorization does not match policy event/);
  });

  it('R5 RED — a signature by a key that is not the configured one is refused', async () => {
    const succ = genesisSettlementApprovalManifestBytes();
    const r = await load(
      [epochZeroEvent({
        manifestHash: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
        signature: signWith(otherKeyPath, succ),
      })],
      [],
    );
    expect(r.admitted).toBe(false);
    expect(r.detail).toMatch(/approval signature is invalid/);
  });

  it('R6 RED — with no verifier key configured the pin fails CLOSED, not open', async () => {
    const succ = genesisSettlementApprovalManifestBytes();
    const signature = sign(succ);
    const pk = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    const sha = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    try {
      const r = await load(
        [epochZeroEvent({ manifestHash: GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256, signature })],
        [],
      );
      expect(r.admitted).toBe(false);
    } finally {
      process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = pk;
      process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = sha;
    }
  });
});
