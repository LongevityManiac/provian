/**
 * the activation document's FULL COMMIT PATH, executed.
 *
 * WHY THIS FILE EXISTS. The production activation document cannot be created:
 * the checked-in Gate 1 approval manifest declares itself non-signable, so no
 * key and no document can open the persist gate. That left the writer's
 * commit path — assemble → sign → pre-flight → write → grants persist → kill →
 * restore — asserted only in its refusing direction, i.e. never actually run.
 *
 * "Blocked by a policy decision" is not a licence to ship an unexercised write
 * path. This file runs the WHOLE path against a genuinely signable FIXTURE
 * manifest and a real ed25519 fixture signature, so everything except the
 * production bytes and the operator’s key is proven now rather than first-run on the day
 * the approval rail is opened.
 *
 * It changes nothing about the production posture: the fixture manifest is
 * mocked into THIS FILE ONLY, exactly as `genesis-activation-approval-binding`
 * already does, and the production manifest stays non-signable everywhere else.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('./policy/pvt9-approval-manifest.generated', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureFs = require('fs') as typeof fs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureCrypto = require('crypto') as typeof crypto;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixturePath = require('path') as typeof path;
  const bytes = fixtureFs.readFileSync(fixturePath.join(
    process.cwd(),
    'src/core/pvt/policy/__fixtures__/approval/manifest-a.json',
  ));
  return {
    PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256:
      `sha256:${fixtureCrypto.createHash('sha256').update(bytes).digest('hex')}`,
    PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64: bytes.toString('base64'),
    PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED: true,
    PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS:
      'approvable_after_independent_review',
  };
});

import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  buildGenesisActivationDocument,
  explainGenesisActivationRefusal,
} from './genesis-activation-document';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  buildGenesisQualification,
  isGenesisGrantPersistenceLive,
  shouldPersistGenesisQualification,
  type GenesisQualificationAction,
  type GenesisQualificationDocument,
} from './genesis-award-state-machine';
import {
  createEmptyGenesisLedgerState,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
} from './policy/genesis-policy-engine';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature } from './policy/approval-signature';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';

const WINDOW = PROPOSED_GENESIS_CAMPAIGN_POLICY.window;
function requireArmedEdge(value: number | null, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`approved Genesis window ${name} is not armed: ${String(value)}`);
  }
  return value;
}
const START = requireArmedEdge(WINDOW.start_ms, 'start_ms');
const END = requireArmedEdge(WINDOW.end_ms, 'end_ms');
/** The approved ledger namespace, read from the source — never a second copy. */
const NAMESPACE = PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.ledger_namespace;

const fixtureDir = path.join(__dirname, 'policy', '__fixtures__', 'approval');
const fixturePublicKey = fs.readFileSync(
  path.join(fixtureDir, 'fixture-key.pub'), 'utf8',
).trim();
const fixtureKeyHash = decodeOpenSshEd25519PublicKey(fixturePublicKey).sha256;
/** A REAL ed25519 SSHSIG over the fixture manifest bytes. */
const realSignature = (which: 'a' | 'b'): SshApprovalSignature => ({
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: fixtureKeyHash,
  armored_signature: fs.readFileSync(
    path.join(fixtureDir, `manifest-${which}.json.sig`), 'utf8',
  ),
});

function activation(
  signature: SshApprovalSignature | null = realSignature('a'),
): GenesisCampaignActivation {
  return buildGenesisActivationDocument({
    frankApprovalAuditId: 'commit-path-frank-audit',
    operatorActivationAuditId: 'commit-path-operator-audit',
    canonicalPvtManifestId: 'pvt9-commit-path-manifest',
    approvalSignature: signature,
  });
}

/**
 * The three approved legs with the anchor kind each one requires, bound to the
 * approved manifest rather than re-declared. A leg whose anchor kind drifted
 * would throw inside `buildGenesisQualification`, not pass quietly.
 */
const LEGS = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map((bounty) => ({
  actionType: bounty.canonical_bounty_key as GenesisQualificationAction,
  fixedGrantAtomic: bounty.fixed_grant_atomic,
}));

