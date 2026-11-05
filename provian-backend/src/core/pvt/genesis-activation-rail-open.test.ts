/**
 * THE RAIL IS OPEN, against the REAL production manifest.
 *
 * Every other Genesis suite that reaches an `admits` verdict does it either with
 * an injected `() => true` verifier or under a mocked signable fixture manifest.
 * This file uses NEITHER. It runs the production gate, against the checked-in
 * NON-SIGNABLE Gate 1 manifest, with a real ed25519 SSHSIG over its exact bytes,
 * and asserts the whole persist gate ADMITS on all three legs.
 *
 * That is the difference the approved Genesis record makes, and it is asserted
 * here in the one configuration where nothing is faked.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { buildGenesisActivationDocument, explainGenesisActivationRefusal } from './genesis-activation-document';
import { invalidateGenesisConfigCache, loadGenesisCampaignConfig } from './genesis-campaign';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  isGenesisGrantPersistenceLive,
  shouldPersistGenesisQualification,
  type GenesisQualificationAction,
} from './genesis-award-state-machine';
import { APPROVED_GENESIS_ACTIVATION, genesisApprovalSigningBytes } from './policy/approved-genesis-activation-approval';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature } from './policy/approval-signature';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from './policy/pvt9-approval-manifest.generated';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import type { GenesisCampaignActivation } from './policy/genesis-policy-engine';

const MANIFEST_BYTES = Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
const SCOPE = APPROVED_GENESIS_ACTIVATION.approved;
const LEGS = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties
  .map((b) => b.canonical_bounty_key as GenesisQualificationAction);

/** A real key and a real SSHSIG over the REAL frozen manifest bytes. */
function mint(): { pub: string; hash: string; signature: SshApprovalSignature } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-'));
  try {
    const key = path.join(dir, 'k');
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q']);
    const message = path.join(dir, 'm');
    fs.writeFileSync(message, genesisApprovalSigningBytes());
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', 'provian-pvt-policy', message]);
    const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
    const hash = decodeOpenSshEd25519PublicKey(pub).sha256;
    return {
      pub,
      hash,
      signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: hash,
        armored_signature: fs.readFileSync(`${message}.sig`, 'utf8'),
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = mint();
const OTHER = mint();

function doc(
  overrides: Partial<GenesisCampaignActivation> = {},
): GenesisCampaignActivation {
  return {
    ...buildGenesisActivationDocument({
      frankApprovalAuditId: 'rail-open-frank',
      operatorActivationAuditId: 'rail-open-operator',
      canonicalPvtManifestId: SCOPE.canonical_pvt_manifest_id,
      approvalSignature: KEY.signature,
    }),
    ...overrides,
  };
}

describe('the Genesis rail is OPEN against the real, still-non-signable manifest', () => {
  const oldKey = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  const oldHash = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  beforeEach(() => {
    process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = KEY.pub;
    process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = KEY.hash;
  });
  afterAll(() => {
    if (oldKey === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    else process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = oldKey;
    if (oldHash === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    else process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = oldHash;
  });

  it('the Gate 1 manifest is STILL non-signable — nothing was loosened', () => {
    expect(PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED as boolean).toBe(false);
  });

  it('the full gate ADMITS, with NO mock and NO injected verifier', () => {
    expect(explainGenesisActivationRefusal(doc())).toEqual({ verdict: 'admits' });
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', SCOPE.window_start_ms, doc(),
    )).toBe(true);
  });

  it.each(LEGS)('%s — an in-window act persists through the production gate', (leg) => {
    expect(shouldPersistGenesisQualification(leg, SCOPE.window_start_ms, doc())).toBe(true);
    expect(shouldPersistGenesisQualification(leg, SCOPE.window_end_ms, doc())).toBe(true);
  });

  it.each(LEGS)('%s — RED: an out-of-window act is still refused', (leg) => {
    expect(shouldPersistGenesisQualification(leg, SCOPE.window_start_ms - 1, doc())).toBe(false);
    expect(shouldPersistGenesisQualification(leg, SCOPE.window_end_ms + 1, doc())).toBe(false);
  });

  /**
   * M9 — `GENESIS_CAMPAIGN_FORCE_OFF` WAS NOT THE GENESIS RAIL SWITCH.
   * M10 — IT IS NOW, AND THIS BLOCK ASSERTS THE OPPOSITE OF WHAT IT USED TO.
   *
   * Until M10 it forced `enabled:false` on the campaign CONFIG only, which is read by the
   * retired milestone scans, the cron cost gate and the admin readout. The three armed
   * fixed-grant legs run through `shouldPersistGenesisQualification`, which never read it — so
   * production sat at `GENESIS_CAMPAIGN_FORCE_OFF=true` with the origination path wide open, and
   * this block asserted exactly that ("admits with the flag ON, exactly as with it absent").
   *
   * A gate whose only deny sits in a function with no callers reads as protection in every
   * document that mentions it, so it was wired into the persist gate rather than retired.
   *
   * This is the strongest control available for the change: in this file NOTHING is faked, and
   * the flag-absent case genuinely ADMITS. The same call, same activation, same instant, flips
   * to refused purely on the environment variable — so the assertion cannot pass vacuously the
   * way it would if both branches merely refused.
   */
  describe('SHUTDOWN COVERAGE · the accrual end line closes Genesis admission ', () => {
    const oldEnd = process.env.PVT_ACCRUAL_END_MS;
    afterEach(() => {
      if (oldEnd === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = oldEnd;
    });

    // Terms 24.3: acts received on or after the shutdown date do not mint. A Genesis act is no
    // exception: from the end line no new reservation is made, so the sealing exemption in the
    // accrual only ever covers a reservation made before it.
    it.each(LEGS)('%s — ADMITS before the end line and REFUSES at and after it', (leg) => {
      const at = SCOPE.window_start_ms;
      delete process.env.PVT_ACCRUAL_END_MS;
      const unset = shouldPersistGenesisQualification(leg, at, doc());
      process.env.PVT_ACCRUAL_END_MS = String(at + 1);
      const before = shouldPersistGenesisQualification(leg, at, doc());
      process.env.PVT_ACCRUAL_END_MS = String(at);
      const atLine = shouldPersistGenesisQualification(leg, at, doc());
      process.env.PVT_ACCRUAL_END_MS = 'not a number';
      const malformed = shouldPersistGenesisQualification(leg, at, doc());
      expect(unset).toBe(true);
      expect(before).toBe(true);
      expect(atLine).toBe(false);
      expect(malformed).toBe(false);
    });
  });

  describe('M10 · GENESIS_CAMPAIGN_FORCE_OFF now gates the persist decision', () => {
    const oldForceOff = process.env.GENESIS_CAMPAIGN_FORCE_OFF;
    afterEach(() => {
      if (oldForceOff === undefined) delete process.env.GENESIS_CAMPAIGN_FORCE_OFF;
      else process.env.GENESIS_CAMPAIGN_FORCE_OFF = oldForceOff;
    });

    // Not `it.each` over a locally-declared list: LEGS is derived from the same
    // production policy the gate reads, so an added leg is covered by force.
    it.each(LEGS)('%s — ADMITS with the flag absent and REFUSES with it engaged', (leg) => {
      delete process.env.GENESIS_CAMPAIGN_FORCE_OFF;
      const withoutFlag = shouldPersistGenesisQualification(leg, SCOPE.window_start_ms, doc());

      process.env.GENESIS_CAMPAIGN_FORCE_OFF = 'true';
      const withFlagTrue = shouldPersistGenesisQualification(leg, SCOPE.window_start_ms, doc());

      process.env.GENESIS_CAMPAIGN_FORCE_OFF = '1';
      const withFlagOne = shouldPersistGenesisQualification(leg, SCOPE.window_start_ms, doc());

      // The admit is the half that makes the refusals mean something: this leg really would have
      // originated at this instant, and only the env var stopped it.
      expect(withoutFlag).toBe(true);
      expect(withFlagTrue).toBe(false);
      expect(withFlagOne).toBe(false);
    });

    it.each(['TRUE', 'yes', ' true ', '0', ''])(
      'a mangled value %p does NOT engage the break-glass — it is fail-SAFE, not fail-closed',
      (value) => {
        process.env.GENESIS_CAMPAIGN_FORCE_OFF = value;
        expect(shouldPersistGenesisQualification(
          'genesis_human_signup', SCOPE.window_start_ms, doc(),
        )).toBe(true);
      },
    );

    it('the population is non-empty — three armed legs, not a vacuous sweep', () => {
      expect(LEGS.length).toBe(3);
      expect([...LEGS].sort()).toEqual(
        ['genesis_device_link', 'genesis_human_signup', 'genesis_signup'],
      );
    });

    it('RED — the gate the flag DOES control flips under the same env change', async () => {
      // Without this the assertion above would pass just as well if the flag
      // were inert everywhere — an environment variable nothing reads. The
      // campaign config is what it really controls; proving THAT moves under
      // the identical env change is what makes the pairing meaningful.
      const fake = createFakeFirestore();
      await fake.collection('pvt_config').doc('genesis_campaign').set({ enabled: true });
      const db = fake as unknown as Firestore;

      delete process.env.GENESIS_CAMPAIGN_FORCE_OFF;
      invalidateGenesisConfigCache();
      expect((await loadGenesisCampaignConfig(db)).enabled).toBe(true);

      process.env.GENESIS_CAMPAIGN_FORCE_OFF = 'true';
      invalidateGenesisConfigCache();
      expect((await loadGenesisCampaignConfig(db)).enabled).toBe(false);
    });
  });

  it('RED — a signature by a key that is NOT the configured one is refused', () => {
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', SCOPE.window_start_ms,
      doc({ approval_signature: OTHER.signature }),
    )).toBe(false);
  });

  it('RED — with NO key configured, the same document is refused', () => {
    delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', SCOPE.window_start_ms, doc(),
    )).toBe(false);
  });

  it('RED — a document outside the approved SCOPE is refused, signature notwithstanding', () => {
    // Same real signature, same key: only the scope differs. This is what makes
    // the record "one artifact", not a general signing permission.
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', SCOPE.window_start_ms,
      doc({ canonical_pvt_manifest_id: 'pvt9_something_else_v1' }),
    )).toBe(false);
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', SCOPE.window_start_ms,
      doc({ ledger_namespace: 'pvt9_genesis_v2' }),
    )).toBe(false);
  });

  it('RED — a KILLED document is still refused, and a full replace restores it', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const ref = fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT);

    expect(await isGenesisGrantPersistenceLive(db)).toBe(false); // absent
    await ref.set(doc() as unknown as Record<string, unknown>);
    expect(await isGenesisGrantPersistenceLive(db)).toBe(true);

    await ref.set({
      grants_enabled: false,
      genesis_kill_switch_active: true,
      killed_at_ms: SCOPE.window_start_ms + 5,
      kill_reason: 'rail-open-drill',
    }, { merge: true });
    expect(await isGenesisGrantPersistenceLive(db)).toBe(false);

    await ref.set(doc() as unknown as Record<string, unknown>);
    expect(await isGenesisGrantPersistenceLive(db)).toBe(true);
  });
});
