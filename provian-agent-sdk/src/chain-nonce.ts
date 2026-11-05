import type { NonceJournal, NonceJournalStore, SignedNonceAttempt } from './canonical-nonce';

export interface ChainOperation {
  readonly id: string;
  readonly call: string;
  readonly state: 'created' | 'signed' | 'submitted' | 'conflict';
}
export interface ChainNonceRuntime {
  readonly store: NonceJournalStore;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly nonce: () => Promise<number>;
  /** Nonce at the inclusive twelve-confirmation boundary. */
  readonly resolveConsumption: (attempt: SignedNonceAttempt) => Promise<'own' | 'other' | 'unknown'>;
  readonly included: (hash: string) => Promise<boolean>;
  readonly broadcast: (attempt: SignedNonceAttempt) => Promise<void>;
  readonly validate: (attempt: SignedNonceAttempt) => void;
  readonly assertApproved: () => void;
}
export class ChainNonceError extends Error {
  constructor(readonly code: 'NONCE_BUSY' | 'NONCE_CONFLICT' | 'SUBMISSION_UNCERTAIN' | 'OPERATION_MISMATCH',
    readonly operationId: string, readonly transactionHash?: string) {
    super(`${code}: operation ${operationId}${transactionHash ? `, transaction ${transactionHash}` : ''}`);
    this.name = 'ChainNonceError';
  }
}
const empty = (): NonceJournal => ({ version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 });
const operation = (journal: NonceJournal): ChainOperation => {
  const op = journal.operation;
  if (!op || !/^[A-Za-z0-9_-]{1,128}$/.test(op.id) || typeof op.call !== 'string'
    || !['created', 'signed', 'submitted', 'conflict'].includes(op.state)) throw new Error('chain_operation_invalid');
  return op;
};
/**
 * The canonical chain owns nonce ordering, including other devices and wallet apps.
 * A local journal owns only an operation's exact signed bytes. A conflict NEVER
 * moves an ambiguous operation to a fresh nonce. Operation results remain durable.
 */
