import AsyncStorage from '@react-native-async-storage/async-storage';
import { isEvmTxHash } from './txHash';
import { v4 as uuidv4 } from 'uuid';
import { Mutex } from 'async-mutex';
import stableStringify from 'json-stable-stringify';
import KeyManager from '../security/KeyManager';
import securityLog from '../security/securityLogger';
import { setItemHmac, getItemHmacWithLegacyFallback } from '../security/hmacAsyncStorage';
import { ProvenanceEnvelope, ActionType, RiskLevel, AgreementDetails, PromiseStatus, AgreementSettlementDetails, OfflineSettlementPayload, RecoveryEnvelopeDetails, RecoveryAttestation, AIConversationMetadata } from './types';
import { GENESIS_PREV_HASH } from './constants';
import { hashEnvelopeCanonical } from './peHash';
import { normalizeInputOrigins } from './inputOrigins';
import { withQueuedOutputCitations } from '../meter/outputSigning';
import PELifecycleManager from './PELifecycleManager';
import { ingestPE, estimateFromPE } from '../footprint/FootprintService';
import { PEQueryOptions, PEQueryResult } from './lifecycleTypes';

const CHAIN_HEAD_KEY = 'provian_pe_chain_head';
// PE METER : the single-PE submit queue and the history backfill cursor are
// retired with `POST /v1/pe/submit/mobile`. Every act now reaches the relay as one entry of the
// phone's daily batch (core/meter/); the meter removes those two leftover keys at start.
// [Audit N3] Durable queue of PE-creation params whose createEnvelope threw
// BEFORE the envelope reached the WAL (e.g. hardware key momentarily
// unavailable, signing failure) AFTER the underlying on-chain action already
// confirmed. Retried on foreground so a confirmed transfer/swap always gets a
// provenance record instead of being silently skipped.
const PE_DEFERRED_CREATE_KEY = 'provian_pe_deferred_create';
const PE_DEFERRED_CREATE_CAP = 200;

// SECURITY FIX 9.1: Chain integrity verification
// Tracks verification state and alerts on tampering
export interface ChainIntegrityResult {
    valid: boolean;
    envelopesVerified: number;
    brokenAtIndex?: number;
    brokenEnvelopeId?: string;
    expectedHash?: string;
    actualHash?: string;
    error?: string;
}

// Callback for tampering alerts
type TamperingAlertCallback = (result: ChainIntegrityResult) => void;
let tamperingAlertCallback: TamperingAlertCallback | null = null;

// Periodic verification interval (5 minutes)
const VERIFICATION_INTERVAL_MS = 5 * 60 * 1000;
let verificationTimer: ReturnType<typeof setInterval> | null = null;
let lastVerificationResult: ChainIntegrityResult | null = null;

/**
 * H-8 (audit 2026-05-11): thrown when a hardware-capable device's first
 * PE would otherwise downgrade to software-tier because the SE/StrongBox
 * was momentarily unavailable on cold start. Callers should retry after
 * a short delay rather than recording a software-tier wallet_created PE
 * (which is rate-limited per device and locks the downgrade in
 * permanently).
 */
export class HardwareKeyNotReadyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HardwareKeyNotReadyError';
    }
}

import type { BiometricAction } from '../security/biometricAction';

export interface EnvelopeContext {
    actionType: ActionType;
    intentText: string;
    assetSymbol: string;
    amount: string;
    chainId: number | string;
    counterparty?: string;
    contract?: string;
    riskScore: number;
    riskCategory: RiskLevel;
    // 'none' [F15]: no device policy engine adjudicated this record (e.g. a
    // self-reported agent transaction synced from the relay). Never claim 'allow'
    // for an event the device did not authorize.
    policyDecision: 'allow' | 'override' | 'block' | 'none';
    originBinding?: string;
    agreementDetails?: AgreementDetails;
    agentId?: string;
    agentActionType?: string;
    // 'agent_reported' [F15]: the agent asserted this happened; the device did NOT
    // authorize or adjudicate it (no AAG token / proxied-payment result cross-reference).
    authorizationDecision?: 'allow' | 'deny' | 'require_human' | 'agent_reported';
    authorizationReasonCodes?: string[];
    authorizationHumanRequired?: boolean;
    authorizationHumanDecision?: 'allow' | 'deny';
    authorizationStage?: 'request' | 'human_decision' | 'execution';  // [Fix 7] Added 'execution' for execution-stage denials
    authorizationRequestId?: string;
    authorizationBudgetId?: string | null;
    authorizationIntentId?: string | null;
    authorizationMerchant?: string;
    authorizationPurpose?: string;
    // Promise Negotiation fields
    negotiationThreadId?: string;
    negotiationOfferId?: string;
    negotiationTerms?: string; // JSON-serialized terms
    negotiationCounterOf?: string; // ID of promise being countered
    // Non-Financial Action Metadata
    communicationMetadata?: {
        channel: string;
        recipient: string;
        subject?: string;
        isReply: boolean;
        platform?: string;
    };
    commitmentMetadata?: {
        commitmentType: string;
        counterparty: string;
        description: string;
        isRevocable: boolean;
        financialImplication?: {
            amount: number;
            currency: string;
            timing: string;
        };
    };
    dataSharingMetadata?: {
        dataType: string;
        recipient: string;
        description: string;
        itemCount?: number;
        isRecoverable: boolean;
    };
    /** Promise completion premium - set to true when both parties confirm fulfillment */
    promiseCompletionPremium?: boolean;
    /** Promise ID for cross-referencing */
    promiseId?: string;
    /** Goal Envelope metadata (Policy Sandbox) */
    goalEnvelopeMetadata?: ProvenanceEnvelope['goal_envelope_metadata'];
    /** Corroboration Signal metadata */
    corroborationMetadata?: ProvenanceEnvelope['corroboration_metadata'];
    /** Human approval reference (Trust Layer §2.10) — required for 'human_approval', metadata-only. */
    approvalMetadata?: ProvenanceEnvelope['approval_metadata'];
    /**
     * AI conversation metadata. Required when actionType is 'ai_conversation',
     * ignored otherwise. Shape matches the backend validator in
     * provian-backend/src/routes/pe-submit-mobile-metadata.ts byte-for-byte.
     */
    aiConversationMetadata?: AIConversationMetadata;
    /** Override actor address (used during wallet creation when KeyManager isn't initialized yet) */
    actorAddress?: string;
    /**
     * Prompt 1 (forward-only): external input origins this action consumed. Any
     * caller-shaped value; normalized to its canonical three-state form and set
     * on the envelope ONLY when non-null, so an action that observed no origins
     * hashes byte-identically to a pre-change PE. PURE PROVENANCE, ZERO mint effect.
     */
    inputOrigins?: unknown;
    /**
     * (forward-only): the transaction hash of a CONFIRMED on-chain send /
     * swap. Set on the envelope only when it is a well-formed 0x-hex hash; the
     * relay queues it (Base only) for its chain-record lane, which re-reads the
     * transaction and derives the act from the chain. Never evidence by itself.
     */
    txHash?: string;
}

