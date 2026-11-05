import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import CorroborationManager from '../provenance/CorroborationManager';
import { promiseRelayService } from './PromiseRelayService';
import { isDefinitiveRelayRefusal } from './relayRefusal';
// NativeKeychainSync removed - cloud sync replaced by CloudBackupV2
import { hasCloudBackup } from '../recovery/cloud/CloudBackupV2';
// C3: E2E-encrypted remote share link (terms encrypted under a fresh random key
// that travels only in the URL fragment — see PromiseShareCrypto).
import {
    encryptPromisePayload,
    decryptPromisePayload,
    buildPromiseShareUrls,
    type PromiseShareUrls,
} from './PromiseShareCrypto';
// real EIP-191 wallet signatures over the promise digest (replacing the
// device-local tamper tags), plus the seed-derived, recoverable E2E encryption of
// each party's terms copy for the relay.
import {
    computePromiseDigest,
    signHumanPromisePhase,
} from './promiseSigning';
import {
    encryptTermsToSelf,
    decryptTermsFromSelf,
    clearPromiseTermsKey,
    type PromiseTermsPayload,
} from './PromiseTermsVault';
import SeedManager from '../wallet/SeedManager';
import { translate } from '../../i18n/translate';

// ============================================================================
// PROMISE SIGNING : REAL EIP-191 WALLET SIGNATURES
// ============================================================================
// The device-local SHA-256 "tamper tags" (a per-device salt that could never be
// verified off the originating device) are GONE. A human promise's create /
// accept / counter / close-out are now signed with the wallet's secp256k1 key
// over the promise digest (EIP-191 `personal_sign`), so the relay — and the
// counterparty — can verify each signature recovers to the signing party's
// wallet. The signing surface lives in ./promiseSigning (shared message + digest
// format with the backend); terms are encrypted per-party via ./PromiseTermsVault.
//
// `clearPromiseCryptoCaches()` drops the cached terms-encryption key (call on
// lock / key rotation / emergency stop). There is no signing-key cache to clear —
// the wallet key is read per-signature through SeedManager's biometric gate.
// ============================================================================

/** Clear cached promise crypto material (the seed-derived terms key). */
export function clearPromiseCryptoCaches(): void {
    clearPromiseTermsKey();
}

export type PromiseStatus =
    | 'pending' | 'accepted' | 'fulfilled' | 'broken' | 'disputed' | 'expired'
    // Agent negotiation states
    | 'offered' | 'countered' | 'rejected';

export type PromiseDirection = 'i_owe' | 'owed_to_me';

export interface PromiseEvent {
    id: string;
    type:
        | 'created' | 'accepted' | 'fulfilled' | 'broken' | 'disputed' | 'comment'
        // Agent negotiation events
        | 'offered' | 'countered' | 'negotiation_accepted' | 'negotiation_rejected' | 'expired';
    timestamp: number;
    actor: string;
    actorType?: 'user' | 'agent';
    agentId?: string;
    signature?: string;
    comment?: string;
    provenanceEnvelopeId?: string;
}

export interface PromiseRecord {
    id: string;
    // Two-sided value exchange
    theyGave: string; // What the giver provided (value received)
    theyOwe: string; // What is owed in return (value promised)
    what?: string; // Legacy field - combined description (deprecated)
    who: string; // Counterparty name or address
    whoAddress?: string; // Blockchain address if available
    direction: PromiseDirection;
    dueDate?: number; // Optional due date timestamp
    status: PromiseStatus;
    createdAt: number;
    updatedAt: number;
    creatorAddress: string;
    creatorName?: string;
    events: PromiseEvent[];
    // Signatures
    creatorSignature?: string;
    counterpartySignature?: string;
    // the promise digest (sha256 of the shared terms) that every EIP-191
    // signature covers. Deterministic from the terms, so both parties compute the
    // same value; kept in sync with the relay's `digest` (it MOVES on a counter).
    // The close-out signature is over the CURRENT digest, so this must be present
    // and current on any relay-backed promise before it can be closed out.
    digest?: string;
    // Remote close-out (mutual fulfillment) state. Mirrors creator/counterparty
    // signatures but for the fulfillment phase: a close-out is only complete once
    // BOTH parties have attested. `closeoutInitiatedByMe` = I marked it met and am
    // waiting for the counterparty to agree; `closeoutInitiatedByCounterparty` =
    // the counterparty marked it met and is waiting for me to agree.
    closeoutInitiatedByMe?: boolean;
    closeoutInitiatedByCounterparty?: boolean;
    // True once we have POSITIVE evidence this promise has a relay doc (a confirmed
    // publish, or a reconcile/close-out READ that returned a doc). This is the
    // STATE that distinguishes a bilateral RELAY-backed promise from a purely-local
    // / in-person (QR) one, so close-out can pick local-fulfill vs deferred mutual
    // close-out by PROMISE STATE, not by current network reachability. It is NOT
    // set by a share-link import alone — a link can be created+shared before (or
    // without) the relay doc ever being published (offline create / publish
    // failure), so inferring it from import would strand an imported promise that
    // has no relay doc in `offline_pending` forever. See importPromiseFromShareLink.
    relayBacked?: boolean;
    /**
     * The other party proposed NEW terms (a counter) that this device has not received — their
     * terms copy on the relay is encrypted to them. Until the re-shared code or link brings the
     * terms, nothing here may be accepted or signed over the new digest (2026-10-17).
     */
    counterTermsPending?: boolean;
    /**
     * The relay's digest for that counter : the re-shared code or link is adopted only when
     * its terms hash to exactly this digest, so a link cannot substitute terms nobody signed.
     */
    counterDigestPending?: string;
    /**
     * The open counter-offer came from the OTHER party, so this device answers it: accept,
     * counter again, or decline (2026-10-17). Read from the relay — the party that has not
     * signed the current digest is the one who answers — and false right after this device's
     * own counter. See `counterAwaitsMyAnswer`.
     */
    counterFromCounterparty?: boolean;
    // I hold a local close-out tag (`fulfillmentSignatures.mine`) that has NOT yet
    // been confirmed on the relay (went offline mid-close-out). The reconcile /
    // foreground sync flush (flushPendingCloseout) publishes it once the relay is
    // reachable again, so a deferred close-out converges instead of deadlocking.
    pendingCloseoutPublish?: boolean;
    fulfillmentSignatures?: { mine?: string; counterparty?: string };
    // QR data
    qrData?: string;
    // Cloud sync
    syncedAt?: number;
}

export interface PromiseQRPayload {
    version: 2;
    type?: 'promise_creation'; // Default type for backwards compatibility
    promiseId: string;
    theyGave: string;
    theyOwe: string;
    who: string;
    creatorAddress: string;
    creatorName?: string;
    dueDate?: number;
    creatorSignature: string;
    timestamp: number;
}

export interface AcceptanceQRPayload {
    type: 'promise_acceptance';
    promiseId: string;
    acceptorSignature: string;
    acceptorName: string;
    acceptorAddress: string;
    acceptedAt: number;
}

const STORAGE_KEY = 'promises';
// NOTE : this device's copy of every promise lives in AsyncStorage under
// STORAGE_KEY. A promise that has been published (relayBacked) is ALSO held by the
// relay under human wallet auth (`/v1/human-promises/*`): its lifecycle state, the
// promise digest, both parties' EIP-191 signatures, and each party's terms as
// seed-derived E2E ciphertext the relay cannot read (PromiseTermsVault).
// restoreFromRelay rebuilds them on a recovered wallet. An offline / in-person
// promise that was never published stays on this device only. There is no
// iCloud / Google Drive promise sync (syncToUserCloud / restoreFromCloud are no-ops).

// ──────────────────────────────────────────────────────────────────────────────
// Chunk-K: Status Transition & Input Validation Guards
// ──────────────────────────────────────────────────────────────────────────────

/** Maximum byte length for free-text promise fields. AsyncStorage has a ~6MB
 *  global limit - one promise with 1MB of text would crowd out everything
 *  else. 500 chars is generous for "Tamales → 50 pesos" style IOUs. */
const MAX_FIELD_LENGTH = 500;

/** The Active and History tabs between them list every status a promise can hold. */
export const ACTIVE_LIST_STATUSES: ReadonlySet<PromiseStatus> = new Set<PromiseStatus>(['pending', 'offered', 'countered', 'accepted', 'disputed']);
export const HISTORY_LIST_STATUSES: ReadonlySet<PromiseStatus> = new Set<PromiseStatus>(['fulfilled', 'broken', 'expired', 'rejected']);

/** Valid status transitions. Any transition not in this map is rejected.
 *  The keys are the current status; the values are the set of allowed
 *  next statuses. Promise lifecycle: pending → accepted → fulfilled/broken.
 *  Disputes can only be filed on accepted promises. */
export const VALID_TRANSITIONS: Readonly<Record<PromiseStatus, ReadonlySet<PromiseStatus>>> = {
    pending:   new Set(['accepted', 'rejected', 'expired', 'countered', 'offered']),
    accepted:  new Set(['fulfilled', 'broken', 'disputed', 'expired']),
    offered:   new Set(['accepted', 'countered', 'rejected', 'expired']),
    countered: new Set(['accepted', 'countered', 'rejected', 'expired']),
    fulfilled: new Set(),             // terminal
    broken:    new Set(),             // terminal
    disputed:  new Set(['fulfilled', 'broken', 'expired']),  // can resolve after dispute
    expired:   new Set(),             // terminal
    rejected:  new Set(),             // terminal
};

function assertValidTransition(current: PromiseStatus, next: PromiseStatus): void {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed || !allowed.has(next)) {
        throw new Error(
            `Invalid promise transition: ${current} → ${next}. ` +
            `Allowed from "${current}": ${allowed ? [...allowed].join(', ') || 'none (terminal)' : 'unknown'}.`,
        );
    }
}

/**
 * A countered promise waits on THIS device when the counter came from the other party (or its
 * terms have not arrived yet, which only happens for the other party's counter). The party who
 * countered has signed the new terms and waits; the other party accepts, counters or declines.
 */
export function counterAwaitsMyAnswer(promise: Pick<PromiseRecord, 'status' | 'counterFromCounterparty' | 'counterTermsPending'>): boolean {
    return promise.status === 'countered'
        && (promise.counterFromCounterparty === true || promise.counterTermsPending === true);
}

/** True for a real finite number (rejects NaN, Infinity, strings, objects, null). */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a free-text promise field.
 *
 * Pass-3 #46: the previous implementation only checked `value.length`, which is
 * `undefined` on a non-string (object/number). `undefined > MAX` is `false`, so
 * a crafted QR / share-link whose `creatorName`/`who` is an object silently
 * bypassed the AsyncStorage-bloat guard and later rendered `[object Object]`.
 * The `typeof` check closes that hole — an assertion so callers narrow to string.
 */
