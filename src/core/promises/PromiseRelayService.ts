import type { BiometricAction } from '../security/biometricAction';
/**
 * PromiseRelayService
 * ===================
 *
 * Signaling + state layer for the REMOTE human promise path — now on the PROVIAN
 * RELAY under human wallet auth, NOT the retired Firestore `promise_sync`
 * side-channel. Every call goes through RelayAPIService (wallet-authenticated);
 * there is no Firebase client here anymore.
 *
 * The in-person two-QR flow still never touches the relay (it round-trips the
 * same signatures by scanning QR codes). This service is ONLY the remote path.
 *
 * TRUST MODEL — the promise "signatures" are REAL EIP-191 wallet signatures over
 * the promise digest (terms + creator + id). The relay verifies each one recovers
 * to the signing party's wallet and stores it; either party can verify the
 * other's later. A `fulfilled` (closed) promise is valid only once BOTH parties
 * hold a close-out signature, and a transition is authorized only by a party's
 * wallet — all enforced server-side.
 *
 * Documents auto-purge after 30 days (the relay expiry sweep).
 */

import { useWalletStore } from '../../store/walletStore';
import relayService, {
  type RelayHumanPromiseDocument,
} from '../../services/RelayAPIService';

export type PromiseSyncStatus =
  | 'pending' | 'accepted' | 'fulfilled' | 'disputed' | 'rejected'
  | 'countered' | 'offered' | 'broken' | 'expired';
export type PartyRole = 'creator' | 'acceptor' | 'rejecter';

/**
 * Outcome of an acceptance publish. Kept from the Firestore era so the acceptor
 * can distinguish a not-yet-visible creator doc (online race → retry) from being
 * genuinely offline (→ in-person QR hand-off).
 */
export type AcceptPublishResult = 'published' | 'not_found' | 'offline' | 'error';

/** A single party's record for one phase, keyed by their lowercased address. */
export interface PartySignature {
  role: PartyRole;
  signature: string;
  at: number;
  /** The digest this party's agreement signature covers (absent on close-out records). */
  signedDigest?: string;
  /**
   * This party's OWN opaque, seed-encrypted terms copy. Present only on
   * the party's own agreement record; used by wallet recovery to decrypt and
   * rebuild the local promise (see PromiseService.restoreFromRelay).
   */
  termsCiphertext?: string;
}

/**
 * Local, transport-agnostic projection of the relay promise doc. The field NAMES
 * are kept from the Firestore era (`creatorUid`, `signatures`, `closeout`) so the
 * PromiseService reconciler is unchanged in shape — but the keys are now WALLET
 * ADDRESSES (lowercased), not Firebase uids.
 */
export interface PromiseSyncDocument {
  promiseId: string;
  creatorUid: string;            // creator's lowercased wallet address
  acceptorUid: string | null;    // acceptor's lowercased wallet address (or null)
  digest: string;                // the digest the agreement signatures cover
  signatures: Record<string, PartySignature>;  // address → terms/accept/counter record
  closeout: Record<string, PartySignature>;    // address → close-out record
  status: PromiseSyncStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type SyncEventCallback = (snapshot: PromiseSyncDocument) => void;

export interface CloseoutPublishResult {
  ok: boolean;
  mode?: 'fulfilled' | 'awaiting_counterparty';
  /** The relay's HTTP status when it answered; absent when it could not be reached. */
  httpStatus?: number;
  error?: string;
}

export { isDefinitiveRelayRefusal } from './relayRefusal';

export type PromiseStatusLookup =
  | { kind: 'found'; doc: PromiseSyncDocument }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** Poll cadence that replaces the Firestore onSnapshot listener. */
const SUBSCRIBE_POLL_MS = 6000;

function lc(addr: string | null | undefined): string {
  return (addr ?? '').toLowerCase();
}

/** Project a relay doc into the local PromiseSyncDocument shape. */
function projectDoc(doc: RelayHumanPromiseDocument): PromiseSyncDocument {
  const signatures: Record<string, PartySignature> = {};
  for (const [addr, rec] of Object.entries(doc.parties ?? {})) {
    signatures[lc(addr)] = {
      role: rec.role,
      signature: rec.signature,
      at: rec.signed_at,
      signedDigest: rec.signed_digest,
      termsCiphertext: rec.terms_ciphertext,
    };
  }
  const closeout: Record<string, PartySignature> = {};
  for (const [addr, rec] of Object.entries(doc.closeout ?? {})) {
    // role is not stored on close-out records; derive from creator/acceptor.
    const role: PartyRole = lc(addr) === lc(doc.creator_address) ? 'creator' : 'acceptor';
    closeout[lc(addr)] = { role, signature: rec.signature, at: rec.signed_at };
  }
  return {
    promiseId: doc.promise_id,
    creatorUid: lc(doc.creator_address),
    acceptorUid: doc.acceptor_address ? lc(doc.acceptor_address) : null,
    digest: doc.digest,
    signatures,
    closeout,
    status: (doc.status as PromiseSyncStatus) ?? 'pending',
    createdAt: doc.created_at ?? 0,
    updatedAt: doc.updated_at ?? 0,
    expiresAt: doc.expires_at ?? 0,
  };
}

class PromiseRelayService {
  private static instance: PromiseRelayService;
  private pollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  private constructor() {}

  static getInstance(): PromiseRelayService {
    if (!PromiseRelayService.instance) {
      PromiseRelayService.instance = new PromiseRelayService();
    }
    return PromiseRelayService.instance;
  }

