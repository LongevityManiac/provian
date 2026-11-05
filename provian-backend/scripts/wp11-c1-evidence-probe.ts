/**
 * the C1 evidence, RE-DERIVED LIVE instead of remembered.
 *
 * `C1_SCOPE_EVIDENCE` (wp11/cutover-scope-exclusions.ts) and
 * `DOCUMENT_MINT_BINDINGS` (wp11/legacy-mint-contract-registry.ts) were hand
 * gathered 2026-07-24 and have been cited since. A hand enumeration is correct
 * on the day it is made; this probe makes the claim reproducible: every pinned
 * fact about the five C1 documents is re-read from live Base mainnet and live
 * Firestore, and any drift fails the run by name.
 *
 * Read-only end to end: eth_getTransactionReceipt / eth_call / totalSupply on
 * chain, document + query reads in Firestore. No key, no write, no transaction.
 *
 * Per document, this confirms:
 * 1. the two pinned tables agree with each other (tx hash + contract);
 * 2. the mint transaction receipt: status 1, `to` = the pinned contract,
 * the pinned block, and the contract among the log emitters;
 * 3. `batchMinted(document_id)` is TRUE on that contract — read through the
 * production registry-bound reader (same decode, same refusal rules);
 * 4. the contract's live `totalSupply()` equals the registry pin;
 * 5. Firestore: the document's batch/snapshot presence matches its kind,
 * `pe_history` rows bound via `mint_batch_id` match the pinned count, and
 * no `genesis_wallet_ledger` doc references the document id.
 *
 * Exit 0 = every pinned fact re-confirmed (the C1 evidence is CURRENT).
 * Exit 1 = drift, named. The comparator is exported pure so the suite can feed
 * it a violating observation (a probe that can only pass proves nothing).
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { C1_SCOPE_EVIDENCE } from '../src/core/pvt/wp11/cutover-scope-exclusions';
import {
  DOCUMENT_MINT_BINDINGS,
  LEGACY_MINT_CONTRACT_REGISTRY,
} from '../src/core/pvt/wp11/legacy-mint-contract-registry';
import {
  makeJsonRpcTransport,
  makeRegistryBoundBatchMintedReader,
} from '../src/core/pvt/wp11/legacy-batch-minted-reader';
import { scriptDb } from './lib/script-db';

export interface C1LiveObservation {
  readonly document_id: string;
  readonly receipt_status_ok: boolean;
  readonly receipt_to: string | null;
  readonly receipt_block: number | null;
  readonly receipt_log_emitters: readonly string[];
  readonly batch_minted: boolean;
  readonly batch_doc_exists: boolean;
  readonly snapshot_doc_exists: boolean;
  readonly bound_pe_count: number;
  readonly wallet_ledger_references: readonly string[];
}

export interface C1EvidenceMismatch {
  readonly document_id: string;
  readonly field: string;
  readonly pinned: string;
  readonly observed: string;
}

/**
 * Compare one document's pinned evidence against a live observation. Pure and
 * total — the suite feeds it violating observations to prove it can fail.
 */
export function compareC1Evidence(observation: C1LiveObservation): readonly C1EvidenceMismatch[] {
  const evidence = C1_SCOPE_EVIDENCE.find((row) => row.document_id === observation.document_id);
  const binding = DOCUMENT_MINT_BINDINGS.find((row) => row.document_id === observation.document_id);
  if (evidence === undefined || binding === undefined) {
    return [{
      document_id: observation.document_id,
      field: 'pinned_tables',
      pinned: `evidence=${evidence !== undefined} binding=${binding !== undefined}`,
      observed: 'a document outside both pinned tables cannot be judged',
    }];
  }
  const mismatches: C1EvidenceMismatch[] = [];
  const push = (field: string, pinned: string, observed: string): void => {
    if (pinned.toLowerCase() !== observed.toLowerCase()) {
      mismatches.push({ document_id: observation.document_id, field, pinned, observed });
    }
  };
  // 1 — the two tables agree with each other.
  push('tables.mint_tx_hash', evidence.recorded_mint_tx_hash ?? 'null', binding.mint_tx_hash);
  push('tables.contract', evidence.minted_against_contract, binding.mint_contract_address);
  // 2 — the receipt.
  push('receipt.status', 'true', String(observation.receipt_status_ok));
  push('receipt.to', binding.mint_contract_address, observation.receipt_to ?? 'null');
  push('receipt.block', String(binding.mint_block), String(observation.receipt_block ?? 'null'));
  const emitted = observation.receipt_log_emitters
    .some((address) => address.toLowerCase() === binding.mint_contract_address.toLowerCase());
  push('receipt.log_emitter', 'true', String(emitted));
  // 3 — batchMinted on the correct contract.
  push('chain.batch_minted', String(evidence.batch_minted_on_correct_contract),
    String(observation.batch_minted));
  // 5 — Firestore shape.
  const expectBatch = evidence.kind === 'batch_without_snapshot';
  push('firestore.batch_doc_exists', String(expectBatch), String(observation.batch_doc_exists));
  push('firestore.snapshot_doc_exists', String(!expectBatch), String(observation.snapshot_doc_exists));
  push('firestore.bound_pe_count', String(evidence.bound_pe_count), String(observation.bound_pe_count));
  push('firestore.wallet_ledger_references',
    `[${evidence.wallet_ledger_references.join(',')}]`,
    `[${observation.wallet_ledger_references.join(',')}]`);
  return mismatches;
}

