import { observeActorSession } from '../core/jurisdiction/mint-compliance';
import type { RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { v4 as uuidv4 } from 'uuid';

import type { PEBatchWriter } from '../pe-batch-writer';
import type { RecordPEAccrualParams } from '../pvt-accrual';
import {
  buildGenesisQualification,
  shouldEnqueueGenesisQualification,
  type GenesisProcessResult,
} from '../core/pvt/genesis-award-state-machine';
import {
  GenesisIngressError,
  HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION,
  acknowledgeHumanWalletStandardAccrual,
  commitHumanWalletRegistration,
  humanWalletRegistrationIndexId,
  humanWalletRegistrationRequestFingerprint,
  type HumanRegistrationMarker,
  type HumanWalletCommitResult,
} from '../core/pvt/genesis-ingress';
import { priceRelayAct, readRelayActIntake } from '../core/meter/meter-relay-authored';
import type { GenesisActivationApprovalVerifier } from '../core/pvt/policy/genesis-policy-engine';
import { readAgreedBaseHead } from '../core/onchain/economic-discovery';
import {
  createNativeWalletRegistrationFence,
  parseNativeWalletRegistrationFence,
  type NativeWalletRegistrationFence,
} from '../core/pvt/native-wallet-registration';
import {
  verifyHumanWalletAddressProof,
  type VerifiedHumanWalletAddressProof,
} from '../core/wallet-registration/human-wallet-address-proof';
import { emitHumanWalletReclaimPE } from '../core/wallet-registration/human-wallet-displacement-pe';

/** the registration error codes that are not a plain 409 conflict. */
const REGISTRATION_ERROR_STATUS: Readonly<Record<string, number>> = {
  human_wallet_address_proof_required: 428,
  human_wallet_address_proof_invalid: 400,
};

export interface HumanWalletDocument {
  id: string;
  type: 'human';
  user_id: string;
  address: string;
  public_key: string;
  created_at: number;
  pe_count: number;
  pvt_earned: number;
  trust_score: number;
  foundation_eligible: boolean;
  native_watcher_registration: NativeWalletRegistrationFence;
  /**
   * set when the registration carried an EIP-712 proof that its caller controls
   * `address` (every registration since). Absent on older, unproven registrations —
   * which a later proof-carrying registration of the same address by its real key holder may
   * displace (`displaced_at_ms` / `displaced_by_*` are then stamped on the displaced doc).
   */
  address_proven_at_ms?: number;
  /** set by DELETE /v1/user/data — the owner released this registration. */
  released_at_ms?: number;
}

export interface HumanWalletRegistrationDeps {
  readonly db: Firestore;
  readonly peBuffer: Pick<PEBatchWriter, 'enqueue'>;
  readonly recordPEAccrual: (params: RecordPEAccrualParams) => Promise<void>;
  readonly processGenesisQualification: (
    qualificationId: string,
  ) => Promise<GenesisProcessResult>;
  /** Explicit test seam. Production always uses structured SSHSIG verification. */
  readonly genesisActivationApprovalVerifier?: GenesisActivationApprovalVerifier;
  readonly now?: () => number;
  readonly makeId?: () => string;
  /** Production binds this to the two-operator Base head reader. */
  readonly readBaseRegistrationHead?: () => Promise<number>;
}

function retryPayload(
  marker: HumanRegistrationMarker,
  error: string,
): Record<string, unknown> {
  return {
    error,
    walletId: marker.wallet_id,
    address: marker.address,
    firstEnvelopeId: marker.pe_id,
    createdAt: new Date(marker.created_at_ms).toISOString(),
    registrationMarker: marker.pe_id,
    retryWithSameWalletIdentity: true,
  };
}

/**
 * Crash-safe human registration. The product record, first PE, chain tip, and
 * optional Genesis outbox commit atomically; every later substep resumes from
 * the sealed per-user marker and never allocates a second identity.
 */
export function createHumanWalletRegistrationHandler(
  deps: HumanWalletRegistrationDeps,
): RequestHandler {
  return async function registerHumanWallet(req, res): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const rawPublicKey = req.body?.publicKey;
    const rawAddress = req.body?.address;
    if (typeof rawPublicKey !== 'string' || rawPublicKey.trim().length === 0) {
      res.status(400).json({ error: 'publicKey is required' });
      return;
    }
    if (typeof rawAddress !== 'string' || rawAddress.trim().length === 0) {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    const publicKey = rawPublicKey.trim();
    const address = rawAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: 'address must be a canonical EVM address' });
      return;
    }

    const createdAt = (deps.now ?? Date.now)();
    const makeId = deps.makeId ?? uuidv4;
    const walletId = `wallet_${makeId()}`;
    const peId = `pe_${makeId()}`;
    let nativeWatcherRegistration: NativeWalletRegistrationFence;
    let addressProof: VerifiedHumanWalletAddressProof | null = null;
    try {
      const existingIndex = await deps.db
        .collection(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION)
        .doc(humanWalletRegistrationIndexId(userId))
        .get();
      if (!existingIndex.exists) {
        // a NEW registration must prove control of the address. The idempotent replay
        // of an existing registration (marker present) stays proof-free, so every wallet
        // registered before this change keeps working without the app re-signing anything.
        const rawProof: unknown = req.body?.address_proof;
        if (rawProof === undefined || rawProof === null) {
          res.status(428).json({ error: 'address_proof_required' });
          return;
        }
        const verdict = verifyHumanWalletAddressProof(rawProof, {
          userId,
          deviceId: req.user?.device_id,
          address,
          nowMs: createdAt,
        });
        if (!verdict.ok) {
          res.status(verdict.reason === 'address_proof_signer_mismatch' ? 403 : 400)
            .json({ error: 'address_proof_invalid', reason: verdict.reason });
          return;
        }
        addressProof = verdict.proof;
      }
      if (existingIndex.exists) {
        const existingWalletId = existingIndex.data()?.wallet_id;
        if (typeof existingWalletId !== 'string' || existingWalletId.length === 0) {
          throw new Error('human_wallet_registration_index_invalid');
        }
        const existingWallet = await deps.db.collection('wallets').doc(existingWalletId).get();
        if (!existingWallet.exists) {
          throw new Error('human_wallet_registration_required_record_missing');
        }
        nativeWatcherRegistration = parseNativeWalletRegistrationFence(
          existingWallet.data()?.native_watcher_registration,
        );
      } else {
        nativeWatcherRegistration = createNativeWalletRegistrationFence(
          await (deps.readBaseRegistrationHead ?? readAgreedBaseHead)(),
        );
      }
    } catch (error) {
      console.error('[human-register] Base registration fence unavailable', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ error: 'human_wallet_registration_fence_unavailable' });
      return;
    }
    const walletDocument: HumanWalletDocument = {
      id: walletId,
      type: 'human',
      user_id: userId,
      address,
      public_key: publicKey,
      created_at: createdAt,
      pe_count: 1,
      pvt_earned: 0,
      trust_score: 0,
      foundation_eligible: true,
      native_watcher_registration: nativeWatcherRegistration,
    };

    const genesisQualification = shouldEnqueueGenesisQualification(
      'genesis_human_signup',
      createdAt,
    )
      ? buildGenesisQualification({
        actionType: 'genesis_human_signup',
        walletId,
        economicActorId: userId,
        actorAddress: address,
        immutableAnchorId: walletId,
        qualifyingActEvidenceId: `human-wallet:${walletId}`,
        qualifyingActAtMs: createdAt,
        walletCreatedAtMs: createdAt,
        walletCreatedEvidenceId: `human-wallet:${walletId}`,
      })
      : null;

    // PE METER: the first PE is a v2 relay act (content: `humanRegistrationPeContent`), priced
    // through its staged intake; the relay keeps no copy, and the owner gets it in the response.
    const buildAccrual = (peHash: string): RecordPEAccrualParams => ({
      peId,
      userId,
      actionType: 'wallet_created',
      integrationSource: 'human_wallet_registration',
      attestationDepth: 'software',
      peHash,
      timestamp: createdAt,
      inputSummary: `Human wallet registered: ${address.slice(0, 10)}...`,
      deviceId: req.user?.device_id || null,
      ownerType: 'human',
      walletAddress: address,
      throwOnError: true,
    });

    let committed;
    try {
      committed = await commitHumanWalletRegistration({
        db: deps.db,
        userId,
        walletId,
        address,
        publicKey,
        requestFingerprint: humanWalletRegistrationRequestFingerprint(
          userId,
          address,
          publicKey,
        ),
        economicDeviceId: req.user?.device_id || null,
        createdAtMs: createdAt,
        walletDocument: walletDocument as unknown as Record<string, unknown>,
        nativeWatcherRegistration,
        peId,
        buildAccrual,
        genesisQualification,
        genesisActivationApprovalVerifier: deps.genesisActivationApprovalVerifier,
        addressProof,
      });
    } catch (error) {
      const code = error instanceof GenesisIngressError
        ? error.code
        : 'human_wallet_registration_failed';
      console.error('[human-register] Atomic registration failed', {
        userId,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
      if (code === 'human_wallet_address_proof_required') {
        // Raced a marker deletion/absence the pre-read did not see: same answer as the pre-read.
        res.status(428).json({ error: 'address_proof_required' });
        return;
      }
      res.status(error instanceof GenesisIngressError ? (REGISTRATION_ERROR_STATUS[code] ?? 409) : 500)
        .json({ error: code });
      return;
    }

    const marker = committed.marker;
    const existingWallet = committed.walletDocument as unknown as HumanWalletDocument;

    // the real key holder displaced an unproven registration of this address. The
    // re-point is already committed; seal the reclaim receipt on the displacer's chain.
    if (committed.displacement !== null) {
      console.warn('[human-register] Unproven registration displaced by the address key holder', {
        userId,
        walletId: marker.wallet_id,
        displacedWalletId: committed.displacement.displacedWalletId,
        // When true, the displaced registration already sealed this address's one Genesis
        // human-signup grant — it pays this address (the key holder), so no second grant formed.
        genesisAlreadyGrantedForAddress: committed.displacement.genesisAlreadyGrantedForAddress,
      });
      await emitHumanWalletReclaimPE({
        deps,
        userId,
        walletId: marker.wallet_id,
        address: existingWallet.address,
        displacedWalletId: committed.displacement.displacedWalletId,
        genesisAlreadyGrantedForAddress: committed.displacement.genesisAlreadyGrantedForAddress,
        occurredAtMs: marker.created_at_ms,
      });
    }

    // F46: bind wallet_address onto the users doc HERE — the authenticated
    // (wallet-HMAC) path — because POST /v1/users no longer persists a
    // caller-supplied address. `req.user.id === userId`, so a user binds only
    // their OWN address to their OWN users doc; an attacker can no longer create a
    // shell users doc carrying a victim's address. This is what lets
    // POST /v1/users/recover find the account by wallet_address. Best-effort +
    // merge (idempotent on replay); a transient failure here does not fail the
    // committed registration — recovery would simply create-new until it lands,
    // the same as before this change.
    try {
      await deps.db.collection('users').doc(userId).set(
        { wallet_address: existingWallet.address.toLowerCase() },
        { merge: true },
      );
    } catch (bindErr) {
      console.warn('[human-register] users.wallet_address bind deferred (non-fatal)', {
        userId,
        error: bindErr instanceof Error ? bindErr.message : String(bindErr),
      });
    }

    await observeActorSession(deps.db, req, userId);
    if (marker.standard_accrual_status !== 'complete') {
      try {
        await priceHumanRegistrationAct(deps, committed, userId);
        await acknowledgeHumanWalletStandardAccrual({
          db: deps.db,
          userId,
          peId: marker.pe_id,
          peHash: marker.pe_hash,
          acknowledgedAtMs: (deps.now ?? Date.now)(),
        });
      } catch (error) {
        console.error('[human-register] Registration committed; standard accrual pending retry', {
          userId,
          walletId: marker.wallet_id,
          peId: marker.pe_id,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json(retryPayload(
          marker,
          'human_wallet_registration_accrual_pending',
        ));
        return;
      }
    }

    // Honest status, mapped from the durable disposition (honest on replay too):
    //  - `retained`  → refused-but-retained in-window act, awaiting activation/backfill.
    //  - `persisted` → in the mint-readable outbox (fresh persist OR an H2 backfill
    //    promoted a formerly-retained grant); reported truthfully even when this marker
    //    predates persistence and so carries no qualification id. Default `queued`; the
    //    fresh-persist branch below overrides it with the precise processing status.
    //  - otherwise   → `not_qualified`, reserved for an act that never qualified.
    let genesisStatus:
      | GenesisProcessResult['status']
      | 'not_qualified'
      | 'retained_pending_activation'
      | 'queued' =
      committed.genesisDisposition === 'retained'
        ? 'retained_pending_activation'
        : committed.genesisDisposition === 'persisted'
          ? 'queued'
          : 'not_qualified';
    if (marker.genesis_qualification_id) {
      try {
        const genesis = await deps.processGenesisQualification(
          marker.genesis_qualification_id,
        );
        genesisStatus = genesis.status;
      } catch (error) {
        console.warn('[human-register] Registration committed; Genesis qualification pending retry', {
          userId,
          walletId: marker.wallet_id,
          peId: marker.pe_id,
          qualificationId: marker.genesis_qualification_id,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({
          ...retryPayload(marker, 'human_wallet_genesis_qualification_pending'),
          standardAccrualAcknowledged: true,
          genesisQualificationId: marker.genesis_qualification_id,
        });
        return;
      }
    }

    res.status(committed.created ? 201 : 200).json({
      walletId: marker.wallet_id,
      address: existingWallet.address,
      firstEnvelopeId: marker.pe_id,
      // PE METER: the owner keeps its PEs. The first one comes back here (rebuilt on a replay)
      // so the app files it in its PE store and cloud backup.
      firstEnvelope: committed.peDocument,
      createdAt: new Date(marker.created_at_ms).toISOString(),
      idempotentReplay: !committed.created,
      addressReclaimed: committed.displacement !== null,
      standardAccrualAcknowledged: true,
      genesisQualificationId: marker.genesis_qualification_id,
      genesisQualificationStatus: genesisStatus,
    });
  };
}

/**
 * Price the registration's first PE exactly once. A metered registration prices its staged relay
 * intake (fresh: the one just staged; a replay: whatever is still staged — once priced, the intake
 * is gone and the act key holds the outcome, so there is nothing left to do). A pre-meter
 * registration still pending its standard accrual takes the accrual it always took.
 */
async function priceHumanRegistrationAct(
  deps: HumanWalletRegistrationDeps,
  committed: HumanWalletCommitResult,
  userId: string,
): Promise<void> {
  const marker = committed.marker;
  if (committed.peMetered) {
    const intake = committed.intake ?? await readRelayActIntake(deps.db, marker.pe_id);
    if (intake === null) return;
    if (intake.act.pe_hash !== marker.pe_hash || intake.actor_id !== userId) {
      throw new Error('human_wallet_registration_intake_mismatch');
    }
    await priceRelayAct(deps.db, intake, { record: deps.recordPEAccrual });
    return;
  }
  // A pre-meter registration replayed: its accrual landed when it was first committed (the app
  // replays on every launch), and the PE meter migration has since retired that record into
  // the meter's own state. Recording it again would write a fresh legacy row the relay no
  // longer keeps, so a replay prices nothing.
}
