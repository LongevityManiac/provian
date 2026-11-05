/** Durable nonce ownership. A signed attempt is never released on an RPC timeout. */
export interface SignedNonceAttempt {
  readonly nonce: number;
  readonly hash: string;
  readonly raw: string;
  readonly intent: string;
  readonly ready: boolean;
}
export interface NonceJournal {
  readonly operation?: { readonly id: string; readonly call: string; readonly state: 'created' | 'signed' | 'submitted' | 'conflict' };
  readonly version: 1;
  readonly next: number;
  readonly attempts: readonly SignedNonceAttempt[];
  readonly owner: string | null;
  readonly leaseUntil: number;
}
export interface NonceJournalStore {
  transact(key: string, change: (current: NonceJournal | null) => NonceJournal): Promise<NonceJournal>;
}
export interface CanonicalNonceRuntime {
  readonly store: NonceJournalStore;
  readonly now: () => number;
  readonly owner: () => string;
  readonly latestNonce: () => Promise<number>;
  /** Only irreversibly consumed attempts may leave the recovery journal. */
  readonly finalizedNonce: () => Promise<number>;
  readonly broadcast: (attempt: SignedNonceAttempt) => Promise<void>;
  readonly canReplay: boolean;
}

export function parseNonceJournal(value: unknown): NonceJournal | null {
  if (value === null || value === undefined) return null;
  const v = value as Partial<NonceJournal>;
  if (v.version !== 1 || !Number.isSafeInteger(v.next) || (v.next ?? -1) < 0
    || !Number.isSafeInteger(v.leaseUntil) || !Array.isArray(v.attempts)
    || !(v.owner === null || typeof v.owner === 'string')) throw new Error('nonce_journal_invalid');
  const nonces = new Set<number>();
  for (const a of v.attempts) {
    if (!Number.isSafeInteger(a.nonce) || a.nonce < 0 || a.nonce >= v.next!
      || !/^0x[0-9a-fA-F]{64}$/.test(a.hash) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(a.raw)
      || typeof a.intent !== 'string' || typeof a.ready !== 'boolean' || nonces.has(a.nonce)) {
      throw new Error('nonce_journal_attempt_invalid');
    }
    nonces.add(a.nonce);
  }
  return v as NonceJournal;
}

/**
 * Allocate under a fenced cross-process lease, sign, journal, then submit.
 * Unknown broadcasts retain the exact bytes. Uncommitted business callbacks
 * resume only for the same intent, before those bytes can be submitted.
 */
export async function sendWithCanonicalNonce(
  runtime: CanonicalNonceRuntime,
  key: string,
  intent: string,
  prepare: (nonce: number) => Promise<Omit<SignedNonceAttempt, 'intent' | 'ready'>>,
  options: { readonly nonce?: number; readonly beforeBroadcast?: (hash: string) => Promise<void>; readonly resumeSameIntent?: boolean; readonly prepareOnly?: boolean; readonly resumeHash?: string } = {},
): Promise<SignedNonceAttempt> {
  const owner = runtime.owner();
  const fenced = (state: NonceJournal | null): NonceJournal => {
    if (!state || state.owner !== owner || state.leaseUntil <= runtime.now()) throw new Error('nonce_lease_lost');
    return state;
  };
  let journal = await runtime.store.transact(key, (state) => {
    if (state?.owner && state.leaseUntil > runtime.now()) throw new Error('nonce_signer_busy');
    return { ...(state ?? { version: 1, next: 0, attempts: [] }), owner, leaseUntil: runtime.now() + 180_000 };
  });
  try {
    const [latest, finalized] = await Promise.all([runtime.latestNonce(), runtime.finalizedNonce()]);
    if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(finalized)
      || finalized < 0 || latest < finalized) throw new Error('nonce_canonical_state_invalid');
    journal = await runtime.store.transact(key, (state) => {
      const held = fenced(state);
      return { ...held, next: Math.max(held.next, latest), attempts: held.attempts.filter((a) => a.nonce >= finalized) };
    });
    for (const old of journal.attempts.filter((a) => a.nonce >= latest).sort((a, b) => a.nonce - b.nonce)) {
      let attempt = old;
      const exactRecovery = options.resumeHash === attempt.hash;
      if (options.prepareOnly && attempt.intent === intent) return attempt;
      if (!runtime.canReplay) throw new Error(`nonce_previous_transaction_unconfirmed:${attempt.hash}`);
      if (!attempt.ready) {
        if (attempt.intent !== intent && !exactRecovery) throw new Error(`nonce_uncommitted_attempt:${attempt.hash}`);
        await options.beforeBroadcast?.(attempt.hash);
        journal = await runtime.store.transact(key, (state) => ({ ...fenced(state),
          attempts: fenced(state).attempts.map((a) => a.nonce === attempt.nonce ? { ...a, ready: true } : a) }));
        attempt = { ...attempt, ready: true };
        // This is the original unsubmitted intent, not a new second payment.
        await runtime.broadcast(attempt);
        return attempt;
      }
      if (!options.prepareOnly) await runtime.broadcast(attempt);
      if (exactRecovery || (options.resumeSameIntent && attempt.intent === intent)) return attempt;
    }
    // Every allocated but unmined nonce must have its signed recovery bytes.
    for (let n = latest; n < journal.next; n++) {
      if (!journal.attempts.some((a) => a.nonce === n && a.ready)) throw new Error('nonce_recovery_gap');
    }
    const nonce = options.nonce ?? journal.next;
    if (nonce !== journal.next) throw new Error('nonce_override_conflicts_with_journal');
    const signed = await prepare(nonce);
    if (signed.nonce !== nonce) throw new Error('nonce_signed_attempt_mismatch');
    let attempt: SignedNonceAttempt = { ...signed, intent, ready: !options.beforeBroadcast && !options.prepareOnly };
    journal = await runtime.store.transact(key, (state) => {
      const held = fenced(state);
      if (held.next !== nonce) throw new Error('nonce_reservation_changed');
      return parseNonceJournal({ ...held, next: nonce + 1, attempts: [...held.attempts, attempt] })!;
    });
    if (options.prepareOnly) return attempt;
    await options.beforeBroadcast?.(attempt.hash);
    attempt = { ...attempt, ready: true };
    await runtime.store.transact(key, (state) => ({ ...fenced(state),
      attempts: fenced(state).attempts.map((a) => a.nonce === nonce ? attempt : a) }));
    await runtime.broadcast(attempt);
    return attempt;
  } finally {
    await runtime.store.transact(key, (state) => state?.owner === owner
      ? { ...state, owner: null, leaseUntil: 0 }
      : state ?? journal);
  }
}