export async function sendChainOperation(
  r: ChainNonceRuntime, signerKey: string, id: string, call: string,
  prepare: (nonce: number) => Promise<Omit<SignedNonceAttempt, 'intent' | 'ready'>>,
  options: { readonly nonce?: number; readonly resume?: boolean } = {},
): Promise<SignedNonceAttempt> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('chain_operation_id_invalid');
  const key = `${signerKey}_${id}`;
  // Identity and immutable call exist durably BEFORE any RPC or signing.
  let doc = await r.store.transact(key, current => {
    if (current) {
      const op = operation(current);
      if (op.id !== id || op.call !== call) throw new ChainNonceError('OPERATION_MISMATCH', id);
      return current;
    }
    return { ...empty(), operation: { id, call, state: 'created' } };
  });
  const owner = r.uuid();
  let held = false;
  const fence = (current: NonceJournal | null): NonceJournal => {
    if (!current || current.owner !== owner || current.leaseUntil <= r.now()) throw new Error('nonce_lease_lost');
    return current;
  };
  try {
    await r.store.transact(signerKey, current => {
      if (current?.owner && current.leaseUntil > r.now()) throw new ChainNonceError('NONCE_BUSY', id);
      return { ...(current ?? empty()), owner, leaseUntil: r.now() + 180_000 };
    });
    held = true;
    // A crash between the signer journal and operation record is recoverable.
    const index = await r.store.transact(signerKey, current => fence(current));
    if (!doc.attempts.length) {
      const saved = index.attempts.find(a => a.intent === id);
      if (saved) doc = await r.store.transact(key, current => ({ ...current!, next: saved.nonce + 1,
        attempts: [saved], operation: { id, call, state: 'signed' } }));
    }
    for (const previous of index.attempts.filter(a => a.intent !== id)) {
      const previousDoc = await readChainOperation(r.store, signerKey, previous.intent);
      if (!['submitted', 'conflict'].includes(operation(previousDoc).state)) throw new ChainNonceError('SUBMISSION_UNCERTAIN', previous.intent, previous.hash);
    }
    let attempt = doc.attempts[0];
    const op = operation(doc);
    if (op.state === 'conflict') throw new ChainNonceError('NONCE_CONFLICT', id, attempt?.hash);
    if (attempt) {
      r.validate(attempt);
      let included: boolean;
      try { included = await r.included(attempt.hash); }
      catch { throw new ChainNonceError('SUBMISSION_UNCERTAIN', id, attempt.hash); }
      if (included) {
        await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'submitted' } }));
        return attempt;
      }
      const consumption = await r.resolveConsumption(attempt);
      if (consumption === 'own') {
        await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'submitted' } }));
        return attempt;
      }
      if (consumption === 'other') {
        await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'conflict' } }));
        throw new ChainNonceError('NONCE_CONFLICT', id, attempt.hash);
      }
      // A later human action may recover only through the explicit reviewed route.
      if (!options.resume) throw new ChainNonceError('SUBMISSION_UNCERTAIN', id, attempt.hash);
    } else {
      const canonical = await r.nonce();
      const nonce = options.nonce ?? canonical;
      if (!Number.isSafeInteger(canonical) || canonical < 0 || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('nonce_canonical_state_invalid');
      if (nonce < canonical) throw new ChainNonceError('NONCE_CONFLICT', id);
      // An existing explicit-nonce sequence may queue behind our own acknowledged
      // signed attempts. It never guesses an unseen nonce on another device.
      for (let prior = canonical; prior < nonce; prior++) {
        const saved = index.attempts.find(a => a.nonce === prior);
        if (!saved) throw new ChainNonceError('NONCE_CONFLICT', id);
        const priorDoc = await readChainOperation(r.store, signerKey, saved.intent);
        if (operation(priorDoc).state !== 'submitted') throw new ChainNonceError('NONCE_BUSY', saved.intent, saved.hash);
      }
      // Do not replace our own unmined operation when a second local action starts.
      const blocking = index.attempts.find(a => a.nonce >= nonce && a.intent !== id);
      if (blocking) throw new ChainNonceError('NONCE_BUSY', blocking.intent, blocking.hash);
      r.assertApproved();
      const signed = await prepare(nonce);
      attempt = { ...signed, intent: id, ready: true };
      if (attempt.nonce !== nonce) throw new Error('nonce_signed_attempt_mismatch');
      r.validate(attempt);
      await r.store.transact(signerKey, current => ({ ...fence(current), next: nonce + 1,
        attempts: [...fence(current).attempts.filter(a => a.nonce >= canonical), attempt] }));
      doc = await r.store.transact(key, current => ({ ...current!, next: nonce + 1, attempts: [attempt],
        operation: { id, call, state: 'signed' } }));
    }
    // Fence and fresh action approval immediately before the only wire submission.
    await r.store.transact(signerKey, current => fence(current));
    r.assertApproved();
    try { await r.broadcast(attempt); }
    catch (error) {
      if (!/already known|already imported/i.test(String(error))) {
        let included: boolean;
        try { included = await r.included(attempt.hash); }
        catch { throw new ChainNonceError('SUBMISSION_UNCERTAIN', id, attempt.hash); }
        if (included) {
          await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'submitted' } }));
          return attempt;
        }
        const consumption = await r.resolveConsumption(attempt);
      if (consumption === 'own') {
        await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'submitted' } }));
        return attempt;
      }
      if (consumption === 'other') {
          await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'conflict' } }));
          throw new ChainNonceError('NONCE_CONFLICT', id, attempt.hash);
        }
        throw new ChainNonceError('SUBMISSION_UNCERTAIN', id, attempt.hash);
      }
    }
    await r.store.transact(key, current => ({ ...current!, operation: { id, call, state: 'submitted' } }));
    return attempt;
  } finally {
    if (held) await r.store.transact(signerKey, current => current?.owner === owner
      ? { ...current, owner: null, leaseUntil: 0 } : current!);
  }
}
export async function readChainOperation(store: NonceJournalStore, key: string, id: string): Promise<NonceJournal> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('chain_operation_id_invalid');
  return store.transact(`${key}_${id}`, current => {
    if (!current) throw new Error('chain_operation_not_found');
    operation(current); return current;
  });
}


export interface NonceConsumerBlock {
  readonly number: number; readonly hash: string;
  readonly transactions: readonly { readonly hash: string; readonly from: string; readonly nonce: number;
    readonly authorizations?: readonly { readonly authority: string; readonly nonce: number }[] }[];
}
/** Find the exact canonical consumer; a missing receipt is never a conflict proof. */
export async function resolveCanonicalNonceConsumption(port: {
  readonly head: () => Promise<number>;
  readonly count: (height: number) => Promise<number>;
  readonly block: (height: number, full: boolean) => Promise<NonceConsumerBlock | null>;
}, address: string, nonce: number, expectedHash: string): Promise<'own' | 'other' | 'unknown'> {
  const head = await port.head();
  if (!Number.isSafeInteger(head) || head < 11) return 'unknown';
  const safe = head - 11;
  const anchor = await port.block(safe, false);
  if (!anchor || anchor.number !== safe || await port.count(safe) <= nonce) return 'unknown';
  let low = 0, high = safe;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const count = await port.count(middle);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('nonce_canonical_state_invalid');
    if (count > nonce) high = middle; else low = middle + 1;
  }
  const block = await port.block(low, true);
  if (!block || block.number !== low || block.transactions.length === 0) return 'unknown';
  const consumer = block.transactions.find(tx => tx.from.toLowerCase() === address.toLowerCase() && tx.nonce === nonce);
  const authorized = block.transactions.some(tx => tx.authorizations?.some(a => a.authority.toLowerCase() === address.toLowerCase() && a.nonce === nonce));
  const [anchorNow, blockNow] = await Promise.all([port.block(safe, false), port.block(low, false)]);
  if (anchorNow?.hash !== anchor.hash || blockNow?.hash !== block.hash) return 'unknown';
  if (consumer) return consumer.hash.toLowerCase() === expectedHash.toLowerCase() ? 'own' : 'other';
  return authorized ? 'other' : 'unknown';
}