class ProvenanceEnvelopeManager {
    private static instance: ProvenanceEnvelopeManager;

    private constructor() { }

    static getInstance(): ProvenanceEnvelopeManager {
        if (!ProvenanceEnvelopeManager.instance) {
            ProvenanceEnvelopeManager.instance = new ProvenanceEnvelopeManager();
        }
        return ProvenanceEnvelopeManager.instance;
    }

    private pendingQueue: ProvenanceEnvelope[] = [];
    // [Audit N3 follow-up] Re-entrancy guard for retryDeferredEnvelopes. It is
    // fired non-blocking from a screen useEffect that can re-run on remount, and
    // createEnvelope re-mints a fresh envelope_id per call (no content dedup), so
    // two overlapping runs would duplicate a confirmed action's PE.
    private deferredRetryInFlight = false;
    // Item 2a: re-entrancy guard for resubmitUnrecordedHistory (same rationale
    // as deferredRetryInFlight — it is fired non-blocking from app start and
    // can be re-triggered while a pass is mid-flight; overlapping passes would
    // race the shared resume cursor).
    private backfillInFlight = false;
    private BATCH_SIZE = 10;
    private FLUSH_INTERVAL = 5000; // 5 seconds
    private flushTimer: NodeJS.Timeout | null = null;

    // SECURITY FIX: M-22 - Cache last verified chain position to avoid re-verifying entire chain.
    // Invalidated on any write operation that could affect the chain.
    private lastVerifiedIndex: number = -1;
    private lastVerifiedHash: string = '';

    // #13: Cache PE hashes after computation to avoid rehashing on verification.
    // Keyed by envelope_id - only populated after signing (when signature is present).
    private hashCache: Map<string, string> = new Map();

    /**
     * PE METER: who builds each durable record's PE v2 (the phone meter registers itself at start).
     * Absent → the meter catches the records up from the hot tier when it starts.
     */
    private meterRecorder: ((envelopes: ProvenanceEnvelope[]) => Promise<void>) | null = null;

    setMeterRecorder(recorder: ((envelopes: ProvenanceEnvelope[]) => Promise<void>) | null): void {
        this.meterRecorder = recorder;
    }

    /**
     * Hashes a ProvenanceEnvelope.
     * @param envelope The envelope to hash.
     * @returns The SHA256 hash of the envelope.
     */
    // SECURITY FIX: H-6 - Use canonical JSON (json-stable-stringify) for deterministic PE hashing.
    // JSON.stringify output order depends on insertion order, which can vary across platforms/serialization cycles.
    // #13: Returns cached hash when available to avoid recomputing SHA256.
    // INTEROP FIX: Hash excludes `signature` field per PE_PROTOCOL_SPEC.md Section 6.
    // This ensures any conforming implementation produces identical hashes for the same envelope.
    private async hashEnvelope(envelope: ProvenanceEnvelope): Promise<string> {
        // Check hash cache first
        const cached = this.hashCache.get(envelope.envelope_id);
        if (cached) return cached;

        // Delegate to the single canonical hasher (peHash.ts) so this, the
        // lifecycle manager, and the cloud sync module all chain on identical
        // hashes. See peHash.ts for the signature-excluded / canonical-JSON
        // rules.
        const hash = await hashEnvelopeCanonical(envelope);

        // Cache the hash for future lookups
        this.hashCache.set(envelope.envelope_id, hash);

        return hash;
    }

    /**
     * Compute the prev_envelope_hash for the next envelope.
     *
     * Precedence (authoritative head, NOT getHistory()[last]):
     *   1. The last in-memory pending PE — PEs created within one flush window
     *      live in pendingQueue and are not yet in storage; chaining off the
     *      stored tail here would give every PE in the batch the SAME prev hash
     *      (a fork that verifyChainIntegrity then reports as broken).
     *   2. CHAIN_HEAD_KEY — the canonical head flushQueueInternal updates on
     *      every flush. This survives archival: when the oldest hot PEs age out
     *      of storage, getHistory()[last] would be wrong (or empty → GENESIS),
     *      but the stored head still points at the true latest PE.
     *   3. The last stored (legacy/hot) PE — fallback if the head key is absent.
     *   4. GENESIS — only for a genuinely empty chain.
     *
     * Must be called inside the createEnvelope mutex so pendingQueue and the
     * stored head cannot change underneath it.
     */
    private async computePrevHash(): Promise<string> {
        if (this.pendingQueue.length > 0) {
            return this.hashEnvelope(this.pendingQueue[this.pendingQueue.length - 1]);
        }
        const storedHead = await getItemHmacWithLegacyFallback<string>(CHAIN_HEAD_KEY, (raw) => raw);
        if (storedHead && typeof storedHead === 'string' && storedHead.length > 0) {
            return storedHead;
        }
        const history = await this.getHistoryRaw();
        if (history.length > 0) {
            return this.hashEnvelope(history[history.length - 1]);
        }
        return GENESIS_PREV_HASH;
    }

    /**
     * The hash the FIRST retained envelope must link back to. For a fresh or
     * never-archived chain this is GENESIS; once archival has shed the oldest
     * PEs out of hot/legacy storage, the first retained PE links to the warm
     * boundary (the hash of the last-archived PE) instead. Reading this lets
     * verifyChainIntegrity tolerate legitimate archival truncation rather than
     * false-positiving "first envelope does not have genesis prev hash".
     */
    private async getChainAnchorHash(): Promise<string> {
        try {
            const tiered = await getItemHmacWithLegacyFallback<{ warmBoundaryHash?: string }>('provian_pe_tiered');
            if (tiered && typeof tiered.warmBoundaryHash === 'string' && tiered.warmBoundaryHash.length > 0) {
                return tiered.warmBoundaryHash;
            }
        } catch {
            // Tiered storage unavailable: fall through to genesis.
        }
        return GENESIS_PREV_HASH;
    }

    // SECURITY FIX: F-4 - Use async-mutex instead of custom lock to prevent race conditions
    private readonly mutex = new Mutex();

    private readonly STORAGE_KEY = 'provian_pe_history';

