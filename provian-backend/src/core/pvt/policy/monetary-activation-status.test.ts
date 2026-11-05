/**
 * the monetary boot status probe, and its RED controls.
 *
 * The doctrine this suite is written under :
 * - a probe observed only GREEN proves nothing, so BOTH quiet branches are
 * exercised, not just the alarming ones;
 * - a blunt "make everything invalid" fixture proves only that the FIRST
 * conjunct is guarded, so every structural field gets a control that makes
 * IT the sole failing conjunct;
 * - a universally-quantified claim over zero items is not a pass, so the
 * field table asserts its own evaluated count;
 * - the fixture binds to the REAL signing bytes and the REAL validator; a
 * document this codebase cannot produce would not be evidence.
 */
import crypto from 'crypto';

import {
  MONETARY_ACTIVATION_READ_ATTEMPTS,
  MONETARY_STATUS_DOCUMENT,
  buildMonetaryActivationStatus,
  explainMonetaryStructuralRefusal,
  formatMonetaryActivationBanner,
  isMonetaryActivationAlarm,
  readMonetaryActivationDocument,
  resolveMonetaryActivationStatus,
  type MonetaryActivationStatusInput,
  type MonetaryStructuralField,
} from './monetary-activation-status';
import {
  APPROVED_MONETARY_ACTIVATION,
  APPROVED_MONETARY_ACTIVATION_STATUS,
  NO_MONETARY_ACTIVATION_APPROVED_STATUS,
  monetaryApprovalSigningBytes,
  type ApprovedMonetaryActivationRecord,
} from './approved-monetary-activation-approval';
import {
  PROPOSED_MONETARY_POLICY_TEMPLATE,
  hashProposedMonetaryPolicyTemplate,
} from './proposed-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';
import {
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
// The authoritative gate, imported unmodified. Every claim this suite makes
// about a document is bound to THIS function, never to a local restatement of
// its rules (the self-referential control).
import { isValidMonetaryPolicyActivation } from './runtime-monetary-policy';

const MAGIC = Buffer.from('SSHSIG', 'ascii');
const EFFECTIVE_AT = Date.UTC(2026, 7, 3); // 2026-08-03T00:00:00Z, the live floor.

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * A REAL Ed25519 SSHSIG over the REAL `monetaryApprovalSigningBytes()`.
 *
 * Signing the module's own signing-bytes function rather than a restated copy
 * is what makes an admitting document possible without the operator’s key while still
 * exercising the untouched verifier. If the signing bytes ever change, this
 * fixture follows them and the green stays honest.
 */
function signedFixture(namespace = 'provian-pvt-policy'): {
  signature: SshApprovalSignature;
  config: SshApprovalVerifierConfig;
} {
  const message = monetaryApprovalSigningBytes();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawKey = spki.subarray(spki.length - 32);
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(rawKey)]);
  const openSshPublicKey = `ssh-ed25519 ${publicBlob.toString('base64')} frank-test`;
  const publicKeySha256 = decodeOpenSshEd25519PublicKey(openSshPublicKey).sha256;
  const hashAlgorithm = 'sha512';
  const digest = crypto.createHash(hashAlgorithm).update(message).digest();
  const reserved = Buffer.alloc(0);
  const signedData = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(digest),
  ]);
  const rawSignature = crypto.sign(null, signedData, privateKey);
  const signatureBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(rawSignature)]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const sshsig = Buffer.concat([
    MAGIC,
    version,
    sshString(publicBlob),
    sshString(namespace),
    sshString(reserved),
    sshString(hashAlgorithm),
    sshString(signatureBlob),
  ]);
  const base64 = sshsig.toString('base64').match(/.{1,70}/g)!.join('\n');
  return {
    signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace,
      public_key_sha256: publicKeySha256,
      armored_signature:
        `-----BEGIN SSH SIGNATURE-----\n${base64}\n-----END SSH SIGNATURE-----`,
    },
    config: {
      signerIdentity: 'frank',
      namespace: 'provian-pvt-policy',
      openSshPublicKey,
      publicKeySha256,
    },
  };
}