const ADDRESS = '0x1111111111111111111111111111111111111111';

/**
 * The reservation input EXACTLY as production derives it from a stored
 * qualification document (`genesis-award-state-machine.ts:1295-1302` and
 * `:1570-1577`) — assembled here from the document's own fields rather than
 * hand-written, so a drift in the document shape breaks this too.
 */
function reservationInputFrom(qualification: GenesisQualificationDocument) {
  return {
    pe_id: qualification.pe_id,
    action_type: qualification.action_type,
    wallet_id: qualification.wallet_id,
    economic_actor_id: qualification.economic_actor_id,
    immutable_anchor: qualification.immutable_anchor,
    qualifying_act_evidence: qualification.qualifying_act_evidence,
  };
}

function qualificationFor(
  actionType: GenesisQualificationAction,
  qualifyingActAtMs: number,
): GenesisQualificationDocument {
  const anchorId = `anchor-${actionType}`;
  return buildGenesisQualification({
    actionType,
    walletId: `wallet-${actionType}`,
    economicActorId: `actor-${actionType}`,
    actorAddress: ADDRESS,
    immutableAnchorId: anchorId,
    qualifyingActEvidenceId: `evidence-${actionType}`,
    qualifyingActAtMs,
    walletCreatedAtMs: qualifyingActAtMs,
    walletCreatedEvidenceId: `wallet-evidence-${actionType}`,
  });
}

/** Exactly what `routes/admin-genesis.ts:129-138` merges on a kill. */
async function killLikeTheRoute(
  fake: ReturnType<typeof createFakeFirestore>,
): Promise<void> {
  await fake.collection(GENESIS_ACTIVATION_COLLECTION).doc(GENESIS_ACTIVATION_DOCUMENT)
    .set({
      grants_enabled: false,
      genesis_kill_switch_active: true,
      killed_at_ms: START + 5,
      kill_reason: 'commit-path-drill',
    }, { merge: true });
}

