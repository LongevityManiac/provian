import { randomUUID } from 'crypto';
import { Wallet, Transaction, keccak256, type Provider, type TransactionRequest, type TransactionResponse } from 'ethers';
import { assertServerWriterCutover } from './server-writer-cutover';
import { relayDb } from '../../firestore-db';
import { parseNonceJournal, sendWithCanonicalNonce, type SignedNonceAttempt, type NonceJournalStore } from './canonical-nonce';

export const NONCE_JOURNALS_COLLECTION = 'evm_signer_nonce_journals_v1';
const SETTLEMENT_LEASES = 'pvt9_settlement_signer_leases_v1';

/** Share the settlement signer's existing lock, including a crashed cycle's unresolved batches. */
export function firestoreNonceStore(signer: string): NonceJournalStore {
  const address = signer.toLowerCase();
  return {
    async transact(key, change) {
      const db = relayDb();
      const ref = db.collection(NONCE_JOURNALS_COLLECTION).doc(key);
      const leaseRef = db.collection(SETTLEMENT_LEASES).doc(address);
      return db.runTransaction(async (txn) => {
        const [snap, leaseSnap, cutover] = await Promise.all([txn.get(ref), txn.get(leaseRef),
          txn.get(db.collection('evm_server_writer_cutovers_v1').doc('base_canonical_nonce'))]);
        assertServerWriterCutover(cutover.data(), Date.now());
        const current = parseNonceJournal(snap.exists ? snap.data() : null);
        const lease = leaseSnap.data();
        const next = change(current);
        if (next.owner !== null) {
          if (next.owner === current?.owner && (lease?.owner !== next.owner || Number(lease.expires_at_ms) <= Date.now())) {
            throw new Error('nonce_settlement_lease_lost');
          }
          if (lease?.owner && lease.owner !== next.owner && Number(lease.expires_at_ms) > Date.now()) {
            throw new Error('nonce_settlement_signer_busy');
          }
          if (next.owner !== current?.owner) {
            const unresolved = await txn.get(db.collection('pvt9_settlement_batches_v1')
              .where('status', 'in', ['reserved', 'submitted', 'mined']));
            for (const batch of unresolved.docs) {
              const cycleId = batch.data().cycle_id;
              if (typeof cycleId !== 'string') throw new Error('nonce_settlement_batch_invalid');
              const cycle = await txn.get(db.collection('pvt9_settlement_cycles_v1').doc(cycleId));
              const cycleSigner = cycle.data()?.signer;
              if (!cycle.exists || typeof cycleSigner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(cycleSigner)) throw new Error('nonce_settlement_cycle_invalid');
              if (cycleSigner.toLowerCase() === address) throw new Error('nonce_unresolved_settlement_batch');
            }
          }
          txn.set(leaseRef, { signer: address, owner: next.owner, acquired_at_ms: Date.now(), expires_at_ms: next.leaseUntil });
        } else if (lease?.owner === current?.owner) {
          txn.set(leaseRef, { ...lease, expires_at_ms: 0 });
        }
        txn.set(ref, { ...next });
        return next;
      });
    },
  };
}