  /** The caller's own lowercased wallet address — the party key on the relay. */
  getUid(): string | null {
    const addr = useWalletStore.getState().address;
    return addr ? addr.toLowerCase() : null;
  }

  isAvailable(): boolean {
    return this.getUid() !== null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Publish a new promise (create). Returns whether the relay accepted it. */
  async publishPromiseCreated(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<boolean> {
    const r = await relayService.createHumanPromise(promiseId, digest, signature, termsCiphertext, biometricAction);
    return r.ok;
  }

  /** Publish an acceptance. Distinguishes not-found (creator doc absent) from offline. */
  async tryPublishAcceptance(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<AcceptPublishResult> {
    const r = await relayService.acceptHumanPromise(promiseId, digest, signature, termsCiphertext, biometricAction);
    if (r.ok) return 'published';
    if (r.httpStatus === 404) return 'not_found';
    if (r.httpStatus === undefined) return 'offline';
    return 'error';
  }

  async publishPromiseAccepted(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<boolean> {
    return (await this.tryPublishAcceptance(promiseId, digest, signature, termsCiphertext, biometricAction)) === 'published';
  }

  /** Publish a counter (re-proposal of new terms). */
  async publishPromiseCountered(promiseId: string, digest: string, signature: string, termsCiphertext: string, biometricAction?: BiometricAction): Promise<boolean> {
    const r = await relayService.counterHumanPromise(promiseId, digest, signature, termsCiphertext, biometricAction);
    return r.ok;
  }

  /** Publish this party's close-out signature. Returns whether it landed + the mode. */
  async publishCloseoutSignature(promiseId: string, signature: string, biometricAction?: BiometricAction): Promise<CloseoutPublishResult> {
    const r = await relayService.closeOutHumanPromise(promiseId, signature, biometricAction);
    return {
      ok: r.ok,
      mode: r.mode === 'fulfilled' ? 'fulfilled' : r.mode === 'awaiting_counterparty' ? 'awaiting_counterparty' : undefined,
      httpStatus: r.httpStatus,
      error: r.error,
    };
  }

  async publishPromiseDisputed(promiseId: string, biometricAction?: BiometricAction): Promise<boolean> {
    return (await relayService.disputeHumanPromise(promiseId, biometricAction)).ok;
  }

  async publishPromiseBroken(promiseId: string, biometricAction?: BiometricAction): Promise<boolean> {
    return (await relayService.brokenHumanPromise(promiseId, biometricAction)).ok;
  }

  async publishPromiseRejected(promiseId: string, biometricAction?: BiometricAction): Promise<boolean> {
    return (await relayService.rejectHumanPromise(promiseId, biometricAction)).ok;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async checkPromiseStatus(promiseId: string, biometricAction?: BiometricAction): Promise<PromiseSyncDocument | null> {
    const r = await this.checkPromiseStatusDetailed(promiseId, biometricAction);
    return r.kind === 'found' ? r.doc : null;
  }

  /** Like checkPromiseStatus, but "the relay no longer holds it" is its own answer. */
  async checkPromiseStatusDetailed(promiseId: string, biometricAction?: BiometricAction): Promise<PromiseStatusLookup> {
    const r = await relayService.getHumanPromiseDetailed(promiseId, biometricAction);
    if (r.ok) return { kind: 'found', doc: projectDoc(r.promise) };
    return r.httpStatus === 404 ? { kind: 'not_found' } : { kind: 'unavailable' };
  }

  /** Every promise the caller is a party to (recovery + list sync). */
  async listMine(biometricAction?: BiometricAction): Promise<{ promises: PromiseSyncDocument[]; myAddress: string } | null> {
    const res = await relayService.listMyHumanPromises(biometricAction);
    if (!res) return null;
    return { promises: res.promises.map(projectDoc), myAddress: res.myAddress };
  }

  /**
   * Subscribe to a promise. Replaces the Firestore onSnapshot listener with a
   * relay poll: fires the callback with the current doc whenever it changes
   * (status, signatures, or close-out). Push-driven refreshes call
   * checkPromiseStatus directly; this poll is the fallback while a screen is open.
   */
  subscribeToPromise(promiseId: string, callback: SyncEventCallback, biometricAction?: BiometricAction): () => void {
    if (this.pollers.has(promiseId)) {
      // Already polling — return a no-op unsubscribe for the duplicate caller.
      return () => {};
    }
    let lastSerialized = '';
    const tick = async () => {
      try {
        const doc = await this.checkPromiseStatus(promiseId, biometricAction);
        if (!doc) return;
        const serialized = JSON.stringify(doc);
        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          callback(doc);
        }
      } catch {
        // transient; next tick retries
      }
    };
    void tick();
    const handle = setInterval(tick, SUBSCRIBE_POLL_MS);
    this.pollers.set(promiseId, handle);
    return () => this.unsubscribeFromPromise(promiseId);
  }

  unsubscribeFromPromise(promiseId: string): void {
    const handle = this.pollers.get(promiseId);
    if (handle) {
      clearInterval(handle);
      this.pollers.delete(promiseId);
    }
  }

  unsubscribeAll(): void {
    for (const handle of this.pollers.values()) clearInterval(handle);
    this.pollers.clear();
  }

  getStatus(): { available: boolean; address: string | null } {
    return { available: this.isAvailable(), address: this.getUid() };
  }
}

export const promiseRelayService = PromiseRelayService.getInstance();
export default promiseRelayService;