describe('the fixture manifest really is signable, unlike production', () => {
  const oldKey = process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
  const oldHash = process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
  beforeAll(() => {
    process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = fixturePublicKey;
    process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = fixtureKeyHash;
  });
  afterAll(() => {
    if (oldKey === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY;
    else process.env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY = oldKey;
    if (oldHash === undefined) delete process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256;
    else process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 = oldHash;
  });

  it('the WHOLE pre-flight admits with a real signature and the real verifier', () => {
    // No injected verifier anywhere below this line: this is the production
    // approval path, differing from production ONLY in the manifest bytes.
    expect(explainGenesisActivationRefusal(activation()))
      .toEqual({ verdict: 'admits' });
    expect(shouldPersistGenesisQualification('genesis_human_signup', START, activation()))
      .toBe(true);
  });

  it('RED — the SAME path refuses signature B (wrong key material for these bytes)', () => {
    expect(explainGenesisActivationRefusal(activation(realSignature('b'))))
      .toEqual({ verdict: 'signature_not_verified' });
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', START, activation(realSignature('b')),
    )).toBe(false);
  });

  it('RED — and refuses an UNSIGNED document', () => {
    expect(explainGenesisActivationRefusal(activation(null)))
      .toEqual({ verdict: 'malformed', reason: 'proposal_not_approved' });
    expect(shouldPersistGenesisQualification(
      'genesis_human_signup', START, activation(null),
    )).toBe(false);
  });

  describe('an in-window act on EACH leg persists, with the right instant and namespace', () => {
    it('covers all three legs over a non-empty population', () => {
      expect(LEGS.length).toBe(3);
      expect(LEGS.map((l) => l.actionType).sort())
        .toEqual(['genesis_device_link', 'genesis_human_signup', 'genesis_signup']);
      expect(NAMESPACE).toBe('pvt9_genesis_v1');
    });

    it.each(LEGS)('$actionType — the gate admits and the outbox freezes the ORIGINAL instant',
      ({ actionType }) => {
        const actAtMs = START + 1_234;
        const qualification = qualificationFor(actionType, actAtMs);
        expect(shouldPersistGenesisQualification(actionType, actAtMs, activation()))
          .toBe(true);
        // The instant carried into the outbox is the qualifying act's own, not
        // "now" — this is the property the H1 retention path preserves.
        expect(qualification.qualifying_act_evidence.qualifying_act_at_ms).toBe(actAtMs);
        expect(qualification.action_type).toBe(actionType);
      });

    it.each(LEGS)('$actionType — reservation lands in the approved ledger namespace',
      ({ actionType, fixedGrantAtomic }) => {
        const actAtMs = START + 1_234;
        const qualification = qualificationFor(actionType, actAtMs);
        const result = reserveGenesisCampaignGrant({
          manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
          activation: activation(),
          state: createEmptyGenesisLedgerState(NAMESPACE),
          input: reservationInputFrom(qualification),
          observation_context: qualification.observation_context,
        });
        expect(result).toMatchObject({ allowed: true, reason: 'reserved' });
        if (!result.allowed) throw new Error('unreachable');
        expect(result.next_state.ledger_namespace).toBe(NAMESPACE);
        expect(result.reservation.canonical_bounty_key).toBe(actionType);
        expect(result.reservation.qualifying_act_at_ms).toBe(actAtMs);
        // Full wallet-age multiplier at the window start ⇒ the gross fixed grant.
        expect(result.reservation.fixed_grant_atomic).toBe(fixedGrantAtomic);
        expect(BigInt(result.reservation.reserved_atomic)).toBeGreaterThan(0n);
      });

    it.each(LEGS)('$actionType — RED: an OUT-OF-WINDOW act is refused on both edges',
      ({ actionType }) => {
        expect(shouldPersistGenesisQualification(actionType, START - 1, activation()))
          .toBe(false);
        expect(shouldPersistGenesisQualification(actionType, END + 1, activation()))
          .toBe(false);
      });
  });

  describe('the kill / restore cycle, through the real production readback', () => {
    it('kill closes the gate, and a FIELD MERGE cannot re-open it — a full replace can', async () => {
      const fake = createFakeFirestore();
      const db = fake as unknown as Firestore;
      const ref = fake.collection(GENESIS_ACTIVATION_COLLECTION)
        .doc(GENESIS_ACTIVATION_DOCUMENT);

      // 1. WRITTEN — the writer's commit shape: a full set() of exactly 16 keys.
      await ref.set(activation() as unknown as Record<string, unknown>);
      expect(await isGenesisGrantPersistenceLive(db)).toBe(true);

      // 2. KILLED — exactly as POST /v1/admin/genesis/kill merges it.
      await killLikeTheRoute(fake);
      expect(await isGenesisGrantPersistenceLive(db)).toBe(false);

      // 3. THE UN-KILL TRAP. Clearing the flag alone leaves the merged
      //    `killed_at_ms`/`kill_reason` keys behind, and `hasExactKeys` counts
      //    keys exactly — so the document LOOKS re-armed and is permanently
      //    refused. This is the finding the writer's full-replace comment cites.
      await ref.set({ grants_enabled: true, genesis_kill_switch_active: false }, { merge: true });
      const stale = (await ref.get()).data() ?? {};
      expect(Object.keys(stale)).toContain('killed_at_ms');
      expect(Object.keys(stale)).toContain('kill_reason');
      expect(await isGenesisGrantPersistenceLive(db)).toBe(false);

      // 4. RESTORED — a full replace of exactly the 16 keys re-opens the gate.
      await ref.set(activation() as unknown as Record<string, unknown>);
      expect(Object.keys((await ref.get()).data() ?? {})).toHaveLength(16);
      expect(await isGenesisGrantPersistenceLive(db)).toBe(true);
    });

    it('RED — an ABSENT document is not live, so step 1 above is not vacuous', async () => {
      const fake = createFakeFirestore();
      expect(await isGenesisGrantPersistenceLive(fake as unknown as Firestore)).toBe(false);
    });
  });
});