    /**
     * Create a new Provenance Envelope (Batched)
     * SECURITY FIX: F-4 - Uses async-mutex for race-free envelope creation
     */
    async createEnvelope(params: EnvelopeContext, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope> {
        // SECURITY FIX: F-4 - Use mutex.runExclusive for atomic envelope creation
        return await this.mutex.runExclusive(async () => {
            // [BUG FIX - KeyManager lazy init + fallback]
            // Address resolution order:
            //   1. Explicitly passed actorAddress (e.g. agent flows)
            //   2. KeyManager.getAddress() - the hardware-backed PE signing key
            //   3. KeyManager.generateKey() then retry - for existing users
            //      whose wallet was created before the WalletCreationService
            //      hardware-key initialization fix landed
            //   4. walletStore.getState().address - last-resort fallback
            //
            // Why step 3: WalletCreationService didn't call generateKey()
            // until very recently, so existing users created their wallets
            // without ever initializing the P-256 PE signing key. The first
            // time createEnvelope runs on those devices, KeyManager is
            // empty, getAddress() returns null, and the user got
            // "No wallet initialized" or fell through to step 4 with a
            // software-tier attestation. Lazy-initializing here auto-heals
            // any device that already has a wallet but no hardware key.
            //
            // The lazy init is safe because the hardware key is independent
            // of the BIP-39 seed - generating it doesn't affect any existing
            // funds, addresses, or PEs. It just enables hardware attestation
            // for FUTURE PEs from this device.
            let address = params.actorAddress || await KeyManager.getAddress();

            if (!address) {
                // H-8 (audit 2026-05-11): retry the hardware key lazy-init
                // a few times before falling back. The most common failure
                // mode is the Secure Enclave / StrongBox being momentarily
                // unavailable on cold start (especially Android). A bare
                // first-attempt failure used to silently downgrade the
                // *first* PE on the device to software-tier - and because
                // wallet_created is rate-limited per device, that downgrade
                // locked in permanently.
                const MAX_LAZY_INIT_RETRIES = 3;
                const LAZY_INIT_RETRY_DELAY_MS = 500;
                for (let attempt = 0; attempt < MAX_LAZY_INIT_RETRIES; attempt++) {
                    try {
                        const hasKey = await KeyManager.hasKey();
                        if (!hasKey) {
                            console.warn(
                                `[PE] No hardware PE key - lazy-initializing via KeyManager.generateKey() (attempt ${attempt + 1}/${MAX_LAZY_INIT_RETRIES})`,
                            );
                            await KeyManager.generateKey();
                        }
                        address = await KeyManager.getAddress();
                        if (address) {
                            if (attempt > 0) {
                                console.log(`[PE] Hardware PE key initialized on retry ${attempt}:`, address);
                            } else {
                                console.log('[PE] Hardware PE key initialized successfully:', address);
                            }
                            break;
                        }
                    } catch (genErr) {
                        console.warn(
                            `[PE] KeyManager.generateKey() failed on attempt ${attempt + 1}/${MAX_LAZY_INIT_RETRIES}:`,
                            genErr,
                        );
                        if (attempt < MAX_LAZY_INIT_RETRIES - 1) {
                            await new Promise((r) => setTimeout(r, LAZY_INIT_RETRY_DELAY_MS));
                        }
                    }
                }
            }

            if (!address) {
                // H-8 (audit 2026-05-11): if the device IS hardware-capable
                // but lazy init didn't yield an address after retries, AND
                // this would be the very first PE on the device, refuse to
                // record a software-tier PE. Otherwise the PE rate limiter
                // permanently anchors the first wallet_created PE at
                // software-tier even though the device could have done
                // hardware. Throw HardwareKeyNotReadyError so the caller
                // can surface a "Setting up secure storage..." retry UX
                // rather than silently degrading.
                let isHardwareCapable = false;
                try {
                    const probe = await KeyManager.performDeviceAttestation();
                    isHardwareCapable = probe.isHardwareBacked;
                } catch {
                    // Probe failure: fall through to wallet-store fallback below.
                }
                const existingHistory = await this.getHistory();
                const isFirstPE = existingHistory.length === 0;

                if (isHardwareCapable && isFirstPE) {
                    throw new HardwareKeyNotReadyError(
                        'Hardware PE key is not ready on this hardware-capable device. ' +
                        'Refusing to record the first PE at software tier (would lock in permanently). ' +
                        'Retry shortly - the Secure Enclave / StrongBox usually becomes available within a few seconds of cold start.',
                    );
                }

                try {
                    const { useWalletStore } = await import('../../store/walletStore');
                    const storeAddress = useWalletStore.getState().address;
                    if (storeAddress) {
                        console.warn('[PE] Falling back to wallet store address (PE will be software-tier)');
                        address = storeAddress;
                    }
                } catch (fallbackErr) {
                    console.error('[PE] Wallet store address fallback failed:', fallbackErr);
                }
            }
            if (!address) throw new Error('No wallet initialized');

            const attestation = await KeyManager.performDeviceAttestation();
            // In development, allow software-backed keys; in production, require hardware
            const isValid = attestation.isHardwareBacked || attestation.securityLevel === 'software';
            if (!isValid) {
                throw new Error('Device attestation failed during PE creation');
            }

            const prevHash = await this.computePrevHash();

            const envelope: ProvenanceEnvelope = {
                envelope_id: uuidv4(),
                prev_envelope_hash: prevHash,
                timestamp: Date.now(),
                actor_address: address,
                chain_id: params.chainId,
                action_type: params.actionType,
                intent_text: params.intentText,
                asset_symbol: params.assetSymbol,
                amount: params.amount,
                counterparty_address: params.counterparty,
                contract_address: params.contract,
                agent_id: params.agentId,
                agent_action_type: params.agentActionType,
                authorization_decision: params.authorizationDecision,
                authorization_reason_codes: params.authorizationReasonCodes,
                authorization_human_required: params.authorizationHumanRequired,
                authorization_human_decision: params.authorizationHumanDecision,
                authorization_stage: params.authorizationStage,
                authorization_request_id: params.authorizationRequestId,
                authorization_budget_id: params.authorizationBudgetId,
                authorization_intent_id: params.authorizationIntentId,
                authorization_merchant: params.authorizationMerchant,
                authorization_purpose: params.authorizationPurpose,
                risk_score: params.riskScore,
                risk_category: params.riskCategory,
                policy_decision: params.policyDecision,
                device_attestation_id: attestation.deviceId,
                // Record the REAL attestation depth so submission doesn't over-claim
                // 'hardware' for a software-backed key that nonetheless has a deviceId.
                device_attestation_depth: attestation.isHardwareBacked ? 'hardware' : 'software',
                origin_binding: params.originBinding,
                agreement_details: params.agreementDetails,
                // Promise Negotiation fields
                negotiation_thread_id: params.negotiationThreadId,
                negotiation_offer_id: params.negotiationOfferId,
                negotiation_terms: params.negotiationTerms,
                negotiation_counter_of: params.negotiationCounterOf,
                // Non-Financial Action Metadata
                communication_metadata: params.communicationMetadata,
                commitment_metadata: params.commitmentMetadata,
                data_sharing_metadata: params.dataSharingMetadata,
                // Promise Completion Premium
                promise_completion_premium: params.promiseCompletionPremium || false,
                promise_id: params.promiseId,
                // Goal Envelope (Policy Sandbox)
                goal_envelope_metadata: params.goalEnvelopeMetadata,
                // Corroboration Signal
                corroboration_metadata: params.corroborationMetadata,
                // Human approval reference (§2.10) — absent on every other type.
                approval_metadata: params.approvalMetadata,
                // AI Conversation metadata (Phase 2c mobile wrapper capture)
                ai_conversation_metadata: params.aiConversationMetadata,
                subscription_state_snapshot: 'active',
                null_state_flags: []
            };

            // Prompt 1: attach input_origins ONLY when the caller observed some
            // (present-empty [] or populated). Absent (normalize → null) leaves
            // the key off the envelope entirely, so its whole-object hash is
            // byte-identical to a pre-change PE — forward-only, no chain churn.
            // Signed outputs this phone RECEIVED ride this PE as `out:` citations,
            // witnessed by this device. An empty queue returns the caller's origins unchanged.
            const normalizedInputOrigins = normalizeInputOrigins(
                withQueuedOutputCitations(
                    params.inputOrigins,
                    attestation.deviceId
                        ? { type: 'observer_device', identity: attestation.deviceId, attestation_tier: attestation.isHardwareBacked ? 'hardware' : 'software' }
                        : null,
                ),
            );
            if (normalizedInputOrigins !== null) {
                envelope.input_origins = normalizedInputOrigins;
            }
            // attach the confirmed transaction hash ONLY when present, so
            // every other envelope hashes byte-identically to a pre-change one.
            if (typeof params.txHash === 'string' && isEvmTxHash(params.txHash)) {
                envelope.tx_hash = params.txHash.toLowerCase();
            }

            const envelopeString = stableStringify(envelope) || '';
            const signature = await KeyManager.signPayload(envelopeString, biometricAction);

            envelope.signature = signature;

            // 1. Write to WAL (Crash Resilience)
            await this.addToWAL(envelope);

            // 2. Add to Memory Queue
            this.pendingQueue.push(envelope);

            if (this.pendingQueue.length >= this.BATCH_SIZE) {
                // SECURITY FIX: F-4 - Call flushQueueInternal directly since we already hold the mutex
                await this.flushQueueInternal(biometricAction);
            } else if (!this.flushTimer) {
                // Timer callback uses flushQueue which will acquire the mutex
                this.flushTimer = setTimeout(() => this.flushQueue(), this.FLUSH_INTERVAL);
            }

            // Energy Impact - non-blocking, never fails PE creation
            try {
                envelope.energy_estimate = estimateFromPE(envelope);
                await ingestPE(envelope);
            } catch (err) {
                console.warn('[Footprint] PE ingestion failed (non-blocking):', err);
            }

            return envelope;
        });
    }

    /**
     * SECURITY FIX: F-4 - flushQueue must also use the mutex to prevent race conditions
     */
    private async flushQueue(): Promise<void> {
        await this.mutex.runExclusive(async () => {
            await this.flushQueueInternal();
        });
    }

    /**
     * Internal flush implementation (called within mutex lock)
     */
    private async flushQueueInternal(biometricAction?: BiometricAction): Promise<void> {
        if (this.pendingQueue.length === 0) return;

        const batch = [...this.pendingQueue];
        this.pendingQueue = [];
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        // [Audit #40] Number of PEs from `batch` that have been DURABLY written.
        // On a mid-batch failure we re-queue ONLY the un-written tail
        // (batch.slice(writtenCount)); re-queuing the WHOLE batch physically
        // duplicated the already-written head on the next flush. addPEToHotTier is
        // also idempotent by envelope_id, so a re-queued-but-actually-written PE is
        // a no-op there — belt and suspenders.
        let writtenCount = 0;

        try {
            // Check if we should use tiered storage (post-migration)
            const migrationComplete = await AsyncStorage.getItem('provian_pe_migration_complete');

            if (migrationComplete === 'true') {
                // Use tiered storage (lifecycle manager). Count each PE only once
                // it has actually been persisted so a throw for PE #k re-queues
                // exactly [k..end], not the whole batch.
                for (const pe of batch) {
                    await PELifecycleManager.addPEToHotTier(pe, biometricAction);
                    writtenCount++;
                }
                console.log(`Flushed ${batch.length} envelopes to tiered storage`);
            } else {
                // Legacy path: write to monolithic storage. [Group 9 / chunk-i]
                // HMAC-protected so a filesystem-access attacker cannot edit
                // the chain mirror behind the cryptographic verifier's back.
                const history = await this.getHistory();
                const newHistory = [...history, ...batch];
                await setItemHmac(this.STORAGE_KEY, newHistory);
                // The legacy write is atomic (a single setItemHmac): either the
                // whole batch landed or none did.
                writtenCount = batch.length;
                console.log(`Flushed ${batch.length} envelopes to legacy storage`);
            }

            // Clear WAL after successful write
            await this.clearWAL();

            // Update Chain Head. [Group 9 / chunk-i] HMAC-protected.
            const lastEnvelope = batch[batch.length - 1];
            const newHash = await this.hashEnvelope(lastEnvelope);
            await setItemHmac(CHAIN_HEAD_KEY, newHash);

            // PE METER: the records are durable — hand them to the meter, which builds each one's
            // PE v2 at the head of this device's chain and sends it in the next daily batch.
            // Non-blocking and serial inside the meter; a record the meter misses (the app stopped
            // in between) is caught up from the hot tier at its next start.
            if (this.meterRecorder) {
                const recorder = this.meterRecorder;
                void recorder([...batch]).catch((err: unknown) => {
                    securityLog.warn(
                        'ProvenanceEnvelopeManager',
                        `PE meter could not record ${batch.length} envelope(s) yet (caught up at next start): ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    );
                });
            }

        } catch (error) {
            console.error('Failed to flush PE queue:', error);
            // [Audit #40] Re-queue ONLY the PEs that were not durably written,
            // preserving order. Everything in [0, writtenCount) is already
            // persisted; re-queuing it would duplicate on the next flush. If the
            // failure happened AFTER all writes (clearWAL / chain-head update),
            // writtenCount === batch.length so nothing is re-queued — the WAL
            // recovery (deduped by envelope_id) covers those.
            const unwritten = batch.slice(writtenCount);
            if (unwritten.length > 0) {
                this.pendingQueue.unshift(...unwritten);
            }
        }
    }

    // --- Deferred PE creation (N3) ---
    //
    // createEnvelope can throw BEFORE the envelope is durably written to the WAL
    // (address resolution, device attestation, or signing failure). When it
    // throws AFTER the underlying on-chain action already confirmed (send / swap /
    // WalletConnect tx), the caller must NOT silently skip the PE — the confirmed
    // action would then have no provenance record and no retry. Callers instead
    // persist the create params here and surface a "degraded / record pending"
    // state; retryDeferredEnvelopes re-attempts creation on the next foreground.

    /**
     * Durably queue a PE-creation request whose createEnvelope threw after its
     * underlying action already succeeded. Best-effort; never throws.
     */
    async enqueueDeferredEnvelope(params: EnvelopeContext): Promise<void> {
        try {
            const raw = await AsyncStorage.getItem(PE_DEFERRED_CREATE_KEY);
            const queue: EnvelopeContext[] = raw ? JSON.parse(raw) : [];
            // Bound the queue; drop the oldest if we somehow accumulate a backlog.
            if (queue.length >= PE_DEFERRED_CREATE_CAP) queue.shift();
            queue.push(params);
            await AsyncStorage.setItem(PE_DEFERRED_CREATE_KEY, JSON.stringify(queue));
            console.warn(`[PE] Deferred PE creation queued (${queue.length} pending) - will retry on foreground`);
        } catch (err) {
            console.warn('[PE] Failed to queue deferred envelope:', err);
        }
    }

    /**
     * Re-attempt any deferred PE creations. Each success drains its entry; a
     * still-failing entry (and everything after it) is kept for the next attempt
     * so nothing is lost. Returns the number of PEs created this pass.
     */
    async retryDeferredEnvelopes(biometricAction?: BiometricAction): Promise<number> {
        // [Audit N3 follow-up] Re-entrancy guard: an overlapping run would read the
        // same queue and re-create the same deferred entry with a new envelope_id
        // (no content dedup), duplicating a confirmed action's PE. Set/reset is
        // synchronous around the whole body, so a concurrent caller no-ops.
        if (this.deferredRetryInFlight) return 0;
        this.deferredRetryInFlight = true;
        try {
            let raw: string | null;
            try {
                raw = await AsyncStorage.getItem(PE_DEFERRED_CREATE_KEY);
            } catch {
                return 0;
            }
            if (!raw) return 0;
            let queue: EnvelopeContext[];
            try {
                queue = JSON.parse(raw);
            } catch {
                await AsyncStorage.removeItem(PE_DEFERRED_CREATE_KEY).catch(() => {});
                return 0;
            }
            if (queue.length === 0) return 0;

            let created = 0;
            for (let i = 0; i < queue.length; i++) {
                try {
                    await this.createEnvelope(queue[i], biometricAction);
                    created++;
                    // Incrementally persist the un-created TAIL after each success
                    // so a crash mid-loop re-creates at most the single in-flight
                    // entry, not the whole queue (bounds duplicate provenance
                    // records to ≤1 per crash instead of the entire backlog).
                    await AsyncStorage.setItem(PE_DEFERRED_CREATE_KEY, JSON.stringify(queue.slice(i + 1)))
                        .catch((persistErr) => console.warn('[PE] Failed to persist deferred tail mid-drain:', persistErr));
                } catch (err) {
                    // Still can't create (e.g. hardware key still unavailable).
                    // Persist this AND every remaining entry (order preserved), stop.
                    console.warn('[PE] Deferred envelope still failing, will retry later:', err);
                    await AsyncStorage.setItem(PE_DEFERRED_CREATE_KEY, JSON.stringify(queue.slice(i)))
                        .catch((persistErr) => console.warn('[PE] Failed to persist deferred queue after failure:', persistErr));
                    if (created > 0) {
                        console.log(`[PE] Recorded ${created} deferred PE(s), ${queue.length - i} remaining`);
                    }
                    return created;
                }
            }
            if (created > 0) {
                console.log(`[PE] Recorded ${created} deferred PE(s), 0 remaining`);
            }
            return created;
        } finally {
            this.deferredRetryInFlight = false;
        }
    }

    // --- Crash Resilience (WAL) ---

    private readonly WAL_KEY = 'provian_pe_wal';

    private async addToWAL(envelope: ProvenanceEnvelope): Promise<void> {
        try {
            const currentWal = await this.getWAL();
            currentWal.push(envelope);
            await AsyncStorage.setItem(this.WAL_KEY, JSON.stringify(currentWal));
        } catch (e) {
            console.error('WAL Write Failed', e);
        }
    }

    private async getWAL(): Promise<ProvenanceEnvelope[]> {
        try {
            const stored = await AsyncStorage.getItem(this.WAL_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch {
            return [];
        }
    }

    private async clearWAL(): Promise<void> {
        await AsyncStorage.removeItem(this.WAL_KEY);
    }

    // SECURITY FIX: M-21 - Deduplicate WAL recovery PEs against existing history.
    // Prevents duplicate PEs if the app crashed after writing to WAL but before clearing it.
    private async recoverFromCrash(): Promise<void> {
        const walItems = await this.getWAL();
        if (walItems.length > 0) {
            console.log(`Recovering ${walItems.length} envelopes from crash WAL`);

            // Deduplicate: only re-queue WAL items whose envelope_id doesn't already exist in history
            const history = await this.getHistoryRaw();
            const existingIds = new Set(history.map(pe => pe.envelope_id));
            const deduped = walItems.filter(pe => !existingIds.has(pe.envelope_id));

            if (deduped.length < walItems.length) {
                console.log(`[ProvenanceEnvelopeManager] Filtered ${walItems.length - deduped.length} duplicate WAL entries`);
            }

            if (deduped.length > 0) {
                this.pendingQueue.push(...deduped);
                await this.flushQueue();
            } else {
                // All WAL items were duplicates, clear the WAL
                await this.clearWAL();
            }
        }
    }

    // Call this in constructor or init
    async initialize(biometricAction?: BiometricAction): Promise<void> {
        await this.recoverFromCrash();

        // Initialize PE Lifecycle Manager (handles tiered storage)
        console.log('[ProvenanceEnvelopeManager] Initializing lifecycle manager...');
        await PELifecycleManager.initialize(biometricAction);

        // SECURITY FIX 9.1: Verify chain integrity on startup
        console.log('[ProvenanceEnvelopeManager] Verifying chain integrity on startup...');
        const chainResult = await this.verifyChainIntegrity();
        if (chainResult.valid) {
            console.log(`[ProvenanceEnvelopeManager] Chain verified: ${chainResult.envelopesVerified} envelopes OK`);
        } else {
            console.error('[ProvenanceEnvelopeManager] CHAIN INTEGRITY FAILURE ON STARTUP:', chainResult);
            if (tamperingAlertCallback) {
                tamperingAlertCallback(chainResult);
            }
        }

        // SECURITY FIX: F-1 - Verify PE signatures on startup
        console.log('[ProvenanceEnvelopeManager] Verifying PE signatures on startup...');
        const history = await this.getHistoryRaw();
        if (history.length > 0) {
            const sigResult = await this.verifyAllPESignatures(history);
            if (sigResult.unverifiableIds.length > 0) {
                console.warn(
                    `[ProvenanceEnvelopeManager] ${sigResult.unverifiableIds.length} PEs unverifiable (P-256 key missing after reinstall) - not tampering`
                );
            }
            if (sigResult.tamperedIds.length > 0 || sigResult.missingSignatureIds.length > 0) {
                console.error(
                    `[ProvenanceEnvelopeManager] SIGNATURE VERIFICATION FAILURE ON STARTUP:`,
                    `${sigResult.tamperedIds.length} tampered, ${sigResult.missingSignatureIds.length} missing`
                );
                if (tamperingAlertCallback) {
                    tamperingAlertCallback({
                        valid: false,
                        envelopesVerified: history.length,
                        error: `PE signature tampering: tampered=${sigResult.tamperedIds.length}, missing=${sigResult.missingSignatureIds.length}`,
                    });
                }
            } else {
                console.log(`[ProvenanceEnvelopeManager] Signatures verified: ${sigResult.validCount} envelopes OK, ${sigResult.unverifiableIds.length} unverifiable (key missing)`);
            }
        }

        // Start periodic verification
        this.startPeriodicVerification();
    }

    private async saveEnvelopeToHistory(pe: ProvenanceEnvelope) {
        // [Group 9 / chunk-i] HMAC-protected with legacy fallback.
        const history = (await getItemHmacWithLegacyFallback<ProvenanceEnvelope[]>('provian_pe_history')) ?? [];
        history.unshift(pe);
        await setItemHmac('provian_pe_history', history);
    }

    /**
     * SECURITY FIX: F-1 - Verify a single PE's signature.
     * Returns true if valid, false if invalid/missing.
     */
    async verifyPESignature(pe: ProvenanceEnvelope): Promise<{
        isValid: boolean;
        error?: string;
        recoveredAddress?: string | null;
    }> {
        // Check for missing signature
        if (!pe.signature) {
            return { isValid: false, error: 'Missing signature' };
        }

        // Reconstruct the payload that was signed (envelope without signature)
        const { signature, ...envelopeWithoutSignature } = pe;
        const payload = stableStringify(envelopeWithoutSignature) || '';

        // Verify signature against the actor address (who should have signed it)
        const result = await KeyManager.verifySignature(payload, signature, pe.actor_address);

        return {
            isValid: result.isValid,
            error: result.error,
            recoveredAddress: result.recoveredAddress,
        };
    }

    /**
     * SECURITY FIX: F-1 - Verify all PE signatures in batch.
     * Returns list of tampered envelope IDs.
     */
    async verifyAllPESignatures(envelopes: ProvenanceEnvelope[]): Promise<{
        tamperedIds: string[];
        missingSignatureIds: string[];
        unverifiableIds: string[];
        validCount: number;
    }> {
        const tamperedIds: string[] = [];
        const missingSignatureIds: string[] = [];
        const unverifiableIds: string[] = [];
        let validCount = 0;

        for (const pe of envelopes) {
            if (!pe.signature) {
                missingSignatureIds.push(pe.envelope_id);
                continue;
            }

            const result = await this.verifyPESignature(pe);
            if (result.isValid) {
                validCount++;
            } else if (result.error && result.error.includes('No P-256 public key stored')) {
                // Key is gone (reinstall, device migration) -- not tampering.
                // PE content may be perfectly valid; we just can't verify locally.
                unverifiableIds.push(pe.envelope_id);
                console.warn(
                    `[ProvenanceEnvelopeManager] PE ${pe.envelope_id} unverifiable after reinstall (P-256 key missing)`
                );
            } else {
                tamperedIds.push(pe.envelope_id);
                console.warn(
                    `[ProvenanceEnvelopeManager] PE ${pe.envelope_id} signature invalid:`,
                    result.error
                );
            }
        }

        return { tamperedIds, missingSignatureIds, unverifiableIds, validCount };
    }

    /**
     * Get history WITHOUT verification (for internal use only).
     * SECURITY FIX 9.1: This bypasses integrity checks - use only internally.
     * SECURITY FIX: F-1 - Now verifies PE signatures and flags tampered envelopes.
     */
    /**
     * Canonical hash of a stored envelope by its id, or null if not retained
     * (e.g. archived out of the hot tier). Lets corroboration emitters supply
     * the real target_pe_hash instead of '' (which CorroborationManager rejects).
     */
    async getEnvelopeHashById(envelopeId: string): Promise<string | null> {
        const history = await this.getHistoryRaw();
        const env = history.find(e => e.envelope_id === envelopeId);
        return env ? this.hashEnvelope(env) : null;
    }

    async getHistoryRaw(): Promise<ProvenanceEnvelope[]> {
        // [Group 9 / chunk-i] HMAC-protected reads with legacy fallback.
        const legacyPEs = (await getItemHmacWithLegacyFallback<ProvenanceEnvelope[]>('provian_pe_history')) ?? [];

        // Also include PEs from tiered storage (hot tier)
        try {
            type TieredShape = { hotPEs?: ProvenanceEnvelope[] };
            const tiered = await getItemHmacWithLegacyFallback<TieredShape>('provian_pe_tiered');
            if (tiered && tiered.hotPEs && Array.isArray(tiered.hotPEs)) {
                // Merge and deduplicate by envelope_id
                const seen = new Set(legacyPEs.map(pe => pe.envelope_id));
                for (const pe of tiered.hotPEs) {
                    if (!seen.has(pe.envelope_id)) {
                        legacyPEs.push(pe);
                        seen.add(pe.envelope_id);
                    }
                }
            }
        } catch {
            // Tiered storage unavailable: return legacy only
        }

        return legacyPEs;
    }

    /**
     * Get history with chain and signature verification.
     * SECURITY FIX: F-2 - Verification is mandatory.
     * SECURITY FIX: F-1 - Also verifies PE signatures.
     * [M-16] The `verify` parameter is deprecated and ignored - verification always runs.
     */
    async getHistory(_verify?: boolean): Promise<ProvenanceEnvelope[]> {
        const verify = true; // [M-16] Always verify - parameter ignored
        const history = await this.getHistoryRaw();

        if (verify && history.length > 0) {
            // SECURITY FIX 9.1: Verify chain integrity
            const chainResult = await this.verifyChainIntegrity();
            if (!chainResult.valid) {
                console.error('[ProvenanceEnvelopeManager] CHAIN TAMPERING DETECTED:', chainResult);
                // Alert callback if registered
                if (tamperingAlertCallback) {
                    tamperingAlertCallback(chainResult);
                }
            }

            // SECURITY FIX: H-7 - Filter tampered PEs from returned history.
            // Tampered or unsigned PEs are excluded. Unverifiable PEs (key missing after reinstall) are KEPT.
            const sigResult = await this.verifyAllPESignatures(history);
            const tamperedSet = new Set([...sigResult.tamperedIds, ...sigResult.missingSignatureIds]);

            if (sigResult.unverifiableIds.length > 0) {
                console.warn(
                    `[ProvenanceEnvelopeManager] ${sigResult.unverifiableIds.length} PEs unverifiable after reinstall - keeping in history`
                );
            }

            if (tamperedSet.size > 0) {
                console.error(
                    `[ProvenanceEnvelopeManager] SIGNATURE VERIFICATION FAILED:`,
                    `${sigResult.tamperedIds.length} tampered, ${sigResult.missingSignatureIds.length} missing signatures - filtering out`
                );
                if (tamperingAlertCallback && sigResult.tamperedIds.length > 0) {
                    tamperingAlertCallback({
                        valid: false,
                        envelopesVerified: history.length,
                        error: `PE signature tampering detected: ${sigResult.tamperedIds.join(', ')}`,
                    });
                }
                return history.filter(pe => !tamperedSet.has(pe.envelope_id));
            }
        }

        return history;
    }

    /**
     * SECURITY FIX 9.1: Verify the integrity of the entire provenance chain.
     * Walks through all envelopes and verifies that each prev_envelope_hash
     * correctly references the hash of the previous envelope.
     */
    // SECURITY FIX: M-22 - Optimized chain verification with cached checkpoint.
    // Starts verification from the last known-good position instead of genesis.
    async verifyChainIntegrity(): Promise<ChainIntegrityResult> {
        try {
            const history = await this.getHistoryRaw();

            if (history.length === 0) {
                return { valid: true, envelopesVerified: 0 };
            }

            // Determine start index based on cache
            let startIndex = 0;
            if (this.lastVerifiedIndex >= 0 && this.lastVerifiedIndex < history.length) {
                // Verify the cached checkpoint is still valid (envelope at cached index hasn't changed)
                const cachedEnvelope = history[this.lastVerifiedIndex];
                if (cachedEnvelope.signature) {
                    const cachedHash = await this.hashEnvelope(cachedEnvelope);
                    if (cachedHash === this.lastVerifiedHash) {
                        // Cache valid - skip to next envelope after cached position
                        startIndex = this.lastVerifiedIndex + 1;
                    }
                }
            }

            // If starting from the beginning, the first RETAINED envelope must
            // link to the chain anchor: GENESIS for a fresh/never-archived
            // chain, or the warm-boundary hash once archival has shed the
            // oldest PEs. Requiring GENESIS unconditionally false-positived
            // "broken" after every archival sweep.
            if (startIndex === 0) {
                const expectedAnchor = await this.getChainAnchorHash();
                if (history[0].prev_envelope_hash !== expectedAnchor) {
                    return {
                        valid: false,
                        envelopesVerified: 0,
                        brokenAtIndex: 0,
                        brokenEnvelopeId: history[0].envelope_id,
                        expectedHash: expectedAnchor,
                        actualHash: history[0].prev_envelope_hash,
                        error: 'First retained envelope does not link to the chain anchor (genesis or warm boundary)',
                    };
                }
            }

            // Walk the chain and verify each link (from startIndex)
            for (let i = Math.max(startIndex, 1); i < history.length; i++) {
                const prevEnvelope = history[i - 1];
                const currentEnvelope = history[i];

                const expectedHash = await this.hashEnvelope(prevEnvelope);

                if (currentEnvelope.prev_envelope_hash !== expectedHash) {
                    // Invalidate cache on failure
                    this.lastVerifiedIndex = -1;
                    this.lastVerifiedHash = '';

                    const result: ChainIntegrityResult = {
                        valid: false,
                        envelopesVerified: i,
                        brokenAtIndex: i,
                        brokenEnvelopeId: currentEnvelope.envelope_id,
                        expectedHash,
                        actualHash: currentEnvelope.prev_envelope_hash,
                        error: `Chain broken at envelope ${i}: hash mismatch`,
                    };

                    lastVerificationResult = result;
                    return result;
                }
            }

            // Verify the stored chain head matches the last envelope.
            // [Group 9 / chunk-i] HMAC-protected with legacy fallback.
            const storedHead = await getItemHmacWithLegacyFallback<string>(CHAIN_HEAD_KEY, (raw) => raw);
            const lastEnvelope = history[history.length - 1];
            const lastHash = await this.hashEnvelope(lastEnvelope);

            if (storedHead && storedHead !== lastHash) {
                this.lastVerifiedIndex = -1;
                this.lastVerifiedHash = '';

                const result: ChainIntegrityResult = {
                    valid: false,
                    envelopesVerified: history.length,
                    error: 'Chain head mismatch: stored head does not match computed hash of last envelope',
                    expectedHash: lastHash,
                    actualHash: storedHead,
                };

                lastVerificationResult = result;
                return result;
            }

            // Update cache to last verified position
            this.lastVerifiedIndex = history.length - 1;
            this.lastVerifiedHash = lastHash;

            const result: ChainIntegrityResult = {
                valid: true,
                envelopesVerified: history.length,
            };

            lastVerificationResult = result;
            return result;
        } catch (error) {
            const result: ChainIntegrityResult = {
                valid: false,
                envelopesVerified: 0,
                error: `Verification error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };

            lastVerificationResult = result;
            return result;
        }
    }

    /**
     * SECURITY FIX 9.1: Register a callback to be notified when tampering is detected.
     */
    setTamperingAlertCallback(callback: TamperingAlertCallback | null): void {
        tamperingAlertCallback = callback;
    }

    /**
     * SECURITY FIX 9.1: Get the last verification result.
     */
    getLastVerificationResult(): ChainIntegrityResult | null {
        return lastVerificationResult;
    }

    /**
     * SECURITY FIX 9.1: Start periodic chain verification.
     * Runs verification every 5 minutes in the background.
     */
    startPeriodicVerification(): void {
        if (verificationTimer) {
            return; // Already running
        }

        console.log('[ProvenanceEnvelopeManager] Starting periodic chain verification');

        verificationTimer = setInterval(async () => {
            const result = await this.verifyChainIntegrity();
            if (!result.valid) {
                console.error('[ProvenanceEnvelopeManager] Periodic verification FAILED:', result);
                if (tamperingAlertCallback) {
                    tamperingAlertCallback(result);
                }
            }
        }, VERIFICATION_INTERVAL_MS);
    }

    /**
     * SECURITY FIX 9.1: Stop periodic chain verification.
     */
    stopPeriodicVerification(): void {
        if (verificationTimer) {
            clearInterval(verificationTimer);
            verificationTimer = null;
            console.log('[ProvenanceEnvelopeManager] Stopped periodic chain verification');
        }
    }

    isAgreementFeatureFree(): boolean {
        return true;
    }

    async getPromiseStatus(agreementId: string): Promise<PromiseStatus> {
        const history = await this.getHistory();

        // Find settlements
        const settlements = history.filter(pe =>
            pe.action_type === 'agreement_settled' &&
            (pe.agreement_details as AgreementSettlementDetails)?.agreementId === agreementId
        );

        const signers = new Set<string>();
        settlements.forEach(pe => {
            const details = pe.agreement_details as AgreementSettlementDetails;
            if (details?.settledBy) {
                signers.add(details.settledBy);
            }
        });

        if (signers.has('partyA') && signers.has('partyB')) {
            return 'KEPT';
        } else if (signers.size > 0) {
            return 'AWAITING_CONFIRMATION';
        } else {
            return 'OPEN';
        }
    }

    async getSettlementSigners(agreementId: string): Promise<{ partyA: boolean; partyB: boolean }> {
        const history = await this.getHistory();
        const settlements = history.filter(pe =>
            pe.action_type === 'agreement_settled' &&
            (pe.agreement_details as AgreementSettlementDetails)?.agreementId === agreementId
        );

        const result = { partyA: false, partyB: false };
        settlements.forEach(pe => {
            const details = pe.agreement_details as AgreementSettlementDetails;
            if (details?.settledBy === 'partyA') result.partyA = true;
            if (details?.settledBy === 'partyB') result.partyB = true;
        });
        return result;
    }

    async exportSettlementPayload(envelopeId: string): Promise<OfflineSettlementPayload> {
        const history = await this.getHistory();
        const envelope = history.find(pe => pe.envelope_id === envelopeId);

        if (!envelope || envelope.action_type !== 'agreement_settled') {
            throw new Error('Invalid settlement envelope');
        }

        const details = envelope.agreement_details as AgreementSettlementDetails;

        return {
            agreementId: details.agreementId,
            settledBy: details.settledBy,
            settledAt: details.settledAt,
            envelopeId: envelope.envelope_id,
            signature: envelope.signature || ''
        };
    }

    async getRecoveryDetails(recoveryId: string): Promise<RecoveryEnvelopeDetails | null> {
        const key = `provian_recovery_${recoveryId}`;
        const stored = await AsyncStorage.getItem(key);
        return stored ? JSON.parse(stored) : null;
    }

    async getRecoveryHistory(): Promise<RecoveryEnvelopeDetails[]> {
        const history = await this.getHistory();
        const recoveryEnvelopes = history.filter(
            pe => pe.action_type === 'recovery_complete' || pe.action_type === 'recovery_init'
        );

        const details: RecoveryEnvelopeDetails[] = [];
        if (recoveryEnvelopes.length > 0) {
            const allKeys = await AsyncStorage.getAllKeys();
            const recoveryKeys = allKeys.filter(k => k.startsWith('provian_recovery_'));
            for (const key of recoveryKeys) {
                const stored = await AsyncStorage.getItem(key);
                if (stored) {
                    details.push(JSON.parse(stored));
                }
            }
        }

        return details;
    }

    // SECURITY FIX: M-24 - Verify counterparty signatures on settlement import.
    // Prevents accepting forged settlement payloads from untrusted QR codes.
    async importSettlementPayload(payload: OfflineSettlementPayload, biometricAction?: BiometricAction): Promise<void> {
        // 1. Check if we already have this settlement
        const history = await this.getHistory();
        const exists = history.some(pe =>
            pe.action_type === 'agreement_settled' &&
            (pe.agreement_details as AgreementSettlementDetails)?.agreementId === payload.agreementId &&
            (pe.agreement_details as AgreementSettlementDetails)?.settledBy === payload.settledBy
        );

        if (exists) {
            console.log('Settlement already exists, skipping import');
            return;
        }

        // 2. Verify Agreement exists locally
        const agreement = history.find(pe => pe.envelope_id === payload.agreementId);
        if (!agreement) {
            throw new Error('Agreement not found locally');
        }

        // 3. Verify counterparty signature before accepting
        if (!payload.signature) {
            throw new Error('Settlement payload missing signature - cannot verify counterparty');
        }

        // Reconstruct the data that should have been signed by the counterparty
        const signedData = JSON.stringify({
            agreementId: payload.agreementId,
            settledBy: payload.settledBy,
            settledAt: payload.settledAt,
            envelopeId: payload.envelopeId,
        });

        // The counterparty address is the other party in the agreement
        const counterpartyAddress = agreement.counterparty_address;
        if (!counterpartyAddress) {
            throw new Error('Agreement has no counterparty address - cannot verify signature');
        }

        const sigResult = await KeyManager.verifySignature(signedData, payload.signature, counterpartyAddress);
        if (!sigResult.isValid) {
            throw new Error(`Counterparty signature verification failed: ${sigResult.error || 'invalid signature'}`);
        }

        // 4. Create Local Mirror of Settlement PE (signature verified)
        await this.createEnvelope({
            actionType: 'agreement_settled',
            intentText: `Promise Kept (Offline Confirmation by ${payload.settledBy})`,
            assetSymbol: 'PROMISE',
            amount: '0',
            chainId: 0,
            riskScore: 0,
            riskCategory: 'low',
            policyDecision: 'allow',
            agreementDetails: {
                agreementId: payload.agreementId,
                settledBy: payload.settledBy,
                settledAt: payload.settledAt,
            }
        }, biometricAction);
    }

    // =========================================================================
    // TIERED STORAGE ACCESS (PE LIFECYCLE)
    // =========================================================================

    /**
     * Get recent PEs from hot tier (fast, for activity display).
     */
    async getRecentPEs(): Promise<ProvenanceEnvelope[]> {
        return await PELifecycleManager.getHotTierPEs();
    }

    /**
     * Query PEs across all tiers with filtering.
     */
    async queryPEs(options: PEQueryOptions, biometricAction?: BiometricAction): Promise<PEQueryResult> {
        return await PELifecycleManager.queryPEs(options, biometricAction);
    }

    /**
     * Load archived PEs for a specific month.
     */
    async loadMonthArchive(monthKey: string, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope[]> {
        return await PELifecycleManager.loadMonthArchive(monthKey, biometricAction);
    }

    /**
     * Get storage summary for settings display.
     */
    async getStorageSummary(): Promise<{
        hotCount: number;
        hotSizeBytes: number;
        warmCount: number;
        coldHashCount: number;
        lastSyncAt: number;
    }> {
        return await PELifecycleManager.getStorageSummary();
    }

    /**
     * Verify cross-tier integrity.
     */
    async verifyCrossTierIntegrity(): Promise<import('./lifecycleTypes').CrossTierIntegrityResult> {
        return await PELifecycleManager.verifyCrossTierIntegrity();
    }

    /**
     * Trigger archival sweep manually.
     */
    async runArchivalSweep(biometricAction?: BiometricAction): Promise<import('./lifecycleTypes').ArchivalResult> {
        return await PELifecycleManager.runArchivalSweep(biometricAction);
    }

    /**
     * Hide a PE from the default activity view.
     * The PE remains in the hash chain and counts toward trust/PVT.
     * This is a display-only change - the PE itself is immutable.
     */
    async hidePE(envelopeId: string): Promise<boolean> {
        return await PELifecycleManager.setPEHidden(envelopeId, true);
    }

    /**
     * Unhide a previously hidden PE.
     */
    async unhidePE(envelopeId: string): Promise<boolean> {
        return await PELifecycleManager.setPEHidden(envelopeId, false);
    }
}

export default ProvenanceEnvelopeManager.getInstance();