function validateTextField(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be text (got ${typeof value}).`);
    }
    if (value.length > MAX_FIELD_LENGTH) {
        throw new Error(
            `${fieldName} is too long (${value.length} chars). Maximum is ${MAX_FIELD_LENGTH}.`,
        );
    }
}

/**
 * Upper bound on how long a single relay close-out write may block the close-out
 * flow. A Firestore `updateDoc` does NOT resolve while offline (it awaits the
 * server ack), so without this an offline close-out could hang the UI. On timeout
 * we treat the write as "not confirmed" and defer (offline_pending); the write is
 * still queued by Firestore and/or re-published by the sync flush.
 */
const CLOSEOUT_PUBLISH_TIMEOUT_MS = 8000;

/** Resolve `p`, or `onTimeout` after `ms` — whichever comes first. Never rejects;
 *  a rejected `p` also resolves to `onTimeout`. The timer is cleared on settle. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(onTimeout); }
        }, ms);
        const finish = (v: T) => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
        };
        p.then(finish, () => finish(onTimeout));
    });
}

class PromiseService {
    private static instance: PromiseService;
    private promises: Map<string, PromiseRecord> = new Map();
    private loaded: boolean = false;

    private constructor() {}

    static getInstance(): PromiseService {
        if (!PromiseService.instance) {
            PromiseService.instance = new PromiseService();
        }
        return PromiseService.instance;
    }

    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.loadFromStorage();
            this.loaded = true;
        }
    }

    async createPromise(params: {
        theyGave: string;
        theyOwe: string;
        who: string;
        whoAddress?: string;
        direction: PromiseDirection;
        dueDate?: number;
        creatorAddress: string;
        creatorName?: string;
        /**
         * WS6: pre-supplied id (so callers like NegotiationService use ONE
         * consistent id end-to-end instead of generating their own and then
         * overriding — which orphaned a duplicate 'pending' record).
         */
        id?: string;
        /**
         * WS6: skip the fire-and-forget relay publish (e.g. CreatePromiseScreen
         * defers so it can AWAIT publishCreatedPromise for the C11 race). The
         * promise is STILL signed — this only defers WHO calls the relay.
         */
        deferRelayPublish?: boolean;
        /**
         * skip wallet signing entirely. Used only by the AGENT negotiation
         * offer path, whose `creatorAddress` is an agent id (not a human EVM
         * wallet), so a human EIP-191 create signature is neither possible nor
         * meaningful. Implies no relay publish (there is no signature to publish).
         */
        skipSigning?: boolean;
    }, biometricAction?: BiometricAction): Promise<PromiseRecord> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.createPromise(params, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        // Chunk-K: Input validation - length limits on free-text fields
        // to prevent AsyncStorage bloat and potential DoS via QR relay.
        validateTextField(params.theyGave, 'theyGave');
        validateTextField(params.theyOwe, 'theyOwe');
        validateTextField(params.who, 'who');
        if (params.creatorName) validateTextField(params.creatorName, 'creatorName');

        const id = params.id ?? uuidv4();
        const timestamp = Date.now();

        // the digest binds the shared terms + creator + id. Deterministic,
        // so the acceptor recomputes the same value from the QR / share-link.
        const digest = await computePromiseDigest({
            promiseId: id,
            creatorAddress: params.creatorAddress,
            theyGave: params.theyGave,
            theyOwe: params.theyOwe,
            dueDate: params.dueDate ?? null,
            createdAt: timestamp,
        });

        // Real EIP-191 create signature over the digest. Skipped only for the
        // agent negotiation offer path (skipSigning). A human promise REQUIRES a
        // wallet signature, so a biometric-denied / no-wallet failure here
        // propagates to the caller.
        const signature = params.skipSigning
            ? undefined
            : await signHumanPromisePhase('create', id, digest, biometricAction);

        // Create initial event
        const createEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'created',
            timestamp,
            actor: params.creatorAddress,
            signature,
        };

        // Log to provenance envelope (optional - don't block promise creation if wallet not initialized)
        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_created',
                intentText: 'Promise created',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
            }, biometricAction);
            createEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped (wallet not initialized):', peError);
        }

        const promise: PromiseRecord = {
            id,
            theyGave: params.theyGave,
            theyOwe: params.theyOwe,
            what: `${params.theyGave} → ${params.theyOwe}`, // Legacy compatibility
            who: params.who,
            whoAddress: params.whoAddress,
            direction: params.direction,
            dueDate: params.dueDate,
            status: 'pending',
            createdAt: timestamp,
            updatedAt: timestamp,
            creatorAddress: params.creatorAddress,
            creatorName: params.creatorName,
            events: [createEvent],
            creatorSignature: signature,
            digest,
        };

        // QR / share-link carry the creator signature, so only build them once we
        // have one (the deferRelayPublish path builds its own later).
        if (signature) {
            promise.qrData = this.generateQRPayload(promise);
        }

        this.promises.set(id, promise);
        await this.saveToStorage();

        // Publish to the relay (non-blocking). Encrypt the creator's own terms copy
        // (seed-recoverable, relay-opaque) and publish create with the digest +
        // signature. A confirmed publish marks the promise relay-backed. Skipped for
        // the negotiation offer path (publishes under its own id later).
        if (!params.deferRelayPublish && signature) {
            const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(promise), biometricAction);
            promiseRelayService
                .publishPromiseCreated(id, digest, signature, termsCiphertext, biometricAction)
                .then((ok) => { if (ok) return this.markRelayBacked(id); })
                .catch((err) => {
                    console.log('[PromiseService] Relay publish skipped:', err?.message);
                });
        }

        return promise;
    }

    /**
     * Build this party's own terms payload for seed-derived self-encryption on the
     * relay. Each party stores THEIR OWN copy (their own `direction`); a
     * restored wallet re-derives the key and recovers the terms.
     */
    private buildTermsPayload(promise: PromiseRecord): PromiseTermsPayload {
        return {
            promiseId: promise.id,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            who: promise.who,
            whoAddress: promise.whoAddress,
            creatorAddress: promise.creatorAddress,
            creatorName: promise.creatorName,
            dueDate: promise.dueDate,
            direction: promise.direction,
            createdAt: promise.createdAt,
        };
    }

    /**
     * Build the canonical promise payload (the same shape carried by the QR code
     * AND the E2E-encrypted remote share link). Single source of truth so the
     * two transports never drift.
     */
    private buildQRPayloadObject(promise: PromiseRecord): PromiseQRPayload {
        return {
            version: 2,
            promiseId: promise.id,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            who: promise.who,
            creatorAddress: promise.creatorAddress,
            creatorName: promise.creatorName,
            dueDate: promise.dueDate,
            creatorSignature: promise.creatorSignature!,
            timestamp: promise.createdAt,
        };
    }

    private generateQRPayload(promise: PromiseRecord): string {
        return JSON.stringify(this.buildQRPayloadObject(promise));
    }

    /**
     * C3: build the E2E-encrypted REMOTE share link for a promise. The terms are
     * encrypted with a fresh random key; the ciphertext rides the query and the
     * key rides ONLY the URL fragment, so the relay/Firestore (and any server the
     * link passes through) never see the body or the key. The counterparty's app
     * decrypts in-memory on open (see importPromiseFromShareLink).
     */
    async buildShareLink(promise: PromiseRecord): Promise<PromiseShareUrls> {
        const payload = this.buildQRPayloadObject(promise);
        const share = await encryptPromisePayload(payload);
        return buildPromiseShareUrls(share);
    }

    /**
     * C11: publish the creator's relay doc and RETURN whether it landed, so the
     * UI can AWAIT it before presenting the online accept path. createPromise's
     * fire-and-forget publish (used when not deferred) can race a fast acceptor:
     * if the acceptor's updateDoc arrives before the creator's doc exists, both
     * online devices fall back to the offline QR. Awaiting this closes that race.
     */
    async publishCreatedPromise(promise: PromiseRecord, biometricAction?: BiometricAction): Promise<boolean> {
        if (!promise.creatorSignature) return false;
        try {
            const digest = promise.digest ?? await computePromiseDigest({
                promiseId: promise.id,
                creatorAddress: promise.creatorAddress,
                theyGave: promise.theyGave,
                theyOwe: promise.theyOwe,
                dueDate: promise.dueDate ?? null,
                createdAt: promise.createdAt,
            });
            const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(promise), biometricAction);
            const ok = await promiseRelayService.publishPromiseCreated(
                promise.id, digest, promise.creatorSignature, termsCiphertext, biometricAction
            );
            // A confirmed publish is positive evidence the relay doc now exists →
            // this is a relay-backed (bilateral) promise.
            if (ok) await this.markRelayBacked(promise.id);
            return ok;
        } catch (err) {
            console.log('[PromiseService] Relay publish (confirmed) skipped:', (err as Error)?.message);
            return false;
        }
    }

    /**
     * Record that a promise is RELAY-backed (its promise_sync doc exists). Called
     * from every path that gets positive relay evidence: a confirmed create/accept
     * publish, a successful close-out read, or any reconcile against a real remote
     * doc. Idempotent + persisted. Deliberately NOT called by share-link/QR import
     * (the doc may not exist yet — see relayBacked on PromiseRecord).
     */
    async markRelayBacked(promiseId: string): Promise<void> {
        const promise = this.promises.get(promiseId);
        if (!promise || promise.relayBacked) return;
        promise.relayBacked = true;
        await this.saveToStorage();
    }

    // Helper to get display text for a promise (e.g., "Tamales → 50 pesos")
    getPromiseDisplayText(promise: PromiseRecord): string {
        if (promise.theyGave && promise.theyOwe) {
            return `${promise.theyGave} → ${promise.theyOwe}`;
        }
        // Legacy fallback
        return promise.what || '';
    }

    async acceptPromise(promiseId: string, acceptorAddress: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.acceptPromise(promiseId, acceptorAddress, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Chunk-K: Enforce valid transition - only pending promises can be accepted.
        assertValidTransition(promise.status, 'accepted');

        const timestamp = Date.now();
        // Accept the CURRENT terms — sign the SAME digest the creator signed at
        // create (recomputed from the shared terms if not stored).
        const digest = promise.digest ?? await computePromiseDigest({
            promiseId,
            creatorAddress: promise.creatorAddress,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            dueDate: promise.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        const signature = await signHumanPromisePhase('accept', promiseId, digest, biometricAction);

        const acceptEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'accepted',
            timestamp,
            actor: acceptorAddress,
            signature,
        };

        // Log to provenance envelope (optional)
        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_accepted',
                intentText: 'Promise accepted',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
            }, biometricAction);
            acceptEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'accepted';
        promise.updatedAt = timestamp;
        promise.counterpartySignature = signature;
        promise.digest = digest;
        promise.events.push(acceptEvent);

        await this.saveToStorage();

        // Publish acceptance with this party's encrypted terms copy. A confirmed
        // publish marks the promise relay-backed, so a later OFFLINE close-out
        // defers to a mutual close instead of a unilateral local fulfill.
        try {
            const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(promise), biometricAction);
            const ok = await promiseRelayService.publishPromiseAccepted(promiseId, digest, signature, termsCiphertext, biometricAction);
            if (ok) await this.markRelayBacked(promiseId);
        } catch (err) {
            console.log('[PromiseService] Relay accept publish skipped:', (err as Error)?.message);
        }

        return promise;
    }

    /**
     * COUNTER : re-propose new terms on a still-open promise (pending /
     * offered / countered). The countering party edits the terms, which MOVES the
     * digest; they sign phase `counter` over the new digest and publish it with
     * their encrypted terms copy. The counterparty must then receive the new terms
     * out-of-band (a fresh share link) to recompute the digest and accept.
     *
     * The relay holds the agreement, and the other party learns of a counter only
     * from it, so nothing changes on this device unless the relay recorded the
     * counter : a counter it refused used to leave this phone showing
     * terms the other phone never saw. A counter's own terms must be on this device
     * before it can be answered with another one.
     *
     * Returns the updated local record, or null if the promise is unknown.
     */
    async counterPromise(promiseId: string, actorAddress: string, newTerms: {
        theyGave: string;
        theyOwe: string;
        dueDate?: number;
    }, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.counterPromise(promiseId, actorAddress, newTerms, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();
        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        validateTextField(newTerms.theyGave, 'theyGave');
        validateTextField(newTerms.theyOwe, 'theyOwe');
        assertValidTransition(promise.status, 'countered');
        if (promise.counterTermsPending) {
            throw new Error('The other party proposed new terms. Open their new link to see them before you answer.');
        }

        const timestamp = Date.now();
        // The digest binds the CREATOR + id + the NEW terms — creatorAddress and
        // createdAt are stable, so the counterparty recomputes the same new digest
        // from the re-shared payload.
        const newDigest = await computePromiseDigest({
            promiseId,
            creatorAddress: promise.creatorAddress,
            theyGave: newTerms.theyGave,
            theyOwe: newTerms.theyOwe,
            dueDate: newTerms.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        const signature = await signHumanPromisePhase('counter', promiseId, newDigest, biometricAction);

        const countered: PromiseRecord = {
            ...promise,
            theyGave: newTerms.theyGave,
            theyOwe: newTerms.theyOwe,
            what: `${newTerms.theyGave} → ${newTerms.theyOwe}`,
            dueDate: newTerms.dueDate,
        };
        const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(countered), biometricAction);
        const ok = await promiseRelayService.publishPromiseCountered(promiseId, newDigest, signature, termsCiphertext, biometricAction);
        if (!ok) throw new Error('The counter-offer did not reach the relay. Nothing changed; try again.');

        promise.theyGave = newTerms.theyGave;
        promise.theyOwe = newTerms.theyOwe;
        promise.what = `${newTerms.theyGave} → ${newTerms.theyOwe}`;
        promise.dueDate = newTerms.dueDate;
        promise.status = 'countered';
        promise.digest = newDigest;
        promise.updatedAt = timestamp;
        promise.counterFromCounterparty = false;
        promise.relayBacked = true;
        // The prior agreement signatures are now over stale terms.
        promise.counterpartySignature = undefined;
        if (actorAddress === promise.creatorAddress) {
            promise.creatorSignature = signature;
        }
        promise.events.push({
            id: uuidv4(),
            type: 'countered',
            timestamp,
            actor: actorAddress,
            signature,
        });
        // Rebuild the QR / share payload so a re-share carries the new terms.
        if (promise.creatorSignature) {
            promise.qrData = this.generateQRPayload(promise);
        }
        await this.saveToStorage();
        return promise;
    }

    /**
     * Accept the other party's counter-offer (2026-10-17): sign phase `accept` over
     * the counter's digest — recomputed here from the terms on this device, which
     * must be the counter's — and record it on the relay. The relay moves to
     * `accepted` only when both parties have signed that digest; this device follows
     * only once the relay has. Its push tells the other phone, whose reconcile moves
     * it to `accepted` on the same digest and terms.
     */
    async acceptCounterOffer(promiseId: string, myAddress: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.acceptCounterOffer(promiseId, myAddress, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();
        const promise = this.promises.get(promiseId);
        if (!promise) return null;
        if (!counterAwaitsMyAnswer(promise)) {
            throw new Error(`There is no counter-offer from the other party to accept (this promise is ${promise.status}).`);
        }
        if (promise.counterTermsPending) {
            throw new Error('The other party proposed new terms. Open their new link to see them before you accept.');
        }
        assertValidTransition(promise.status, 'accepted');

        const digest = await computePromiseDigest({
            promiseId,
            creatorAddress: promise.creatorAddress,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            dueDate: promise.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        if (promise.digest !== digest) {
            // Unknown = Block: never sign a digest other than the one the shown terms make.
            throw new Error('These terms do not match the counter-offer on record. Open their latest link.');
        }
        const signature = await signHumanPromisePhase('accept', promiseId, digest, biometricAction);
        const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(promise), biometricAction);
        const published = await promiseRelayService.tryPublishAcceptance(promiseId, digest, signature, termsCiphertext, biometricAction);
        if (published !== 'published') {
            throw new Error('The acceptance did not reach the relay. Nothing changed; try again.');
        }

        const timestamp = Date.now();
        const acceptEvent: PromiseEvent = { id: uuidv4(), type: 'accepted', timestamp, actor: myAddress, signature };
        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_accepted',
                intentText: 'Promise accepted',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
            }, biometricAction);
            acceptEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'accepted';
        promise.updatedAt = timestamp;
        promise.relayBacked = true;
        promise.counterFromCounterparty = false;
        // creatorSignature is the creator's, counterpartySignature the acceptor's.
        if (myAddress === promise.creatorAddress) promise.creatorSignature = signature;
        else promise.counterpartySignature = signature;
        promise.events.push(acceptEvent);
        await this.saveToStorage();
        return promise;
    }

    /**
     * Decline a counter-offer, or withdraw this device's own (2026-10-17). A
     * decline signs nothing; the relay records it (either party of a countered
     * promise may), and this device follows only once it has. Terminal.
     */
    async declineCounterOffer(promiseId: string, myAddress: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        await this.ensureLoaded();
        const promise = this.promises.get(promiseId);
        if (!promise) return null;
        if (promise.status !== 'countered') {
            throw new Error(`Only a countered promise is declined here (this promise is ${promise.status}).`);
        }
        assertValidTransition(promise.status, 'rejected');
        const ok = await promiseRelayService.publishPromiseRejected(promiseId, biometricAction);
        if (!ok) throw new Error('The decline did not reach the relay. Nothing changed; try again.');

        const timestamp = Date.now();
        promise.status = 'rejected';
        promise.updatedAt = timestamp;
        promise.relayBacked = true;
        promise.counterFromCounterparty = false;
        promise.counterTermsPending = false;
        delete promise.counterDigestPending;
        promise.events.push({ id: uuidv4(), type: 'negotiation_rejected', timestamp, actor: myAddress });
        await this.saveToStorage();
        return promise;
    }

    async fulfillPromise(promiseId: string, actorAddress: string, comment?: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.fulfillPromise(promiseId, actorAddress, comment, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Chunk-K: Only accepted or disputed promises can be fulfilled.
        assertValidTransition(promise.status, 'fulfilled');

        const timestamp = Date.now();
        // Real EIP-191 close-out signature over the promise digest. This is the
        // LOCAL / in-person fulfillment path (no relay round-trip); the signature
        // is a genuine wallet attestation recorded on the local event.
        const digest = promise.digest ?? await computePromiseDigest({
            promiseId,
            creatorAddress: promise.creatorAddress,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            dueDate: promise.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        const signature = await signHumanPromisePhase('closeout', promiseId, digest, biometricAction);

        const fulfillEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'fulfilled',
            timestamp,
            actor: actorAddress,
            signature,
            comment,
        };

        // Log to provenance envelope (optional)
        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_fulfilled',
                intentText: 'Promise fulfilled',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
                // Bilateral trust verification: both parties confirmed fulfillment
                promiseCompletionPremium: true,
                promiseId: promiseId,
                // F-A1-3: name the counterparty's EVM address so the backend
                // completion verifier can run the distinct-owner fence. Absent →
                // fail closed (mints 0), never a self-dealt promotion.
                counterparty: promise.whoAddress,
            }, biometricAction);
            fulfillEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'fulfilled';
        promise.updatedAt = timestamp;
        promise.events.push(fulfillEvent);

        await this.saveToStorage();

        // Corroboration: promise fulfillment confirms the original promise_created PE
        if (fulfillEvent.provenanceEnvelopeId) {
            // Find the creation PE to corroborate
            const creationEvent = promise.events.find(e => e.type === 'created');
            if (creationEvent?.provenanceEnvelopeId) {
                // WS6: supply the REAL target PE hash (it was hardcoded '' which
                // the local CorroborationManager rejects). NOTE: on the backend
                // client-submitted corroboration is MINT-NEUTRAL (2026-06-29
                // decision) — it records a reputation marker but never grants the
                // corroborated (1.1x) tier; and this same-user signal is also
                // rejected server-side as self-corroboration. The local
                // corroboration_signal PE still records in the chain.
                (async () => {
                    const targetPeHash = await ProvenanceEnvelopeManager.getEnvelopeHashById(creationEvent.provenanceEnvelopeId!);
                    if (!targetPeHash) return;
                    await CorroborationManager.emitCorroboration({
                        targetPeId: creationEvent.provenanceEnvelopeId!,
                        targetPeHash,
                        signalType: 'promise_fulfillment',
                        corroboratingParty: actorAddress,
                        evidence: JSON.stringify({ promiseId, fulfilledAt: timestamp, actor: actorAddress }),
                        evidenceRef: promiseId,
                    }, biometricAction);
                })().catch(() => { }); // fire-and-forget
            }
        }

        // fulfillPromise is the LOCAL / in-person fulfill: it marks THIS device's
        // copy met. It deliberately does NOT publish a single-sided 'fulfilled' to
        // the relay — a remote close-out requires BOTH parties to attest (see
        // closeOutPromise + the promise_sync rules), so a one-sided remote fulfill
        // would (correctly) be rejected. In-person fulfillment has no QR/relay
        // round-trip; each party marks their own copy.

        return promise;
    }

    /**
     * REMOTE close-out: the two parties are NOT co-located and settle the promise
     * over the internet. The local user attests fulfillment (a device-local tag),
     * publishes their `closeout` signature to Firestore, and:
     *
     *  - if the counterparty has NOT yet posted their close-out tag, the promise
     *    stays 'accepted' locally with `closeoutInitiatedByMe` set ("waiting for
     *    {who} to confirm"); the counterparty's agreement finalizes it.
     *  - if the counterparty HAS already posted (they initiated), this finalizes
     *    the close-out: status 'fulfilled', BOTH fulfillment signatures recorded.
     *
     * The local-fulfill vs mutual-close-out choice is gated by PROMISE STATE
     * (`relayBacked`), NOT by current network reachability:
     *
     *  - A relay-backed (bilateral) promise is NEVER unilaterally settled. If the
     *    relay can't be reached right now, the close-out tag is recorded locally
     *    and `pendingCloseoutPublish` is set so a later sync flush publishes it
     *    (mode `offline_pending`) — no settlement PE, no corroboration is emitted.
     *  - A purely-local / in-person (QR) promise that was NEVER relay-backed falls
     *    back to a local fulfill (mode `local_fulfilled`), preserving the in-person
     *    experience. (An offline relay couldn't host a mutual close-out anyway.)
     */
    async closeOutPromise(promiseId: string, actorAddress: string, comment?: string, biometricAction?: BiometricAction): Promise<{
        promise: PromiseRecord;
        mode: 'fulfilled' | 'awaiting_counterparty' | 'local_fulfilled' | 'offline_pending';
    } | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.closeOutPromise(promiseId, actorAddress, comment, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Only accepted/disputed promises can be closed out.
        assertValidTransition(promise.status, 'fulfilled');

        const timestamp = Date.now();

        // A live read tells us the authoritative digest and confirms relay backing
        // (an imported QR/share-link promise may have relayBacked unset until we
        // first see a real doc).
        const remote = await promiseRelayService.checkPromiseStatus(promiseId, biometricAction);
        if (remote && !promise.relayBacked) {
            promise.relayBacked = true;
        }

        // ── STATE-GATED branch: relay-backed (bilateral) vs purely-local ──────────
        // Decided by `relayBacked` (persisted promise state), NOT by reachability.
        if (!promise.relayBacked) {
            // Never relay-backed → genuine local / in-person promise → local fulfill.
            await this.fulfillPromise(promiseId, actorAddress, comment, biometricAction);
            const updated = this.promises.get(promiseId)!;
            return { promise: updated, mode: 'local_fulfilled' };
        }

        // Relay-backed → the close-out is a REAL EIP-191 signature over the CURRENT
        // agreed digest. We must NEVER unilaterally settle: the RELAY flips to
        // `fulfilled` only once BOTH parties' close-out signatures are present.
        const digest = remote?.digest ?? promise.digest;
        if (!digest) {
            // No agreed digest to sign (should not happen post-accept). Fail closed.
            return null;
        }
        const mySignature = await signHumanPromisePhase('closeout', promiseId, digest, biometricAction);
        promise.fulfillmentSignatures = {
            ...(promise.fulfillmentSignatures ?? {}),
            mine: mySignature,
        };

        if (!remote) {
            // Known relay-backed but the relay is unreadable right now → defer. No
            // settlement PE, no corroboration. The sync flush publishes my signature
            // (and the counterparty's confirmation finalizes it) on reconnect.
            promise.closeoutInitiatedByMe = true;
            promise.pendingCloseoutPublish = true;
            promise.updatedAt = timestamp;
            await this.saveToStorage();
            return { promise, mode: 'offline_pending' };
        }

        // Publish my close-out signature; the RELAY decides finalize vs await and
        // reports it in `mode`. Bounded so an offline write can't hang the flow —
        // on timeout we defer exactly like the unreachable case.
        const result = await withTimeout(
            promiseRelayService.publishCloseoutSignature(promiseId, mySignature, biometricAction),
            CLOSEOUT_PUBLISH_TIMEOUT_MS,
            { ok: false },
        );

        if (!result.ok) {
            if (isDefinitiveRelayRefusal(result.httpStatus)) {
                // The relay REFUSED this signature (a stale digest, a non-party, a terminal
                // promise): retrying the same bytes could never land, so it is not deferred
                // (until 2026-10-17 it was queued and re-sent on every sync, forever).
                throw new Error(result.error ? `The relay refused the close-out: ${result.error}` : `The relay refused the close-out (HTTP ${result.httpStatus})`);
            }
            if (result.httpStatus === 404) {
                // The relay no longer holds this promise (purged past its expiry): nothing bilateral
                // is possible any more. Record that, rather than waiting on a doc that is gone.
                await this.markExpiredByRelay(promise, timestamp);
                await this.saveToStorage();
                throw new Error('This promise expired on the relay before it was closed out.');
            }
            // Write not confirmed (offline / timeout / error). DEFER — do NOT
            // unilaterally settle a relay-backed promise. The flush retries.
            promise.closeoutInitiatedByMe = true;
            promise.pendingCloseoutPublish = true;
            promise.updatedAt = timestamp;
            await this.saveToStorage();
            return { promise, mode: 'offline_pending' };
        }

        promise.pendingCloseoutPublish = false;
        promise.updatedAt = timestamp;

        if (result.mode === 'fulfilled') {
            // Relay confirmed BOTH close-out signatures → settle locally (mirrors
            // fulfillPromise's local effects: status, event, PE, corroboration).
            // Record the counterparty's close-out signature from the pre-publish
            // read (it was already present — that is why the relay finalized).
            const myUid = promiseRelayService.getUid();
            const cpUid = myUid ? Object.keys(remote.closeout).find((u) => u !== myUid) : undefined;
            if (cpUid) {
                promise.fulfillmentSignatures = {
                    ...(promise.fulfillmentSignatures ?? {}),
                    counterparty: remote.closeout[cpUid]?.signature,
                };
            }
            await this.finalizeLocalFulfillment(promise, actorAddress, comment, biometricAction);
            return { promise, mode: 'fulfilled' };
        }

        // Relay recorded my signature; awaiting the counterparty's close-out.
        promise.closeoutInitiatedByMe = true;
        await this.saveToStorage();
        return { promise, mode: 'awaiting_counterparty' };
    }

    /**
     * Apply the local effects of a completed fulfillment (status, event, PE,
     * corroboration) without re-publishing to the relay. Shared by the remote
     * close-out finalizer and the relay-sync reconciler.
     */
    private async finalizeLocalFulfillment(
        promise: PromiseRecord,
        actorAddress: string,
        comment?: string, biometricAction?: BiometricAction,
    ): Promise<void> {
        if (promise.status === 'fulfilled') return;
        // Defensive: only valid from accepted/disputed.
        try {
            assertValidTransition(promise.status, 'fulfilled');
        } catch {
            return;
        }

        const timestamp = Date.now();
        const fulfillEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'fulfilled',
            timestamp,
            actor: actorAddress,
            signature: promise.fulfillmentSignatures?.mine,
            comment,
        };

        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_fulfilled',
                intentText: 'Promise fulfilled',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
                promiseCompletionPremium: true,
                promiseId: promise.id,
                // F-A1-3: name the counterparty's EVM address so the backend
                // completion verifier can run the distinct-owner fence — the entire
                // anti-self-dealing guarantee for the promise earning path. Absent
                // (no whoAddress) → the verifier fails closed and the row mints 0.
                counterparty: promise.whoAddress,
            }, biometricAction);
            fulfillEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'fulfilled';
        promise.updatedAt = timestamp;
        promise.closeoutInitiatedByMe = false;
        promise.closeoutInitiatedByCounterparty = false;
        promise.events.push(fulfillEvent);

        // Corroboration: fulfillment confirms the original promise_created PE.
        if (fulfillEvent.provenanceEnvelopeId) {
            const creationEvent = promise.events.find(e => e.type === 'created');
            if (creationEvent?.provenanceEnvelopeId) {
                (async () => {
                    const targetPeHash = await ProvenanceEnvelopeManager.getEnvelopeHashById(creationEvent.provenanceEnvelopeId!);
                    if (!targetPeHash) return;
                    await CorroborationManager.emitCorroboration({
                        targetPeId: creationEvent.provenanceEnvelopeId!,
                        targetPeHash,
                        signalType: 'promise_fulfillment',
                        corroboratingParty: actorAddress,
                        evidence: JSON.stringify({ promiseId: promise.id, fulfilledAt: timestamp, actor: actorAddress }),
                        evidenceRef: promise.id,
                    }, biometricAction);
                })().catch(() => {});
            }
        }

        await this.saveToStorage();
    }

    async markBroken(promiseId: string, actorAddress: string, reason?: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Chunk-K: Only accepted or disputed promises can be marked broken.
        assertValidTransition(promise.status, 'broken');

        const timestamp = Date.now();

        const brokenEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'broken',
            timestamp,
            actor: actorAddress,
            comment: reason,
        };

        // Log to provenance envelope (optional)
        try {
            const pe = await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_broken',
                intentText: 'Promise marked broken',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 30,
                riskCategory: 'medium',
                policyDecision: 'allow',
            }, biometricAction);
            brokenEvent.provenanceEnvelopeId = pe.envelope_id;
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'broken';
        promise.updatedAt = timestamp;
        promise.events.push(brokenEvent);

        await this.saveToStorage();

        // Publish to the relay (non-blocking) so the counterparty's device learns it; until
        // 2026-10-17 only the local copy changed and the relay copy stayed `accepted`.
        if (promise.relayBacked) {
            promiseRelayService.publishPromiseBroken(promiseId, biometricAction).catch(err => {
                console.log('[PromiseService] Relay broken publish skipped:', err.message);
            });
        }
        return promise;
    }

    async disputePromise(promiseId: string, actorAddress: string, reason: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Chunk-K: Only accepted promises can be disputed.
        assertValidTransition(promise.status, 'disputed');

        const timestamp = Date.now();

        const disputeEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'disputed',
            timestamp,
            actor: actorAddress,
            comment: reason,
        };

        // Log to provenance envelope (optional)
        try {
            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'promise_disputed',
                intentText: 'Promise disputed',
                assetSymbol: 'PROMISE',
                amount: '1',
                chainId: 'local',
                riskScore: 20,
                riskCategory: 'low',
                policyDecision: 'allow',
            }, biometricAction);
        } catch (peError) {
            console.log('[PromiseService] Provenance envelope skipped:', peError);
        }

        promise.status = 'disputed';
        promise.updatedAt = timestamp;
        promise.events.push(disputeEvent);

        await this.saveToStorage();

        // Publish dispute to relay (non-blocking)
        promiseRelayService.publishPromiseDisputed(promiseId, biometricAction).catch(err => {
            console.log('[PromiseService] Relay dispute publish skipped:', err.message);
        });

        return promise;
    }

    async addComment(promiseId: string, actorAddress: string, comment: string): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        const commentEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'comment',
            timestamp: Date.now(),
            actor: actorAddress,
            comment,
        };

        promise.events.push(commentEvent);
        promise.updatedAt = Date.now();

        await this.saveToStorage();
        return promise;
    }

    async getPromise(id: string): Promise<PromiseRecord | null> {
        await this.ensureLoaded();
        return this.promises.get(id) || null;
    }

    async getAllPromises(): Promise<PromiseRecord[]> {
        await this.ensureLoaded();
        return Array.from(this.promises.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async getActivePromises(): Promise<PromiseRecord[]> {
        const all = await this.getAllPromises();
        // An open offer or counter is still in play (two-sim proof, 2026-10-17: a countered promise
        // was in neither list, so the person it waited on could not find it).
        return all.filter(p => ACTIVE_LIST_STATUSES.has(p.status));
    }

    async getCompletedPromises(): Promise<PromiseRecord[]> {
        const all = await this.getAllPromises();
        return all.filter(p => HISTORY_LIST_STATUSES.has(p.status));
    }

    async getPromisesByDirection(direction: PromiseDirection): Promise<PromiseRecord[]> {
        const all = await this.getAllPromises();
        return all.filter(p => p.direction === direction);
    }

    parseQRPayload(qrData: string): PromiseQRPayload | null {
        try {
            const parsed: unknown = JSON.parse(qrData);
            if (!parsed || typeof parsed !== 'object') return null;
            const payload = parsed as Record<string, unknown>;

            // Skip acceptance QRs - they're handled separately
            if (payload.type === 'promise_acceptance') {
                return null;
            }

            // Pass-3 #36: identity fields MUST be non-empty STRINGS. The previous
            // truthiness-only check (`payload.promiseId && payload.creatorAddress`)
            // passed a numeric/object creatorAddress, which then crashed the scan
            // preview render at `creatorAddress.slice(0, 12)` — a TypeError thrown
            // into the root ErrorBoundary (whole-app "Something went wrong").
            if (typeof payload.promiseId !== 'string' || payload.promiseId.length === 0) return null;
            if (typeof payload.creatorAddress !== 'string' || payload.creatorAddress.length === 0) return null;

            // Pass-3 #14: a present dueDate MUST be a finite number, or the preview /
            // list / detail render hits `format(new Date(bad))` which throws. (The
            // required `timestamp` is validated authoritatively at import time.)
            if (payload.dueDate !== undefined && !isFiniteNumber(payload.dueDate)) return null;

            // Accept version 2 (current) with string terms, or version 1 (legacy).
            if (payload.version === 2 && typeof payload.theyGave === 'string' && typeof payload.theyOwe === 'string') {
                return payload as unknown as PromiseQRPayload;
            }
            // Legacy v1 format with a combined 'what' string.
            if (typeof payload.what === 'string') {
                return payload as unknown as PromiseQRPayload;
            }
            return null;
        } catch {
            return null;
        }
    }

    parseAcceptanceQRPayload(qrData: string): AcceptanceQRPayload | null {
        try {
            const payload = JSON.parse(qrData);
            if (payload.type === 'promise_acceptance' && payload.promiseId && payload.acceptorSignature) {
                return payload as AcceptanceQRPayload;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Generate an acceptance QR payload for offline handoff.
     * Used when the acceptor is offline and can't publish to relay.
     */
    generateAcceptanceQRPayload(
        promiseId: string,
        acceptorSignature: string,
        acceptorName: string,
        acceptorAddress: string
    ): string {
        const payload: AcceptanceQRPayload = {
            type: 'promise_acceptance',
            promiseId,
            acceptorSignature,
            acceptorName,
            acceptorAddress,
            acceptedAt: Date.now(),
        };
        return JSON.stringify(payload);
    }

    /**
     * Import an acceptance from a QR code (creator scans acceptor's QR).
     * Updates local promise with acceptor signature and marks as accepted.
     */
    async importAcceptanceFromQR(acceptancePayload: AcceptanceQRPayload): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        const promise = this.promises.get(acceptancePayload.promiseId);
        if (!promise) {
            console.log('[PromiseService] Promise not found for acceptance:', acceptancePayload.promiseId);
            return null;
        }

        if (promise.status !== 'pending') {
            console.log('[PromiseService] Promise already accepted/completed:', promise.status);
            return promise;
        }

        const acceptEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'accepted',
            timestamp: acceptancePayload.acceptedAt,
            actor: acceptancePayload.acceptorAddress,
            signature: acceptancePayload.acceptorSignature,
        };

        promise.status = 'accepted';
        promise.updatedAt = Date.now();
        promise.counterpartySignature = acceptancePayload.acceptorSignature;
        promise.who = acceptancePayload.acceptorName || promise.who;
        promise.whoAddress = acceptancePayload.acceptorAddress;
        promise.events.push(acceptEvent);

        await this.saveToStorage();

        // this is the in-person two-QR flow — the CREATOR scans the
        // ACCEPTOR's acceptance QR. We do NOT publish to the relay here: the relay
        // authorizes an accept only by the ACCEPTOR's own wallet, so the creator
        // cannot publish on their behalf. The acceptor's device publishes its own
        // accept if it is online; the in-person path is otherwise fully offline and
        // stays a local (non-relay-backed) promise, which is exactly the unchanged
        // two-QR experience.

        return promise;
    }

    /**
     * Accept a promise locally and return the signature for QR generation.
     * Used for offline acceptance flow.
     */
    async acceptPromiseOffline(promiseId: string, acceptorAddress: string, acceptorName: string, biometricAction?: BiometricAction): Promise<{
        promise: PromiseRecord;
        signature: string;
    } | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.acceptPromiseOffline(promiseId, acceptorAddress, acceptorName, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;

        // Pass-3 #34: status/idempotency guard (its two siblings both have one —
        // acceptPromise's assertValidTransition and importAcceptanceFromQR's
        // `status !== 'pending'` check). Without it, an interrupted accept (the
        // local commit landed but the relay side-effect failed) followed by a
        // re-tap re-signs over a fresh acceptedAt and appends a SECOND 'accepted'
        // event. Return the already-committed record + its stored acceptor tag so
        // the caller's QR/relay flow stays idempotent WITHOUT double-signing.
        if (promise.status !== 'pending') {
            return { promise, signature: promise.counterpartySignature ?? '' };
        }

        const timestamp = Date.now();
        // Real EIP-191 accept signature over the SAME digest the creator signed.
        const digest = promise.digest ?? await computePromiseDigest({
            promiseId,
            creatorAddress: promise.creatorAddress,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            dueDate: promise.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        const signature = await signHumanPromisePhase('accept', promiseId, digest, biometricAction);

        const acceptEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'accepted',
            timestamp,
            actor: acceptorAddress,
            signature,
        };

        promise.status = 'accepted';
        promise.updatedAt = timestamp;
        promise.counterpartySignature = signature;
        promise.digest = digest;
        promise.events.push(acceptEvent);

        await this.saveToStorage();

        return { promise, signature };
    }

    /**
     * P4-06: accept a promise the user IMPORTED as the recipient (via the
     * E2E-encrypted share link or a scanned QR) directly from PromiseDetail —
     * closing the share-link "Open to accept" dead end, where the imported
     * `owed_to_me` pending promise previously offered only settlement actions
     * that threw Invalid transition.
     *
     * Mirrors the proven ScanPromiseScreen accept flow: mark accepted locally
     * (acceptPromiseOffline — idempotent + single-signing), then publish the
     * acceptance to the relay with a short retry, because on a fresh online
     * accept the creator's relay doc may not have replicated yet. A confirmed
     * publish is positive evidence the promise is relay-backed, so a later
     * OFFLINE close-out defers (mutual) instead of unilaterally settling.
     *
     *  - 'accepted_synced' : acceptance published — the creator's device will
     *    reconcile it, and the promise is now relay-backed.
     *  - 'accepted_local'  : accepted locally but the relay was unreachable or
     *    the creator's doc is not present yet; a later foreground sync flush
     *    (syncPendingPromises) re-publishes it. Still a valid local acceptance.
     *
     * Returns null only when the promise id is unknown.
     */
    async acceptImportedPromise(
        promiseId: string,
        acceptorAddress: string,
        acceptorName: string, biometricAction?: BiometricAction,
    ): Promise<{ promise: PromiseRecord; mode: 'accepted_synced' | 'accepted_local' } | null> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.confirmPromise', 'Confirm your promise'), action => this.acceptImportedPromise(promiseId, acceptorAddress, acceptorName, action));
        assertBiometricAction(biometricAction);

        await this.ensureLoaded();

        const current = this.promises.get(promiseId);
        if (current?.counterTermsPending) {
            throw new Error('The other party proposed new terms. Scan their updated code or open their new link to see the terms before accepting.');
        }
        // Only an open (pending) promise is accepted here; an accepted one re-publishes its stored
        // acceptance. Anything else — a promise countered, rejected or settled since the code was
        // made — is refused: accepting it published an EMPTY acceptance signature and reported
        // success (a re-scanned original code after a counter, R9 /).
        if (current && current.status !== 'pending'
            && !(current.status === 'accepted' && current.counterpartySignature)) {
            throw new Error(`This promise is ${current.status} now. Open it to see its current terms.`);
        }

        const result = await this.acceptPromiseOffline(promiseId, acceptorAddress, acceptorName, biometricAction);
        if (!result) return null;

        // The digest + this party's encrypted terms copy travel with the accept.
        const digest = result.promise.digest ?? await computePromiseDigest({
            promiseId,
            creatorAddress: result.promise.creatorAddress,
            theyGave: result.promise.theyGave,
            theyOwe: result.promise.theyOwe,
            dueDate: result.promise.dueDate ?? null,
            createdAt: result.promise.createdAt,
        });
        const termsCiphertext = await encryptTermsToSelf(this.buildTermsPayload(result.promise), biometricAction);

        // Publish the acceptance so the counterparty's device reconciles it.
        // Distinguish "creator doc not present yet" (retry with backoff) from a
        // hard offline failure — same handling ScanPromiseScreen uses (C11).
        let publishResult = await promiseRelayService.tryPublishAcceptance(promiseId, digest, result.signature, termsCiphertext, biometricAction);
        for (let attempt = 0;publishResult === 'not_found' && attempt < 4;attempt++) {
            await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
            publishResult = await promiseRelayService.tryPublishAcceptance(promiseId, digest, result.signature, termsCiphertext, biometricAction);
        }

        if (publishResult === 'published') {
            await this.markRelayBacked(promiseId);
            return { promise: result.promise, mode: 'accepted_synced' };
        }
        return { promise: result.promise, mode: 'accepted_local' };
    }

    /**
     * P4-06: decline an imported (recipient) pending promise. Marks it rejected
     * locally (a valid pending→rejected transition) and best-effort signals the
     * creator via the relay so their device leaves "awaiting acceptance" instead
     * of hanging on 'pending'. If the creator's relay doc doesn't exist yet the
     * publish no-ops, exactly as the ScanPromiseScreen reject path does.
     * Idempotent: returns the record unchanged if it already left 'pending'.
     * Returns null when the promise id is unknown.
     */
    async declineImportedPromise(promiseId: string, actorAddress: string, biometricAction?: BiometricAction): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        const promise = this.promises.get(promiseId);
        if (!promise) return null;
        if (promise.status !== 'pending') return promise;

        assertValidTransition(promise.status, 'rejected');

        const timestamp = Date.now();
        promise.status = 'rejected';
        promise.updatedAt = timestamp;
        promise.events.push({
            id: uuidv4(),
            type: 'negotiation_rejected',
            timestamp,
            actor: actorAddress,
        });

        await this.saveToStorage();

        promiseRelayService.publishPromiseRejected(promiseId, biometricAction).catch((err) => {
            console.log('[PromiseService] Relay reject publish skipped:', err?.message);
        });

        return promise;
    }

    async importPromiseFromQR(qrPayload: PromiseQRPayload, myAddress: string): Promise<PromiseRecord | null> {
        await this.ensureLoaded();

        // A promise already on this phone resolves to ITS record, in its current state — never a
        // second record, never a reset of its signature phases (R9,). The one thing a
        // re-shared code or link may bring is the terms of a counter the other party proposed
        // (this device knows the counter's digest from the relay, not its terms).
        const existing = this.promises.get(qrPayload.promiseId);
        if (existing) {
            await this.adoptCounterTermsFromCode(existing, qrPayload);
            return existing;
        }

        // Pass-3 #14: the numeric date fields MUST be finite numbers before we
        // persist. This is the single choke point BOTH transports pass through
        // (scanned QR via importPromiseFromQR, remote share-link via
        // importPromiseFromShareLink → here). A crafted payload carrying a
        // non-numeric `timestamp`/`dueDate` would persist and then crash
        // `format(new Date(bad))` on every render — an unrecoverable, whole-app
        // ErrorBoundary soft-lock. Unknown = Block: reject rather than import.
        if (!isFiniteNumber(qrPayload.timestamp)) {
            console.warn('[PromiseService] Rejecting import: non-numeric timestamp');
            return null;
        }
        if (qrPayload.dueDate !== undefined && !isFiniteNumber(qrPayload.dueDate)) {
            console.warn('[PromiseService] Rejecting import: non-numeric dueDate');
            return null;
        }

        // Chunk-K: Validate field lengths on QR import. A malicious QR
        // could embed megabytes of text in theyGave/theyOwe/who to bloat
        // AsyncStorage and slow the app.
        validateTextField(qrPayload.theyGave || '', 'theyGave');
        validateTextField(qrPayload.theyOwe || '', 'theyOwe');
        validateTextField(qrPayload.who || '', 'who');
        if (qrPayload.creatorName) {
            validateTextField(qrPayload.creatorName, 'creatorName');
        }

        // Create the promise from QR data (as the counterparty)
        const timestamp = Date.now();

        const createEvent: PromiseEvent = {
            id: uuidv4(),
            type: 'created',
            timestamp: qrPayload.timestamp,
            actor: qrPayload.creatorAddress,
            signature: qrPayload.creatorSignature,
        };

        // Handle both v2 (theyGave/theyOwe) and v1 (what) formats
        const theyGave = qrPayload.theyGave || '';
        const theyOwe = qrPayload.theyOwe || '';
        const legacyWhat = (qrPayload as any).what || `${theyGave} → ${theyOwe}`;

        // recompute the digest the creator signed from the shared terms, so
        // this party accepts / closes out over the SAME digest.
        const digest = await computePromiseDigest({
            promiseId: qrPayload.promiseId,
            creatorAddress: qrPayload.creatorAddress,
            theyGave,
            theyOwe,
            dueDate: qrPayload.dueDate ?? null,
            createdAt: qrPayload.timestamp,
        });

        const promise: PromiseRecord = {
            id: qrPayload.promiseId,
            theyGave,
            theyOwe,
            what: legacyWhat,
            who: qrPayload.creatorName || qrPayload.creatorAddress.slice(0, 10) + '...',
            whoAddress: qrPayload.creatorAddress,
            direction: 'owed_to_me', // If I'm scanning, they're making a promise TO me
            dueDate: qrPayload.dueDate,
            status: 'pending',
            createdAt: qrPayload.timestamp,
            updatedAt: timestamp,
            creatorAddress: qrPayload.creatorAddress,
            creatorName: qrPayload.creatorName,
            events: [createEvent],
            creatorSignature: qrPayload.creatorSignature,
            digest,
            qrData: JSON.stringify(qrPayload),
        };

        this.promises.set(promise.id, promise);
        await this.saveToStorage();

        return promise;
    }

    /**
     * The local record for a scanned / opened promise code, when this phone already holds that
     * promise (R9,): resolved to its current state (a counter's terms adopted, see below),
     * or null for a promise this phone has never seen. The scan screen opens an existing promise
     * instead of previewing the code's terms — which may be terms the promise has moved past.
     */
    async findExistingForImport(qrPayload: PromiseQRPayload): Promise<PromiseRecord | null> {
        await this.ensureLoaded();
        const existing = this.promises.get(qrPayload.promiseId);
        if (!existing) return null;
        await this.adoptCounterTermsFromCode(existing, qrPayload);
        return existing;
    }

    /**
     * A counter's link usually reaches this phone before its next relay poll does, so the record
     * does not yet know a counter exists and holds no digest to check the link's terms against.
     * A code whose terms differ from this record's asks the relay first, then adopts the terms
     * only if they make the counter's digest (two-sim proof, 2026-10-17: the link's terms were
     * dropped and the person saw "waiting for the terms" for a counter they had just opened).
     */
    private async adoptCounterTermsFromCode(promise: PromiseRecord, qrPayload: PromiseQRPayload): Promise<void> {
        if (!promise.counterTermsPending
            && (promise.status === 'pending' || promise.status === 'accepted' || promise.status === 'countered')
            && (qrPayload.theyGave !== promise.theyGave || qrPayload.theyOwe !== promise.theyOwe
                || (qrPayload.dueDate ?? null) !== (promise.dueDate ?? null))) {
            try {
                const lookup = await promiseRelayService.checkPromiseStatusDetailed(promise.id);
                if (lookup.kind === 'found' && await this.reconcileWithRemote(promise, lookup.doc)) {
                    await this.saveToStorage();
                }
            } catch (err) {
                console.log('[PromiseService] Relay read before adopting a code skipped:', (err as Error)?.message);
            }
        }
        await this.adoptPendingCounterTerms(promise, qrPayload);
    }

    /**
     * the other party countered and this device holds only the counter's digest (their
     * terms copy on the relay is encrypted to them). A re-shared code or link whose terms hash —
     * under this record's id, creator and creation time — to EXACTLY that digest carries the
     * counter's terms: adopt them so the person sees what was proposed. Anything else (the
     * original link, an older counter, a forged link) changes nothing. Status, events and every
     * signature stay as they are.
     */
    private async adoptPendingCounterTerms(promise: PromiseRecord, qrPayload: PromiseQRPayload): Promise<void> {
        if (!promise.counterTermsPending || !promise.counterDigestPending) return;
        if (qrPayload.creatorAddress !== promise.creatorAddress) return;
        if (qrPayload.dueDate !== undefined && !isFiniteNumber(qrPayload.dueDate)) return;
        const theyGave = qrPayload.theyGave || '';
        const theyOwe = qrPayload.theyOwe || '';
        validateTextField(theyGave, 'theyGave');
        validateTextField(theyOwe, 'theyOwe');
        const digest = await computePromiseDigest({
            promiseId: promise.id,
            creatorAddress: promise.creatorAddress,
            theyGave,
            theyOwe,
            dueDate: qrPayload.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        if (digest !== promise.counterDigestPending) return;
        promise.theyGave = theyGave;
        promise.theyOwe = theyOwe;
        promise.what = `${theyGave} → ${theyOwe}`;
        promise.dueDate = qrPayload.dueDate;
        promise.digest = digest;
        promise.counterTermsPending = false;
        delete promise.counterDigestPending;
        promise.updatedAt = Date.now();
        await this.saveToStorage();
    }

    /**
     * C3: import a promise delivered via the E2E-encrypted REMOTE share link.
     * Decrypts the terms in-memory with the fragment key (`k`), then reuses the
     * SAME vetted QR import path (field-length validation + dedup) to construct
     * and persist the counterparty's local PromiseRecord. After this, the
     * existing reconcile / closeOutPromise round-trip works as for a scanned QR.
     *
     * THROWS (via decryptPromisePayload) on a wrong key, tampered ciphertext, or
     * malformed payload — "Unknown = Block": an unverifiable link yields no
     * import. The caller MUST NOT log `d` or `k`.
     */
    async importPromiseFromShareLink(d: string, k: string, myAddress: string): Promise<PromiseRecord | null> {
        await this.ensureLoaded();
        const payload = decryptPromisePayload(d, k);
        return this.importPromiseFromQR(payload, myAddress);
    }

    /**
     * Update an existing promise record.
     * Used by NegotiationService to persist negotiation state changes.
     */
    async updatePromise(promise: PromiseRecord): Promise<void> {
        await this.ensureLoaded();
        this.promises.set(promise.id, promise);
        await this.saveToStorage();
    }

    async deletePromise(id: string, biometricAction?: BiometricAction): Promise<boolean> {
        await this.ensureLoaded();
        const promise = this.promises.get(id);
        const deleted = this.promises.delete(id);
        if (deleted) {
            await this.saveToStorage();

            // Chunk-K: Audit trail - deleting a promise should leave a PE
            // so the action is visible in the user's provenance chain.
            // Without this, a debtor could quietly delete a promise they
            // owe and there'd be zero evidence it ever existed.
            try {
                await ProvenanceEnvelopeManager.createEnvelope({
                    actionType: 'promise_deleted',
                    intentText: 'Promise deleted',
                    assetSymbol: 'PROMISE',
                    amount: '1',
                    chainId: 'local',
                    riskScore: 10,
                    riskCategory: 'low',
                    policyDecision: 'allow',
                }, biometricAction);
            } catch {
                // PE creation is non-fatal - the deletion has already happened.
            }
        }
        return deleted;
    }

    async deleteAllPromises(): Promise<number> {
        await this.ensureLoaded();
        const count = this.promises.size;
        this.promises.clear();
        await this.saveToStorage();
        return count;
    }

    /**
     * NO-OP (no caller today): there is no user-cloud (iCloud / Google Drive)
     * promise sync — the native keychain sync it used was deleted. It only logs the
     * local count when a cloud backup is configured. What survives a device loss is
     * the RELAY copy of published promises (; see restoreFromRelay), not this.
     */
    async syncToUserCloud(): Promise<void> {
        try {
            const backupExists = await hasCloudBackup();
            if (!backupExists) {
                console.log('[PromiseService] Cloud backup not configured, relying on device backup');
                return;
            }

            // Serialize all promises
            const data = Array.from(this.promises.values());
            const serialized = JSON.stringify(data);

            // Cloud sync removed (NativeKeychainSync deleted). Promises are local-only.
            console.log(`[PromiseService] ${data.length} promises stored locally`);
        } catch (err) {
            console.error('[PromiseService] Cloud sync failed:', err);
            // Non-fatal - local storage is always the source of truth
        }
    }

    /**
     * NO-OP (no caller today): always returns 0 (there is no user-cloud promise
     * copy to restore). Recovery restores promises via restoreFromRelay.
     */
    async restoreFromCloud(): Promise<number> {
        try {
            const backupExists = await hasCloudBackup();
            if (!backupExists) {
                return 0;
            }

            // Cloud sync removed - no cloud restore available
            return 0;
        } catch (err) {
            console.error('[PromiseService] Cloud restore failed:', err);
            return 0;
        }
    }

    /**
     * rebuild the caller's promises from the RELAY after a wallet recovery
     * on a new device. Lists every promise the wallet is a party to, decrypts THIS
     * party's own seed-encrypted terms copy (recoverable because the key derives
     * from the restored seed), and reconstructs the local PromiseRecord. A promise
     * already on this device is never overwritten (local wins). Returns the count
     * restored. Best-effort: an unreachable relay or a locked wallet returns 0.
     */
    async restoreFromRelay(biometricAction?: BiometricAction): Promise<number> {
        await this.ensureLoaded();

        // Terms decryption reads the seed (biometric-gated) — establish a session.
        try {
            return await withBiometricAction(translate('biometricPrompts.restorePromises', 'Restore your promises'), async (biometricAction) => {


                const res = await promiseRelayService.listMine(biometricAction);
                if (!res) return 0;
                const myUid = res.myAddress.toLowerCase();

                let restored = 0;
                for (const remote of res.promises) {
                    if (this.promises.has(remote.promiseId)) continue; // keep the local copy

                    const myRecord = remote.signatures[myUid];
                    const blob = myRecord?.termsCiphertext;
                    if (!blob) continue; // no terms copy of mine to decrypt (not a signer yet)

                    let terms: PromiseTermsPayload | null = null;
                    try {
                        terms = await decryptTermsFromSelf(blob, biometricAction);
                    } catch {
                        terms = null; // wrong seed / tampered / malformed → skip (Unknown = Block)
                    }
                    if (!terms) continue;

                    const otherUid = remote.creatorUid === myUid ? remote.acceptorUid : remote.creatorUid;
                    const creatorSig = remote.creatorUid === myUid
                        ? myRecord?.signature
                        : remote.signatures[remote.creatorUid]?.signature;
                    const rebuilt: PromiseRecord = {
                        id: remote.promiseId,
                        theyGave: terms.theyGave,
                        theyOwe: terms.theyOwe,
                        what: `${terms.theyGave} → ${terms.theyOwe}`,
                        who: terms.who,
                        whoAddress: terms.whoAddress ?? otherUid ?? undefined,
                        direction: terms.direction,
                        dueDate: terms.dueDate,
                        status: remote.status as PromiseStatus,
                        createdAt: terms.createdAt,
                        updatedAt: remote.updatedAt || Date.now(),
                        creatorAddress: terms.creatorAddress,
                        creatorName: terms.creatorName,
                        events: [{
                            id: uuidv4(),
                            type: 'created',
                            timestamp: terms.createdAt,
                            actor: terms.creatorAddress,
                        }],
                        digest: remote.digest,
                        relayBacked: true,
                        creatorSignature: creatorSig,
                        counterpartySignature: otherUid ? remote.signatures[otherUid]?.signature : undefined,
                    };
                    // An open counter (review r1, 2026-10-17): the party that has not signed the
                    // relay's digest answers it, and the terms restored here are this party's own
                    // copy — the counter's terms only if they hash to its digest. Otherwise they
                    // arrive with the other party's re-shared link, as on the device that was lost.
                    if (rebuilt.status === 'countered') {
                        rebuilt.counterFromCounterparty = myRecord?.signedDigest !== remote.digest;
                        if (rebuilt.counterFromCounterparty && !(await this.termsMakeDigest(rebuilt, remote.digest))) {
                            rebuilt.counterTermsPending = true;
                            rebuilt.counterDigestPending = remote.digest;
                        }
                    }
                    this.promises.set(rebuilt.id, rebuilt);
                    restored++;
                }

                if (restored > 0) await this.saveToStorage();
                return restored;

            }, biometricAction);
        } catch {
            return 0;
        }
}

    private async loadFromStorage(): Promise<void> {
        try {
            const stored = await AsyncStorage.getItem(STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored) as PromiseRecord[];
                data.forEach(p => this.promises.set(p.id, p));
            }
        } catch (error) {
            console.error('[PromiseService] Failed to load from storage:', error);
        }
    }

    /**
     * Persist all promises to AsyncStorage.
     *
     * Chunk-K: Previously errors were silently swallowed. If the write
     * fails (disk full, permissions) the user thinks the promise was
     * saved; on restart it's gone. We now propagate the error so callers
     * can surface it ("promise could not be saved - try again").
     */
    private async saveToStorage(): Promise<void> {
        const data = Array.from(this.promises.values());
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    /**
     * Reconcile a local promise against the authoritative remote sync document.
     *
     * This is the single place that interprets the uid-keyed promise_sync doc and
     * applies it to local state, so the live subscription and the on-demand poll
     * behave identically. It mirrors the in-person QR flow's cryptographic result:
     * counterparty signatures are copied in as opaque strings (the device-local
     * tags are not cross-verifiable — see the integrity-tag note at the top of
     * this file); the trust comes from the promise_sync rules guaranteeing each
     * tag was written by a distinct authenticated uid.
     *
     * Returns true if anything changed locally.
     */
    private async reconcileWithRemote(promise: PromiseRecord, remote: import('./PromiseRelayService').PromiseSyncDocument, biometricAction?: BiometricAction): Promise<boolean> {
        const myUid = promiseRelayService.getUid();
        const cpSigUid = Object.keys(remote.signatures).find(u => u !== myUid);
        const cpCloseoutUid = Object.keys(remote.closeout).find(u => u !== myUid);
        const iHaveCloseout = myUid ? !!remote.closeout[myUid] : false;
        const bothCloseout = Object.keys(remote.closeout).length >= 2;
        const ts = remote.updatedAt || Date.now();
        let changed = false;

        // We are reconciling against a REAL remote doc → this promise is relay-backed.
        // Persisting this is what lets a later OFFLINE close-out choose the deferred
        // mutual path (offline_pending) over a unilateral local fulfill.
        if (!promise.relayBacked) {
            promise.relayBacked = true;
            changed = true;
        }

        // Keep the local digest in sync with the relay's AGREED digest; the close-out signature is
        // over this value. A digest this device has not signed is a COUNTER from the other party:
        // its terms are not here (their copy is encrypted to them), so adopting the digest would
        // let this device accept or close out over terms it never saw (2026-10-17 bug check).
        const mySignedDigest = myUid ? remote.signatures[myUid]?.signedDigest : undefined;
        const digestAgreedByMe = mySignedDigest === remote.digest || remote.status === 'accepted' || remote.status === 'fulfilled';
        if (remote.digest && promise.digest !== remote.digest && digestAgreedByMe) {
            promise.digest = remote.digest;
            changed = true;
        }
        // The terms on this device are the counter's only if they hash to its digest: a record
        // restored from the relay carries the counter's digest beside this party's OWN older terms
        // (its copy there is this party's), so the digest alone cannot say (review r1, 2026-10-17).
        const termsMakeRemoteDigest = remote.status === 'countered' && !!remote.digest && !digestAgreedByMe
            && await this.termsMakeDigest(promise, remote.digest);
        if (remote.status === 'countered' && remote.digest && !digestAgreedByMe && !termsMakeRemoteDigest) {
            // Remember WHICH digest the counter is, so the re-shared code or link can be checked
            // against it — also for a record flagged before the digest was kept.
            if (promise.counterDigestPending !== remote.digest) {
                promise.counterDigestPending = remote.digest;
                changed = true;
            }
            if (!promise.counterTermsPending) {
                promise.counterTermsPending = true;
                if (promise.status !== 'countered') {
                    try {
                        assertValidTransition(promise.status, 'countered');
                        promise.status = 'countered';
                        promise.events.push({ id: uuidv4(), type: 'countered', timestamp: ts, actor: 'relay_sync' });
                    } catch {
                        console.warn(`[PromiseService] Relay counter arrived in state ${promise.status} for ${promise.id}`);
                    }
                }
                promise.updatedAt = ts;
                changed = true;
            }
        } else if (promise.counterTermsPending && digestAgreedByMe) {
            promise.counterTermsPending = false;
            delete promise.counterDigestPending;
            changed = true;
        }
        // Who answers an open counter is read from the relay: the party that has not signed its
        // digest (2026-10-17). It stays set after the re-shared link brings the terms here.
        if (remote.status === 'countered' && promise.status === 'countered') {
            const awaitsMe = !digestAgreedByMe;
            if (promise.counterFromCounterparty !== awaitsMe) {
                promise.counterFromCounterparty = awaitsMe;
                changed = true;
            }
        }

        // Learn the counterparty's wallet address once both parties are on record —
        // the earning path needs `whoAddress` = the OTHER party's EVM address (the
        // creator only learns the acceptor's address after the accept lands).
        const otherPartyUid = (myUid && remote.creatorUid === myUid)
            ? remote.acceptorUid
            : remote.creatorUid;
        if (otherPartyUid && promise.whoAddress !== otherPartyUid) {
            promise.whoAddress = otherPartyUid;
            changed = true;
        }

        // 1. Acceptance: counterparty signed the terms → mark accepted, record tag. From
        //    `countered` too (2026-10-17): the other party accepted this device's counter.
        if (remote.status === 'accepted' && (promise.status === 'pending' || promise.status === 'countered')) {
            try {
                assertValidTransition(promise.status, 'accepted');
                const fromCounter = promise.status === 'countered';
                promise.status = 'accepted';
                promise.updatedAt = ts;
                if (cpSigUid) {
                    // creatorSignature is the creator's, counterpartySignature the acceptor's
                    // (the pending path has always been the creator learning the acceptor's).
                    const cpSignature = remote.signatures[cpSigUid].signature;
                    if (fromCounter && cpSigUid === remote.creatorUid) promise.creatorSignature = cpSignature;
                    else promise.counterpartySignature = cpSignature;
                }
                promise.counterFromCounterparty = false;
                promise.events.push({ id: uuidv4(), type: 'accepted', timestamp: ts, actor: 'relay_sync' });
                changed = true;
            } catch {
                console.warn(`[PromiseService] Relay tried invalid accept for ${promise.id}`);
            }
        }

        // 1a. An agreement made over a counter: this device may still hold the other party's signature
        //     over terms the promise moved past (two-sim proof, 2026-10-17: the acceptor kept the
        //     creator's original signature beside the countered digest). Once both sides agree, each
        //     party's slot holds that party's signature over the agreed digest, as the relay does.
        if (promise.status === 'accepted' && remote.status === 'accepted' && promise.digest === remote.digest) {
            for (const [uid, rec] of Object.entries(remote.signatures)) {
                if (rec.signedDigest !== remote.digest || !rec.signature) continue;
                if (uid === remote.creatorUid) {
                    if (promise.creatorSignature !== rec.signature) { promise.creatorSignature = rec.signature; changed = true; }
                } else if (uid === remote.acceptorUid) {
                    if (promise.counterpartySignature !== rec.signature) { promise.counterpartySignature = rec.signature; changed = true; }
                }
            }
        }

        // 1b. Rejection (Pass-3 #29): the recipient declined a still-pending
        //     promise. Publishing a 'rejected' status is the missing counterpart
        //     to accept/dispute — without applying it here the creator's device
        //     would sit on 'pending' ("awaiting acceptance") forever. Terminal.
        if (remote.status === 'rejected' && (promise.status === 'pending' || promise.status === 'countered')) {
            try {
                assertValidTransition(promise.status, 'rejected');
                promise.status = 'rejected';
                promise.updatedAt = ts;
                promise.counterFromCounterparty = false;
                promise.counterTermsPending = false;
                delete promise.counterDigestPending;
                promise.events.push({ id: uuidv4(), type: 'negotiation_rejected', timestamp: ts, actor: 'relay_sync' });
                changed = true;
            } catch {
                console.warn(`[PromiseService] Relay tried invalid reject for ${promise.id}`);
            }
        }

        // 1c. Broken: the counterparty marked an accepted (or disputed) promise broken. Terminal.
        if (remote.status === 'broken' && (promise.status === 'accepted' || promise.status === 'disputed')) {
            try {
                assertValidTransition(promise.status, 'broken');
                promise.status = 'broken';
                promise.updatedAt = ts;
                promise.events.push({ id: uuidv4(), type: 'broken', timestamp: ts, actor: 'relay_sync' });
                changed = true;
            } catch {
                console.warn(`[PromiseService] Relay tried invalid broken for ${promise.id}`);
            }
        }

        // 2. Dispute.
        if (remote.status === 'disputed' && promise.status === 'accepted') {
            try {
                assertValidTransition(promise.status, 'disputed');
                promise.status = 'disputed';
                promise.updatedAt = ts;
                promise.events.push({ id: uuidv4(), type: 'disputed', timestamp: ts, actor: 'relay_sync' });
                changed = true;
            } catch {
                console.warn(`[PromiseService] Relay tried invalid dispute for ${promise.id}`);
            }
        }

        // 3. Counterparty initiated a close-out (their closeout tag present, mine
        //    absent, not yet fulfilled) → surface "agree?" without auto-closing.
        if (remote.status !== 'fulfilled' && cpCloseoutUid && !iHaveCloseout) {
            if (!promise.closeoutInitiatedByCounterparty) {
                promise.closeoutInitiatedByCounterparty = true;
                promise.fulfillmentSignatures = {
                    ...(promise.fulfillmentSignatures ?? {}),
                    counterparty: remote.closeout[cpCloseoutUid].signature,
                };
                promise.updatedAt = ts;
                changed = true;
            }
        }

        // 4. Both parties have closed out → settle. (Only reachable once I have
        //    also posted my closeout tag, so this is a legitimate mutual close.)
        if ((remote.status === 'fulfilled' || bothCloseout) && promise.status !== 'fulfilled' && iHaveCloseout) {
            if (cpCloseoutUid) {
                promise.fulfillmentSignatures = {
                    ...(promise.fulfillmentSignatures ?? {}),
                    counterparty: remote.closeout[cpCloseoutUid].signature,
                };
            }
            // No client-driven finalize: the relay flips to `fulfilled` in the same
            // transaction that records the SECOND close-out signature, so reaching
            // here with both present means the relay already settled it.
            const myAddress = (myUid && remote.creatorUid === myUid)
                ? promise.creatorAddress
                : (promise.whoAddress ?? promise.creatorAddress);
            await this.finalizeLocalFulfillment(promise, myAddress, undefined, biometricAction);
            changed = true;
        }

        return changed;
    }

    /** Do this record's terms hash to `digest` (under its id, creator and creation time)? */
    private async termsMakeDigest(promise: PromiseRecord, digest: string): Promise<boolean> {
        const computed = await computePromiseDigest({
            promiseId: promise.id,
            creatorAddress: promise.creatorAddress,
            theyGave: promise.theyGave,
            theyOwe: promise.theyOwe,
            dueDate: promise.dueDate ?? null,
            createdAt: promise.createdAt,
        });
        return computed === digest;
    }

    /** The relay no longer holds this promise: it expired unsettled. True when the local copy changed. */
    private async markExpiredByRelay(promise: PromiseRecord, ts: number): Promise<boolean> {
        if (promise.status === 'expired' || promise.status === 'fulfilled' || promise.status === 'broken' || promise.status === 'rejected') return false;
        try {
            assertValidTransition(promise.status, 'expired');
        } catch {
            return false;
        }
        promise.status = 'expired';
        promise.pendingCloseoutPublish = false;
        promise.updatedAt = ts;
        promise.events.push({ id: uuidv4(), type: 'expired', timestamp: ts, actor: 'relay_sync' });
        return true;
    }

    /**
     * Flush a DEFERRED close-out (the `offline_pending` tail). If this promise holds
     * a locally-recorded close-out tag (`pendingCloseoutPublish`) that never reached
     * the relay — we were offline when the user closed out — publish it now that we
     * have a fresh remote doc. Idempotent: if our tag is ALREADY on the relay (a
     * queued offline write landed), just clear the flag and let reconcile finalize.
     * Returns true if local state changed.
     *
     * Convergence (no deadlock), including BOTH parties going offline_pending: each
     * device, when it next reaches the relay, re-publishes its stored close-out
     * signature. The RELAY settles authoritatively — whichever party's write is the
     * SECOND to land flips the doc to `fulfilled` in that same transaction and gets
     * mode `fulfilled` back; the first gets `awaiting_counterparty`. Either ordering
     * converges to `fulfilled` on both sides (the later reconcile applies it).
     */
    private async flushPendingCloseout(promise: PromiseRecord, remote: import('./PromiseRelayService').PromiseSyncDocument, biometricAction?: BiometricAction): Promise<boolean> {
        if (!promise.pendingCloseoutPublish) return false;
        const myUid = promiseRelayService.getUid();
        const mine = promise.fulfillmentSignatures?.mine;
        if (!myUid || !mine) {
            // No identity / no stored tag → clear the flag so it can't stick forever;
            // a fresh close-out can re-initiate.
            promise.pendingCloseoutPublish = false;
            return true;
        }

        // Our tag already landed (e.g. a queued offline write committed) → nothing to
        // publish; the caller's reconcile pass settles it.
        if (remote.closeout[myUid]) {
            promise.pendingCloseoutPublish = false;
            return true;
        }

        // Re-publish my stored close-out signature; the RELAY reports finalize vs
        // await in `mode`. No `role`/`finalize` flags — the server decides.
        const result = await withTimeout(
            promiseRelayService.publishCloseoutSignature(promise.id, mine, biometricAction),
            CLOSEOUT_PUBLISH_TIMEOUT_MS,
            { ok: false },
        );
        if (!result.ok) {
            if (isDefinitiveRelayRefusal(result.httpStatus)) {
                // Refused, not unreachable: stop re-sending it (2026-10-17). The person closes out
                // again from the current state if that is still what they want.
                console.warn(`[PromiseService] Relay refused the deferred close-out for ${promise.id} (HTTP ${result.httpStatus}); dropping it`);
                promise.pendingCloseoutPublish = false;
                return true;
            }
            return false; // still unreachable → retry on the next flush
        }

        promise.pendingCloseoutPublish = false;

        if (result.mode === 'fulfilled') {
            // Relay confirmed BOTH close-out signatures → settle now.
            const cpUid = Object.keys(remote.closeout).find(u => u !== myUid);
            if (cpUid) {
                promise.fulfillmentSignatures = {
                    ...(promise.fulfillmentSignatures ?? {}),
                    counterparty: remote.closeout[cpUid].signature,
                };
            }
            const myAddress = remote.creatorUid === myUid
                ? promise.creatorAddress
                : (promise.whoAddress ?? promise.creatorAddress);
            await this.finalizeLocalFulfillment(promise, myAddress, undefined, biometricAction);
        } else {
            // We published first; awaiting the counterparty's confirmation.
            promise.closeoutInitiatedByMe = true;
        }
        return true;
    }

    /**
     * Subscribe to real-time updates for a promise via relay. The reconciler
     * applies remote accept / close-out-request / fulfill / dispute changes to the
     * local record; the callback fires with the updated record on any change. It
     * also FLUSHES a deferred (offline_pending) close-out — when the device
     * reconnects while on this screen, onSnapshot delivers server data and the
     * stored close-out tag is published.
     *
     * @param promiseId The promise to watch
     * @param callback Called with the reconciled local record on change
     * @returns Unsubscribe function
     */
    subscribeToUpdates(promiseId: string, callback: (promise: PromiseRecord) => void, biometricAction?: BiometricAction): () => void {
        return promiseRelayService.subscribeToPromise(promiseId, async (remote) => {
            const promise = this.promises.get(promiseId);
            if (!promise) return;
            let changed = await this.flushPendingCloseout(promise, remote, biometricAction);
            const reconciled = await this.reconcileWithRemote(promise, remote, biometricAction);
            if (reconciled) changed = true;
            if (changed) {
                await this.saveToStorage();
                callback(promise);
            }
        }, biometricAction);
    }

    /**
     * Subscribe to updates for all in-flight promises (pending awaiting acceptance,
     * or accepted awaiting close-out). Fires when a counterparty accepts, requests
     * a close-out, agrees to one, or disputes.
     */
    async subscribeToMyPendingPromises(callback: (promiseId: string, status: PromiseStatus) => void, biometricAction?: BiometricAction): Promise<() => void> {
        await this.ensureLoaded();

        const unsubscribes: (() => void)[] = [];

        for (const promise of this.promises.values()) {
            if (promise.status === 'pending' || promise.status === 'accepted') {
                const unsub = this.subscribeToUpdates(promise.id, (p) => {
                    callback(p.id, p.status);
                }, biometricAction);
                unsubscribes.push(unsub);
            }
        }

        return () => {
            unsubscribes.forEach(unsub => unsub());
        };
    }

    /**
     * Poll the relay for updates on in-flight promises (pending or accepted).
     * Used on pull-to-refresh and screen focus to catch missed updates.
     * Returns the number of promises that were updated.
     */
    async syncPendingPromises(biometricAction?: BiometricAction): Promise<number> {
        await this.ensureLoaded();

        let syncedCount = 0;

        for (const promise of this.promises.values()) {
            if (promise.status !== 'pending' && promise.status !== 'accepted' && promise.status !== 'countered' && promise.status !== 'disputed') continue;

            try {
                const lookup = await promiseRelayService.checkPromiseStatusDetailed(promise.id, biometricAction);
                if (lookup.kind === 'not_found') {
                    // The relay purged it past its expiry. A relay-backed promise with no relay
                    // doc has no bilateral path left; say so instead of "pending" forever.
                    if (promise.relayBacked && await this.markExpiredByRelay(promise, Date.now())) {
                        syncedCount++;
                        console.log('[PromiseService] Promise expired on the relay', promise.id);
                    }
                    continue;
                }
                if (lookup.kind !== 'found') continue;
                const remote = lookup.doc;

                // Flush any deferred close-out (offline_pending) BEFORE reconciling,
                // so a re-published tag is reflected. This is the deferred-completion
                // path: syncPendingPromises is invoked on screen focus AND on app
                // return-to-foreground (App.tsx AppState 'active'), so a close-out
                // recorded offline publishes on the next foreground/reconnect.
                let changed = await this.flushPendingCloseout(promise, remote, biometricAction);
                const reconciled = await this.reconcileWithRemote(promise, remote, biometricAction);
                if (reconciled) changed = true;
                if (changed) {
                    syncedCount++;
                    console.log('[PromiseService] Synced promise', promise.id, '→', promise.status);
                }
            } catch (err) {
                console.log('[PromiseService] Relay poll failed for', promise.id, err);
            }
        }

        if (syncedCount > 0) {
            await this.saveToStorage();
        }

        return syncedCount;
    }

    // the device-local integrity tags (and their WS6-removed
    // verifyCreatorSignature / verifyAcceptanceSignature helpers) are GONE. Promise
    // authenticity is now REAL cross-device EIP-191 wallet signatures over the
    // promise digest — see ./promiseSigning (signHumanPromisePhase /
    // verifyHumanPromiseSignature), which the relay re-verifies server-side.

    getStatusColor(status: PromiseStatus): string {
        const colors: Record<PromiseStatus, string> = {
            pending: '#F59E0B', // warning
            accepted: '#6366F1', // primary
            fulfilled: '#10B981', // success
            broken: '#EF4444', // error
            disputed: '#F43F5E', // accent
            expired: '#64748B', // tertiary
            // Agent negotiation states
            offered: '#8B5CF6', // purple (agent offer pending)
            countered: '#F59E0B', // amber (counter-offer)
            rejected: '#6B7280', // gray (rejected)
        };
        return colors[status];
    }

    getStatusLabel(status: PromiseStatus): string {
        const labels: Record<PromiseStatus, string> = {
            pending: 'Waiting',
            accepted: 'Active',
            fulfilled: 'Done',
            broken: 'Broken',
            disputed: 'Disputed',
            expired: 'Expired',
            // Agent negotiation states
            offered: 'Offer Pending',
            countered: 'Counter-Offer',
            rejected: 'Rejected',
        };
        return labels[status];
    }

    // Get a dynamic status label that includes the person's name for pending status
    getStatusLabelWithName(status: PromiseStatus, who: string): string {
        if (status === 'pending' && who) {
            return `Waiting for ${who}`;
        }
        return this.getStatusLabel(status);
    }
}

export default PromiseService.getInstance();