function activationDoc(signature: SshApprovalSignature): Record<string, unknown> {
  return {
    schema_version: 'pvt-monetary-policy-activation/v1',
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: signature,
    policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
    policy_template_sha256: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: EFFECTIVE_AT,
    effective_until_ms: null,
    activation_scope: 'record_and_settlement',
    automation_generated: false,
    activated_at_ms: EFFECTIVE_AT - 1_000,
    activated_by: 'operator:test',
  };
}

/**
 * Inject the approved status explicitly so validator-field negative controls
 * exercise that branch independently of the shipped record's state. A separate
 * injected sentinel control proves that an unapproved record refuses.
 */
const RATIFIED_RECORD: ApprovedMonetaryActivationRecord = {
  ...APPROVED_MONETARY_ACTIVATION,
  status: APPROVED_MONETARY_ACTIVATION_STATUS,
};

function baseInput(
  overrides: Partial<MonetaryActivationStatusInput> = {},
): MonetaryActivationStatusInput {
  const { signature, config } = signedFixture();
  return {
    document: activationDoc(signature),
    approvalPublicKeyRaw: config.openSshPublicKey,
    approvalKeySha256Raw: config.publicKeySha256,
    nowMs: EFFECTIVE_AT,
    verifierConfig: config,
    approvalRecord: RATIFIED_RECORD,
    ...overrides,
  };
}

