/** The Solana surface the facilitator needs (interface for tests; @x402/svm's signer + @solana/kit RPC for real). */
import {
  address as toAddress,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signature as toSignature,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { toFacilitatorSvmSigner, TransactionOnchainFailureError, type FacilitatorSvmSigner } from '@x402/svm';
import { PYTH_SOL_USD_PRICE_ACCOUNT, SOLANA_NETWORK, SOLANA_USDC_DECIMALS, SOLANA_USDC_MINT } from '../constants.js';
import { parsePythPriceUpdate, type SolPrice } from './price.js';

export type ConfirmOutcome = 'confirmed' | 'failed';
/** A non-waiting status read: `not_found` = the cluster knows no such transaction (yet). */
export type SignatureStatus = 'confirmed' | 'failed' | 'pending' | 'not_found';

export interface SolanaChain {
  readonly feePayer: string;
  simulate(transactionBase64: string): Promise<void>;
  /**
   * Co-sign as fee payer WITHOUT broadcasting: the transaction id is the fee payer's signature, so it
   * is known (and recorded) before anything reaches the network (M2, fix run 2026-10-24).
   */
  sign(transactionBase64: string): Promise<{ readonly signature: string; readonly signed: string }>;
  /** Broadcast a signed transaction. A throw is an UNKNOWN outcome: the node may have accepted it. */
  send(signedBase64: string): Promise<void>;
  /** One status lookup (with history), never a wait. Throws when the lookup itself fails. */
  signatureStatus(signature: string): Promise<SignatureStatus>;
  /** 'failed' = landed and failed; throws when the outcome is unknown (timeout). */
  confirm(signature: string): Promise<ConfirmOutcome>;
  solUsd(maxAgeSeconds: number): Promise<SolPrice>;
  lamports(owner: string): Promise<bigint>;
  /** Balance of `owner`'s USDC-style ATA for `mint` (0n when the account does not exist). */
  tokenBalance(owner: string, mint: string): Promise<bigint>;
  /** For refill/sweep: sign (as the gas wallet, the only signer) and send a fully built transaction. */
  signAndSendOwn(transactionBase64: string): Promise<string>;
  /** Sweep: transferChecked `amount` USDC from the gas wallet's USDC account to `destOwner`'s (which must exist). */
  sendUsdc(destOwner: string, amount: bigint): Promise<string>;
  ataExists(owner: string, mint: string): Promise<boolean>;
  /** One-time setup: create the gas wallet's own USDC account (the fee destination) if absent. */
  ensureOwnUsdcAccount(): Promise<{ created: boolean; signature: string | null }>;
  readonly keypair: KeyPairSigner;
  readonly rpcUrl: string;
}

export async function createKitSolanaChain(opts: { rpcUrl: string; keypairBytes: Uint8Array }): Promise<SolanaChain> {
  const keypair = await createKeyPairSignerFromBytes(opts.keypairBytes);
  const rpc = createSolanaRpc(opts.rpcUrl);
  const signer: FacilitatorSvmSigner = toFacilitatorSvmSigner(keypair, { defaultRpcUrl: opts.rpcUrl });
  const feePayer = keypair.address.toString();
  return {
    feePayer,
    keypair,
    rpcUrl: opts.rpcUrl,
    async simulate(tx) {
      await signer.simulateTransaction(tx, SOLANA_NETWORK);
    },
    async sign(tx) {
      const signed = await signer.signTransaction(tx, toAddress(feePayer), SOLANA_NETWORK);
      const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(signed)));
      return { signature: signature.toString(), signed };
    },
    async send(signed) {
      await signer.sendTransaction(signed, SOLANA_NETWORK);
    },
    async signatureStatus(sig) {
      const r = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      const entry = r.value[0];
      if (!entry) return 'not_found';
      if (entry.confirmationStatus === 'confirmed' || entry.confirmationStatus === 'finalized') {
        return entry.err ? 'failed' : 'confirmed';
      }
      return 'pending';
    },
    async confirm(signature) {
      try {
        await signer.confirmTransaction(signature, SOLANA_NETWORK);
        return 'confirmed';
      } catch (err) {
        if (err instanceof TransactionOnchainFailureError) return 'failed';
        throw err;
      }
    },
    async solUsd(maxAgeSeconds) {
      const info = await rpc.getAccountInfo(toAddress(PYTH_SOL_USD_PRICE_ACCOUNT), { encoding: 'base64', commitment: 'confirmed' }).send();
      const value = info.value;
      if (!value) throw new Error('SOL/USD price account missing');
      const data = getBase64Encoder().encode(value.data[0]);
      return parsePythPriceUpdate(value.owner.toString(), new Uint8Array(data), Math.floor(Date.now() / 1000), maxAgeSeconds);
    },
    async lamports(owner) {
      const r = await rpc.getBalance(toAddress(owner), { commitment: 'confirmed' }).send();
      return BigInt(r.value);
    },
    async tokenBalance(owner, mint) {
      const [ata] = await findAssociatedTokenPda({ mint: toAddress(mint), owner: toAddress(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      try {
        const r = await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send();
        return BigInt(r.value.amount);
      } catch {
        return 0n;
      }
    },
    async signAndSendOwn(tx) {
      const signed = await signer.signTransaction(tx, toAddress(feePayer), SOLANA_NETWORK);
      return signer.sendTransaction(signed, SOLANA_NETWORK);
    },
    async ataExists(owner, mint) {
      const [ata] = await findAssociatedTokenPda({ mint: toAddress(mint), owner: toAddress(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const info = await rpc.getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' }).send();
      return info.value !== null;
    },
    async ensureOwnUsdcAccount() {
      const mint = toAddress(SOLANA_USDC_MINT);
      const [ata] = await findAssociatedTokenPda({ mint, owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const existing = await rpc.getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' }).send();
      if (existing.value !== null) return { created: false, signature: null };
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: keypair, owner: keypair.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keypair, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions([ix], m),
      );
      const signed = await signTransactionMessageWithSigners(message);
      const signature = await signer.sendTransaction(getBase64EncodedWireTransaction(signed), SOLANA_NETWORK);
      await signer.confirmTransaction(signature, SOLANA_NETWORK);
      return { created: true, signature };
    },
    async sendUsdc(destOwner, amount) {
      const mint = toAddress(SOLANA_USDC_MINT);
      const [source] = await findAssociatedTokenPda({ mint, owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const [destination] = await findAssociatedTokenPda({ mint, owner: toAddress(destOwner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keypair, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) =>
          appendTransactionMessageInstructions(
            [getTransferCheckedInstruction({ source, mint, destination, authority: keypair, amount, decimals: SOLANA_USDC_DECIMALS })],
            m,
          ),
      );
      const signed = await signTransactionMessageWithSigners(message);
      return signer.sendTransaction(getBase64EncodedWireTransaction(signed), SOLANA_NETWORK);
    },
  };
}