/** Server Wallet whose implicit ethers preparation cannot request pending state. */
export class CanonicalWallet extends Wallet {
  constructor(key: string, provider: Provider | null = null, private readonly journalStore?: NonceJournalStore) {
    super(key, provider);
  }
  override connect(provider: Provider | null): CanonicalWallet {
    return new CanonicalWallet(this.privateKey, provider, this.journalStore);
  }
  override async populateTransaction(tx: TransactionRequest): ReturnType<Wallet['populateTransaction']> {
    if (tx.nonce === undefined || tx.nonce === null) throw new Error('nonce_preparation_requires_reservation');
    return super.populateTransaction(tx);
  }
  async prepareCanonicalTransaction(tx: TransactionRequest, operationId: string): Promise<SignedNonceAttempt> {
    return (await this.coordinate(tx, true, undefined, operationId)).attempt;
  }
  async broadcastCanonicalTransaction(raw: string): Promise<void> {
    const decoded = Transaction.from(raw);
    if (!decoded.hash || decoded.from?.toLowerCase() !== this.address.toLowerCase()) throw new Error('nonce_attempt_binding_invalid');
    const receipt = await this.provider?.getTransactionReceipt(decoded.hash);
    if (receipt) return;
    // Acquire a fresh fenced owner before reading/recovering the old attempt.
    // Existing outboxes retain their exact bytes, including after a process crash.
    const originalOperation = `legacy_${decoded.hash.slice(2)}`;
    const result = await this.coordinate({ to: decoded.to, data: decoded.data, value: decoded.value,
      nonce: decoded.nonce, gasLimit: decoded.gasLimit, type: decoded.type, chainId: decoded.chainId,
      maxFeePerGas: decoded.maxFeePerGas, maxPriorityFeePerGas: decoded.maxPriorityFeePerGas }, false, decoded.hash, originalOperation, raw);
    if (result.attempt.hash !== decoded.hash) throw new Error('nonce_prepared_attempt_changed');
  }
  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const { attempt, response } = await this.coordinate(tx, false);
    if (response?.hash === attempt.hash) return response;
    const recovered = await this.provider!.getTransaction(attempt.hash);
    if (!recovered) throw new Error(`nonce_broadcast_uncertain:${attempt.hash}`);
    return recovered;
  }
  private async coordinate(tx: TransactionRequest, prepareOnly: boolean, expectedHash?: string, operationId?: string, preparedRaw?: string): Promise<{ attempt: SignedNonceAttempt; response: TransactionResponse | null }> {
    const provider = this.provider;
    if (!provider) throw new Error('nonce_provider_missing');
    const chainId = (await provider.getNetwork()).chainId;
    const key = `${chainId}_${this.address.toLowerCase()}`;
    const request = await this.populateCall(tx);
    const callFingerprint = keccak256(Transaction.from({ to: request.to, data: request.data, value: request.value,
      chainId, type: 2, nonce: 0, gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized);
    const intent = operationId ? `${operationId}:${callFingerprint}` : callFingerprint;
    let response: TransactionResponse | null = null;
    const attempt = await sendWithCanonicalNonce({
      store: this.journalStore ?? firestoreNonceStore(this.address), now: Date.now, owner: randomUUID,
      latestNonce: () => provider.getTransactionCount(this.address, 'latest'),
      finalizedNonce: async () => provider.getTransactionCount(this.address, Math.max(0, (await provider.getBlockNumber()) - 11)),
      canReplay: true,
      broadcast: async (a) => {
        const decoded = Transaction.from(a.raw);
        if (decoded.hash !== a.hash || decoded.from?.toLowerCase() !== this.address.toLowerCase()
          || decoded.chainId !== chainId || decoded.nonce !== a.nonce) throw new Error('nonce_attempt_binding_invalid');
        try { response = await provider.broadcastTransaction(a.raw); }
        catch (error) {
          if (!/already known|already imported/i.test(String(error))) throw error;
          response = await provider.getTransaction(a.hash);
          if (!response) throw new Error(`nonce_broadcast_uncertain:${a.hash}`);
        }
      },
    }, key, intent, async (nonce) => {
      if (preparedRaw) {
        const imported = Transaction.from(preparedRaw);
        if (imported.nonce !== nonce || imported.chainId !== chainId || imported.hash !== expectedHash
          || imported.from?.toLowerCase() !== this.address.toLowerCase()) throw new Error('nonce_legacy_attempt_binding_invalid');
        return { nonce, raw: preparedRaw, hash: keccak256(preparedRaw) };
      }
      const populated = await this.populateTransaction({ ...tx, nonce });
      const raw = await this.signTransaction(populated);
      return { nonce, raw, hash: keccak256(raw) };
    }, { nonce: tx.nonce === null ? undefined : tx.nonce, resumeSameIntent: expectedHash !== undefined, resumeHash: expectedHash, prepareOnly });
    return { attempt, response: response as TransactionResponse | null };
  }
}