describe(' monetary boot status probe', () => {
  describe('the fixture is genuinely admitting — otherwise nothing below is a control', () => {
    it('the real validator ADMITS the signed fixture, and REFUSES it unsigned', () => {
      const { signature, config } = signedFixture();
      // GREEN: the untouched validator, the real approval route, under the
      // ratified record (the shipped record is sentinel-gated).
      expect(isValidMonetaryPolicyActivation(activationDoc(signature), config, RATIFIED_RECORD))
        .toBe(true);
      // RED: the same document, one flipped byte in the armored signature.
      const armored = signature.armored_signature;
      const at = Math.floor(armored.length / 2);
      const tampered = {
        ...signature,
        armored_signature:
          `${armored.slice(0, at)}${armored[at] === 'A' ? 'B' : 'A'}${armored.slice(at + 1)}`,
      };
      expect(isValidMonetaryPolicyActivation(activationDoc(tampered), config, RATIFIED_RECORD))
        .toBe(false);
      // RED: right document, wrong key. The pair is what discriminates.
      expect(isValidMonetaryPolicyActivation(
        activationDoc(signature),
        signedFixture().config,
        RATIFIED_RECORD,
      )).toBe(false);
      expect(APPROVED_MONETARY_ACTIVATION.approved.policy_template_sha256)
        .toBe(hashProposedMonetaryPolicyTemplate());
    });

    it('SENTINEL CONTROL (preserved through both states): an injected sentinel record refuses even a perfectly signed fixture', () => {
      // (class-based admission): the template digest moved to c03e36d0
      // and the shipped record is the SENTINEL until the operator signs the new scope bytes. The
      // sentinel fail-closed property is proven by INJECTION (the same preserved-through-the-
      // flip pattern as RED CONTROL 1 in the approval suite), so it holds in BOTH windows.
      // 2026-09-17: the SSHSIG is embedded — the shipped record is Current signed scope and the
      // sentinel property is proven by injection below.
      expect(APPROVED_MONETARY_ACTIVATION.status)
        .not.toBe(NO_MONETARY_ACTIVATION_APPROVED_STATUS);
      const sentinel: ApprovedMonetaryActivationRecord = {
        ...APPROVED_MONETARY_ACTIVATION,
        status: NO_MONETARY_ACTIVATION_APPROVED_STATUS,
      };
      const { signature, config } = signedFixture();
      expect(isValidMonetaryPolicyActivation(activationDoc(signature), config, sentinel))
        .toBe(false);
      const r = resolveMonetaryActivationStatus(baseInput({ approvalRecord: sentinel }));
      expect(r.verdict).toBe('alarm_approval_refused');
      expect(r.approval_verdict).toBe('status_gates_everything');
    });
  });

  describe('BOTH quiet branches are reachable — a probe that can only alarm proves nothing', () => {
    it('quiet_active at and after the floor', () => {
      const r = resolveMonetaryActivationStatus(baseInput({ nowMs: EFFECTIVE_AT }));
      expect(r.verdict).toBe('quiet_active');
      expect(r.alarm).toBe(false);
      expect(r.validator_admits).toBe(true);
      expect(r.signature_verified).toBe(true);
      expect(r.digest_match).toBe(true);
      expect(r.effective_at_ms).toBe(EFFECTIVE_AT);
      expect(r.failing_field).toBeNull();
    });

    it('quiet_valid_before_floor one millisecond before it', () => {
      const r = resolveMonetaryActivationStatus(baseInput({ nowMs: EFFECTIVE_AT - 1 }));
      expect(r.verdict).toBe('quiet_valid_before_floor');
      expect(r.alarm).toBe(false);
      expect(r.validator_admits).toBe(true);
      expect(r.digest_match).toBe(true);
    });

    it('the banner reports the full resolution even when quiet', () => {
      const r = resolveMonetaryActivationStatus(baseInput({ nowMs: EFFECTIVE_AT - 1 }));
      const banner = formatMonetaryActivationBanner(r);
      // The healthy line is the evidence the process performed the read, so it
      // must carry the observation and not merely the word "ok".
      expect(banner).toContain('[monetary-activation] ok: quiet_valid_before_floor');
      expect(banner).toContain('document found   : true');
      expect(banner).toContain('validator admits : true');
      expect(banner).toContain(`computed=${hashProposedMonetaryPolicyTemplate()}`);
      expect(banner).toContain('match=true');
      expect(banner).toContain('2026-08-03T00:00:00.000Z');
      expect(banner).toContain(MONETARY_STATUS_DOCUMENT);
    });
  });

  describe('RED — the failure, reconstructed', () => {
    it('alarm_template_digest_drifted names the cause and reports BOTH digests', () => {
      // Exactly what did to the signed Genesis document: the document is
      // untouched and correctly signed; the CODE's computed digest moved.
      const drifted = `sha256:${'b'.repeat(64)}`;
      const r = resolveMonetaryActivationStatus(baseInput({
        document: { ...activationDoc(signedFixture().signature), policy_template_sha256: drifted },
      }));
      expect(r.verdict).toBe('alarm_template_digest_drifted');
      expect(r.alarm).toBe(true);
      expect(r.validator_admits).toBe(false);
      expect(r.digest_match).toBe(false);
      expect(r.pinned_template_sha256).toBe(drifted);
      expect(r.computed_template_sha256).toBe(hashProposedMonetaryPolicyTemplate());
      expect(r.failing_field).toBe('policy_template_sha256');
      // The remedy must name the re-issue AND the sibling document, because the
      // Genesis one fails identically and silently.
      const banner = formatMonetaryActivationBanner(r);
      expect(banner).toContain('ALARM: alarm_template_digest_drifted');
      expect(banner).toContain('PROPOSED_ACTION_POLICY_ENTRIES');
      expect(banner).toContain('Genesis');
    });
  });

  describe('RED — absence, unreachability and a missing key stay THREE distinct facts', () => {
    it('alarm_document_absent', () => {
      const r = resolveMonetaryActivationStatus(baseInput({ document: undefined }));
      expect(r.verdict).toBe('alarm_document_absent');
      expect(r.document_found).toBe(false);
      expect(r.validator_admits).toBe(false);
    });

    it('alarm_read_failed is NOT collapsed into absent', () => {
      const r = resolveMonetaryActivationStatus(baseInput({ document: 'read_failed' }));
      expect(r.verdict).toBe('alarm_read_failed');
      expect(r.document_found).toBe(false);
    });

    it('alarm_approval_env_absent for a blank key, and for a null verifier config', () => {
      expect(resolveMonetaryActivationStatus(baseInput({
        approvalPublicKeyRaw: '  ',
      })).verdict).toBe('alarm_approval_env_absent');
      expect(resolveMonetaryActivationStatus(baseInput({
        approvalKeySha256Raw: undefined,
      })).verdict).toBe('alarm_approval_env_absent');
      expect(resolveMonetaryActivationStatus(baseInput({
        verifierConfig: null,
      })).verdict).toBe('alarm_approval_env_absent');
      // Still reports what it COULD see — the digest needs no key.
      const r = resolveMonetaryActivationStatus(baseInput({ verifierConfig: null }));
      expect(r.document_found).toBe(true);
      expect(r.computed_template_sha256).toBe(hashProposedMonetaryPolicyTemplate());
    });
  });

  describe('RED — every structural field gets a control that makes IT the sole failure', () => {
    // One mutation per field. A blunt "make everything invalid" fixture would
    // prove only that the first conjunct is guarded while reading as coverage
    // for all twelve.
    const MUTATIONS: ReadonlyArray<readonly [MonetaryStructuralField, Record<string, unknown>]> = [
      ['schema_version', { schema_version: 'pvt-monetary-policy-activation/v2' }],
      ['approval_status', { approval_status: 'approved_by_someone_else' }],
      ['approval_manifest_sha256', { approval_manifest_sha256: `sha256:${'f'.repeat(64)}` }],
      ['approval_signature', { approval_signature: 'not-an-object' }],
      ['policy_version', { policy_version: 'some-other-version' }],
      ['policy_template_sha256', { policy_template_sha256: `sha256:${'c'.repeat(64)}` }],
      ['effective_at_ms', { effective_at_ms: -1 }],
      ['effective_until_ms', { effective_until_ms: EFFECTIVE_AT - 1 }],
      ['activation_scope', { activation_scope: 'record_only' }],
      ['automation_generated', { automation_generated: true }],
      ['activated_at_ms', { activated_at_ms: 1.5 }],
      ['activated_by', { activated_by: '  ' }],
    ];

    it.each(MUTATIONS)('%s is named, and the REAL validator refuses it too', (field, patch) => {
      const { signature, config } = signedFixture();
      const document = { ...activationDoc(signature), ...patch };
      // The explainer names THIS field...
      expect(explainMonetaryStructuralRefusal(document)).toBe(field);
      // ...and the authoritative validator independently refuses. Binding both
      // is what stops the explainer drifting into fiction.
      expect(isValidMonetaryPolicyActivation(document, config)).toBe(false);
      const r = resolveMonetaryActivationStatus(baseInput({ document, verifierConfig: config }));
      expect(r.alarm).toBe(true);
      expect(r.failing_field).toBe(field);
      expect(r.verdict).toBe(
        field === 'policy_template_sha256'
          ? 'alarm_template_digest_drifted'
          : 'alarm_structurally_invalid',
      );
    });

    it('the table covered every field in the union — a pass over zero is not a pass', () => {
      // The empty-population guard. Without it, deleting the table
      // would turn this whole describe block green.
      const covered = new Set(MUTATIONS.map(([field]) => field));
      const ALL: readonly MonetaryStructuralField[] = [
        'schema_version', 'approval_status', 'approval_manifest_sha256', 'approval_signature',
        'policy_version', 'policy_template_sha256', 'effective_at_ms', 'effective_until_ms',
        'activation_scope', 'automation_generated', 'activated_at_ms', 'activated_by',
      ];
      expect(MUTATIONS.length).toBe(12);
      expect(covered.size).toBe(12);
      for (const field of ALL) expect(covered.has(field)).toBe(true);
    });

    it('a non-object document is refused rather than throwing', () => {
      for (const bad of [null, [], 42, 'string']) {
        const r = resolveMonetaryActivationStatus(baseInput({ document: bad }));
        expect(r.alarm).toBe(true);
        expect(r.validator_admits).toBe(false);
      }
    });
  });

  describe('RED — structurally perfect, approval refused', () => {
    it('alarm_approval_refused when the signature is by a DIFFERENT key', () => {
      const mine = signedFixture();
      const other = signedFixture();
      // Structurally flawless; signed by a key the verifier does not hold.
      const r = resolveMonetaryActivationStatus(baseInput({
        document: activationDoc(mine.signature),
        verifierConfig: other.config,
        approvalPublicKeyRaw: other.config.openSshPublicKey,
        approvalKeySha256Raw: other.config.publicKeySha256,
      }));
      expect(r.verdict).toBe('alarm_approval_refused');
      expect(r.failing_field).toBeNull();
      expect(r.signature_verified).toBe(false);
      expect(r.approval_verdict).toBe('signature_key_mismatch');
      expect(r.digest_match).toBe(true); // the digest is fine; the KEY is not.
    });
  });

  describe('RED — the explainer and the validator must not part company', () => {
    it('alarm_explainer_disagrees fires when they do', () => {
      // Constructible ONLY through the widened input seam. While the two agree
      // this branch is unreachable, and an unreachable guard is not a guard
      // so the violation is injected rather than left undemonstrated.
      const r = resolveMonetaryActivationStatus(baseInput({
        explainStructural: () => 'activated_by',
      }));
      expect(r.verdict).toBe('alarm_explainer_disagrees');
      expect(r.alarm).toBe(true);
      expect(r.validator_admits).toBe(true);
      expect(r.failing_field).toBe('activated_by');
    });

    it('and does NOT fire with the real explainer on the same document', () => {
      // The negative half: same input, real explainer, quiet. Without this the
      // test above would pass just as well against a resolver hard-wired to
      // report disagreement.
      expect(resolveMonetaryActivationStatus(baseInput()).verdict).toBe('quiet_active');
    });
  });

  describe('`alarm` has exactly ONE source of truth', () => {
    // THIS CONTROL EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY A MUTATION.
    // `isMonetaryActivationAlarm` was hard-wired to `return false` and all 26
    // tests passed: the resolver hand-wrote `alarm: true` at each of its nine
    // returns, so nothing consulted the function that owned the judgement.
    // A guard nothing consults cannot fail.
    const ALARMING = [
      'alarm_read_failed', 'alarm_document_absent', 'alarm_approval_env_absent',
      'alarm_template_digest_drifted', 'alarm_structurally_invalid',
      'alarm_approval_refused', 'alarm_explainer_disagrees',
    ] as const;
    const QUIET = ['quiet_active', 'quiet_valid_before_floor'] as const;

    it('alarms on every alarming verdict', () => {
      expect(ALARMING.length).toBe(7); // no vacuous pass over an empty list
      for (const v of ALARMING) expect(isMonetaryActivationAlarm(v)).toBe(true);
    });

    it('is quiet on exactly the two quiet verdicts', () => {
      expect(QUIET.length).toBe(2);
      for (const v of QUIET) expect(isMonetaryActivationAlarm(v)).toBe(false);
    });

    it('every resolver return DERIVES alarm from that function, never restates it', () => {
      // Bind the two together on real resolutions: if the resolver ever again
      // hand-writes the flag, this parts company with the function.
      const cases: ReadonlyArray<Partial<MonetaryActivationStatusInput>> = [
        {}, // quiet_active
        { nowMs: EFFECTIVE_AT - 1 }, // quiet_valid_before_floor
        { document: undefined },
        { document: 'read_failed' },
        { verifierConfig: null },
        { document: { ...activationDoc(signedFixture().signature), activated_by: '  ' } },
        { explainStructural: () => 'activated_by' },
      ];
      expect(cases.length).toBe(7);
      for (const override of cases) {
        const r = resolveMonetaryActivationStatus(baseInput(override));
        expect(r.alarm).toBe(isMonetaryActivationAlarm(r.verdict));
      }
    });
  });

  describe('the status record carries no secret', () => {
    it('records digests and booleans only — never a key or a signature', () => {
      const r = resolveMonetaryActivationStatus(baseInput());
      const record = buildMonetaryActivationStatus(r, 1_700_000_000_000);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('BEGIN SSH SIGNATURE');
      expect(serialized).not.toContain('ssh-ed25519');
      expect(record.schema_version).toBe('monetary-activation-status/v1');
      expect(record.observed_at_ms).toBe(1_700_000_000_000);
      expect(record.alarm).toBe(false);
      expect(isMonetaryActivationAlarm(record.verdict)).toBe(false);
    });
  });

  // the boot read retries on a THROW so a Cloud Run cold-start Firestore race does
  // not emit a spurious `alarm_read_failed` (which, last-writer-wins, poisoned the status
  // doc and flapped `monetary.digest_mismatch` for hours while the template was correct).
  describe('readMonetaryActivationDocument (boot read is retried,)', () => {
    // A Firestore stand-in whose .get() replays a queued list of behaviors: 'throw' or a
    // { exists, data } snapshot. Counts get() calls so retry is observable, never faked.
    function fakeDb(behaviors: Array<'throw' | { exists: boolean; data?: unknown }>) {
      const calls = { get: 0 };
      const db = {
        collection: () => ({
          doc: () => ({
            get: async () => {
              const b = behaviors[Math.min(calls.get, behaviors.length - 1)];
              calls.get += 1;
              if (b === 'throw') throw new Error('UNAVAILABLE: metadata server not ready');
              return { exists: b.exists, data: () => b.data };
            },
          }),
        }),
      } as unknown as import('firebase-admin/firestore').Firestore;
      return { db, calls };
    }
    const noDelay = async (): Promise<void> => { /* deterministic: never actually sleep */ };
    const noBackoff = (): number => 0;

    it('returns the document on a first-attempt success (one read, no retry)', async () => {
      const { db, calls } = fakeDb([{ exists: true, data: { policy_template_sha256: 'sha256:01059933' } }]);
      const doc = await readMonetaryActivationDocument(db, 4, noDelay, noBackoff);
      expect((doc as Record<string, unknown>).policy_template_sha256).toBe('sha256:01059933');
      expect(calls.get).toBe(1);
    });

    it('an ABSENT document is a real state — returned immediately, never retried', async () => {
      const { db, calls } = fakeDb([{ exists: false }]);
      const doc = await readMonetaryActivationDocument(db, 4, noDelay, noBackoff);
      expect(doc).toBeUndefined();
      expect(calls.get).toBe(1); // absent is not a transient
    });

    it('a transient throw is absorbed: throw, throw, then succeed → the document (3 reads)', async () => {
      const { db, calls } = fakeDb(['throw', 'throw', { exists: true, data: { ok: true } }]);
      const doc = await readMonetaryActivationDocument(db, 4, noDelay, noBackoff);
      expect((doc as Record<string, unknown>).ok).toBe(true);
      expect(calls.get).toBe(3);
    });

    // RED control: the SAME throw-then-succeed sequence, but with attempts=1, must NOT be
    // saved by the retry — it returns 'read_failed'. This is what proves the retry (not some
    // always-true fallback) is doing the work: remove the retry and the transient-throw test
    // above degrades to exactly this.
    it('RED: attempts=1 does not absorb the transient — a single throw yields read_failed', async () => {
      const { db, calls } = fakeDb(['throw', { exists: true, data: { ok: true } }]);
      const doc = await readMonetaryActivationDocument(db, 1, noDelay, noBackoff);
      expect(doc).toBe('read_failed');
      expect(calls.get).toBe(1);
    });

    it('a PERSISTENT failure still surfaces: every attempt throws → read_failed (must alarm)', async () => {
      const { db, calls } = fakeDb(['throw', 'throw', 'throw', 'throw', 'throw']);
      const doc = await readMonetaryActivationDocument(db, 4, noDelay, noBackoff);
      expect(doc).toBe('read_failed');
      expect(calls.get).toBe(4); // exactly the attempt budget, no more
    });

    it('the production default budget is > 1 (so a single boot blip cannot poison the doc)', () => {
      expect(MONETARY_ACTIVATION_READ_ATTEMPTS).toBeGreaterThan(1);
    });
  });
});