interface JsonRpcReceipt {
  status?: string;
  to?: string;
  blockNumber?: string;
  logs?: Array<{ address?: string }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The public Base RPC rate-limits bursts (429 surfaces mid-run — the STATUS.md
 * known-false-failure). Retrying a rate limit is pacing, not answer-coercion:
 * a still-failing call after the retries THROWS, never returns a default.
 */
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`${method} error: ${body.error.message ?? 'unknown'}`);
    if (body.result === undefined || body.result === null) throw new Error(`${method}: empty result`);
    return body.result;
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const db = scriptDb();
  // Same production transport, wrapped with 429 pacing (retries then throws —
  // a rate limit is never converted into an answer).
  const baseTransport = makeJsonRpcTransport({ 8453: rpcUrl });
  const reader = makeRegistryBoundBatchMintedReader({
    async ethCall(chainId, to, data) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await baseTransport.ethCall(chainId, to, data);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt < 5 && message.includes('429')) {
            await sleep(2_000 * (attempt + 1));
            continue;
          }
          throw error;
        }
      }
    },
  });

  // 4 — live totalSupply per pinned-supply contract (the value-persistence claim).
  for (const row of LEGACY_MINT_CONTRACT_REGISTRY) {
    if (row.chain_id !== 8453 || row.total_supply_atomic === '0') continue;
    const word = await rpc<string>(rpcUrl, 'eth_call', [
      { to: row.address, data: '0x18160ddd' }, 'latest',
    ]);
    const live = BigInt(word).toString();
    if (live !== row.total_supply_atomic) {
      console.error(`SUPPLY DRIFT ${row.address}: pinned ${row.total_supply_atomic}, live ${live}`);
      process.exit(1);
    }
    console.log(`supply CONFIRMED ${row.address} (${row.source_version}): ${live} atomic`);
  }

  let failed = false;
  for (const binding of DOCUMENT_MINT_BINDINGS) {
    await sleep(1_500); // pace the public RPC between documents
    const receipt = await rpc<JsonRpcReceipt>(rpcUrl, 'eth_getTransactionReceipt', [binding.mint_tx_hash]);
    const [batchSnap, snapshotSnap, boundPes] = await Promise.all([
      db.collection('pvt_mint_batches').doc(binding.document_id).get(),
      db.collection('pvt_mint_batch_snapshots').doc(binding.document_id).get(),
      db.collection('pe_history').where('mint_batch_id', '==', binding.document_id).get(),
    ]);
    const ledgerSnap = await db.collection('genesis_wallet_ledger').get();
    const ledgerRefs = ledgerSnap.docs
      .filter((doc) => JSON.stringify(doc.data() ?? {}).toLowerCase()
        .includes(binding.document_id.toLowerCase()))
      .map((doc) => doc.id);

    const observation: C1LiveObservation = {
      document_id: binding.document_id,
      receipt_status_ok: receipt.status === '0x1',
      receipt_to: receipt.to ?? null,
      receipt_block: receipt.blockNumber === undefined ? null : Number(BigInt(receipt.blockNumber)),
      receipt_log_emitters: (receipt.logs ?? []).map((log) => log.address ?? ''),
      batch_minted: await reader.readBatchMinted(binding.document_id),
      batch_doc_exists: batchSnap.exists,
      snapshot_doc_exists: snapshotSnap.exists,
      bound_pe_count: boundPes.size,
      wallet_ledger_references: ledgerRefs,
    };
    const mismatches = compareC1Evidence(observation);
    if (mismatches.length === 0) {
      console.log(`CONFIRMED ${binding.document_id.slice(0, 12)}… — every pinned fact re-derived live`);
    } else {
      failed = true;
      for (const m of mismatches) {
        console.error(`DRIFT ${m.document_id.slice(0, 12)}… ${m.field}: pinned=${m.pinned} observed=${m.observed}`);
      }
    }
  }
  console.log(failed
    ? 'C1 EVIDENCE DRIFTED — the pinned tables no longer describe the live world'
    : 'C1 EVIDENCE CURRENT — 5/5 documents re-confirmed against live Base + live Firestore');
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[wp11-c1-evidence-probe] failed:', err);
    process.exit(1);
  });
}
