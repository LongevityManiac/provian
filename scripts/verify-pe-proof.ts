/**
 * verify-pe-proof.ts — standalone Provenance Envelope inclusion verifier.
 *
 * Verifies that a PE is anchored on Base using ON-CHAIN DATA ALONE — zero
 * trust in the Provian API. The proof bundle (the JSON that
 * GET /v1/pe/:id/proof returns) is treated as an untrusted CLAIM; every
 * binding fact is recomputed locally or read from the chain:
 *
 *   1. envelope hash   — recomputed from raw canonical envelope content when
 *                        --envelope is given (sha256 over stable-stringified
 *                        JSON, per docs/PE_PROTOCOL_SPEC.md Section 6), or
 *                        pinned via --envelope-hash
 *   2. leaf            — keccak256(0x00 || bytes32(envelope_hash))  [Section 13.1]
 *   3. batch id        — keccak256(0xFF || utf8(preimage))          [Section 13.4]
 *   4. root            — proof path folded with the sorted-pair 0x01 rule
 *                        [Section 13.3]
 *   5. on-chain root   — ProvianPEAnchor.getBatch(batchId) via your own RPC
 *   6. on-chain check  — ProvianPEAnchor.verifyPE(batchId, leaf, proof)
 *   7. anchor tx       — receipt exists, succeeded, and targeted the contract
 *
 * Usage (from the repo root; tsx resolves from provian-backend too):
 *   npx tsx scripts/verify-pe-proof.ts --proof proof.json
 *   curl -s https://api.provian.ai/v1/pe/<pe_id>/proof | npx tsx scripts/verify-pe-proof.ts --proof -
 *
 * Options:
 *   --proof <file|->        proof bundle JSON (required; '-' reads stdin)
 *   --rpc <url>             Base RPC URL (default: https://mainnet.base.org)
 *   --contract <0x…>        pin the PEAnchor address you independently trust
 *                           (reference/CONTRACT_VERSION_STATUS.md or BaseScan).
 *                           Without it the bundle's address is used — inclusion
 *                           is still cryptographically checked, but pin the
 *                           address for full zero-trust.
 *   --envelope <file>       raw canonical envelope content JSON; the envelope
 *                           hash is recomputed instead of trusted
 *   --envelope-hash <hex>   pin the envelope hash directly (64-char sha256 hex)
 *
 * Exit codes: 0 = proof valid, 1 = proof invalid, 2 = usage/input error.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Contract, JsonRpcProvider, concat, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';

// ---------------------------------------------------------------------------
// Untrusted input shape (the /proof response)
// ---------------------------------------------------------------------------

interface ProofBundle {
  pe_id?: string;
  envelope_hash?: string;
  anchored?: boolean;
  anchor?: {
    batch_id?: string;
    batch_id_preimage?: string;
    merkle_root?: string;
    pe_count?: number;
    anchor_tx_hash?: string | null;
    chain_id?: number;
    contract_address?: string;
    day?: string;
    kind?: string;
  };
  leaf?: { leaf_index?: number; leaf_value?: string };
  merkle_proof?: string[];
}

const PE_ANCHOR_ABI = [
  'function getBatch(bytes32 batchId) view returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
  'function verifyPE(bytes32 batchId, bytes32 peHash, bytes32[] merkleProof) view returns (bool)',
];

// ---------------------------------------------------------------------------
// Local crypto (the Section 13 rules, reimplemented — nothing imported from
// the Provian backend, so this file is a genuinely independent check)
// ---------------------------------------------------------------------------

/**
 * Minimal stable stringify matching json-stable-stringify for plain JSON
 * data: recursively sorted object keys, no whitespace, undefined object
 * values skipped, undefined array slots serialized as null.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${parts.join(',')}}`;
}

function sha256HexOf(utf8: string): string {
  return createHash('sha256').update(utf8, 'utf8').digest('hex');
}

function normalizeEnvelopeHash(hash: string): string {
  const stripped = hash.startsWith('0x') || hash.startsWith('0X') ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(`envelope hash must be 32-byte hex, got: ${hash}`);
  }
  return `0x${stripped.toLowerCase()}`;
}

/** Section 13.1 — leaf = keccak256(0x00 || bytes32(envelope_sha256)) */
function computeLeaf(envelopeHash: string): string {
  return keccak256(solidityPacked(['bytes1', 'bytes32'], ['0x00', normalizeEnvelopeHash(envelopeHash)]));
}

/** Section 13.4 — batch_id = keccak256(0xFF || utf8(preimage)) */
function computeBatchIdFromPreimage(preimage: string): string {
  return keccak256(concat(['0xff', toUtf8Bytes(preimage)]));
}

/** Section 13.3 — fold the proof path with sorted pairs under the 0x01 tag. */
function foldProof(leaf: string, proof: string[]): string {
  let computed = leaf;
  for (const sibling of proof) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(sibling)) throw new Error(`malformed proof element: ${sibling}`);
    computed = computed <= sibling
      ? keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', computed, sibling]))
      : keccak256(solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', sibling, computed]));
  }
  return computed;
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args.set(a.slice(2), 'true');
    } else {
      args.set(a.slice(2), value);
      i++;
    }
  }
  return args;
}

function readInput(pathOrDash: string): string {
  if (pathOrDash === '-') return readFileSync(0, 'utf8');
  return readFileSync(pathOrDash, 'utf8');
}

interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

function report(line: CheckLine): boolean {
  const mark = line.ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${line.name}: ${line.detail}`);
  return line.ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const proofPath = args.get('proof');
  if (!proofPath) {
    console.error('Usage: npx tsx scripts/verify-pe-proof.ts --proof <proof.json|-> [--rpc <url>] [--contract <0x…>] [--envelope <file>] [--envelope-hash <hex>]');
    return 2;
  }

  let bundle: ProofBundle;
  try {
    bundle = JSON.parse(readInput(proofPath)) as ProofBundle;
  } catch (err) {
    console.error(`Could not read/parse proof bundle: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (bundle.anchored === false) {
    console.error('Bundle says anchored:false — nothing to verify yet (the PE\'s UTC day has not been anchored).');
    return 2;
  }
  if (!bundle.anchor || !Array.isArray(bundle.merkle_proof)) {
    console.error('Bundle is missing anchor/merkle_proof fields — not a /v1/pe/:id/proof response?');
    return 2;
  }

  // ── 1. Envelope hash: recompute > pinned > claimed.
  let envelopeHash: string;
  let hashSource: string;
  const envelopePath = args.get('envelope');
  const pinnedHash = args.get('envelope-hash');
  if (envelopePath) {
    const raw: unknown = JSON.parse(readInput(envelopePath));
    envelopeHash = sha256HexOf(stableStringify(raw));
    hashSource = `recomputed from ${envelopePath} (sha256 over stable-stringified canonical content)`;
  } else if (pinnedHash) {
    envelopeHash = pinnedHash;
    hashSource = 'pinned via --envelope-hash';
  } else {
    if (typeof bundle.envelope_hash !== 'string') {
      console.error('Bundle has no envelope_hash and neither --envelope nor --envelope-hash was given.');
      return 2;
    }
    envelopeHash = bundle.envelope_hash;
    hashSource = 'taken from the bundle (pass --envelope or --envelope-hash to remove this trust)';
  }

  const rpcUrl = args.get('rpc') ?? 'https://mainnet.base.org';
  const contractAddress = args.get('contract') ?? bundle.anchor.contract_address;
  if (!contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
    console.error(`No usable PEAnchor address (got: ${String(contractAddress)}). Pass --contract.`);
    return 2;
  }
  const contractPinned = args.has('contract');

  console.log('Provian PE inclusion verifier (zero API trust)');
  console.log(`  PE:            ${bundle.pe_id ?? '(unknown id)'}`);
  console.log(`  Envelope hash: ${envelopeHash} — ${hashSource}`);
  console.log(`  Contract:      ${contractAddress}${contractPinned ? ' (pinned by caller)' : ' (FROM BUNDLE — pass --contract to pin independently)'}`);
  console.log(`  RPC:           ${rpcUrl}`);
  console.log('');

  let allOk = true;

  // ── 2. Leaf recomputation.
  const leaf = computeLeaf(envelopeHash);
  if (typeof bundle.leaf?.leaf_value === 'string') {
    allOk = report({
      name: 'leaf matches bundle claim',
      ok: leaf === bundle.leaf.leaf_value.toLowerCase(),
      detail: leaf,
    }) && allOk;
  } else {
    console.log(`  [info] leaf (recomputed): ${leaf}`);
  }

  // ── 3. Batch id recomputation from its documented preimage.
  const claimedBatchId = bundle.anchor.batch_id;
  if (typeof claimedBatchId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(claimedBatchId)) {
    console.error('Bundle anchor.batch_id is missing/malformed.');
    return 2;
  }
  if (typeof bundle.anchor.batch_id_preimage === 'string') {
    allOk = report({
      name: 'batch id matches keccak256(0xFF || utf8(preimage))',
      ok: computeBatchIdFromPreimage(bundle.anchor.batch_id_preimage) === claimedBatchId.toLowerCase(),
      detail: `${bundle.anchor.batch_id_preimage} -> ${claimedBatchId}`,
    }) && allOk;
  }

  // ── 4. Fold the proof path locally.
  const computedRoot = foldProof(leaf, bundle.merkle_proof);
  console.log(`  [info] locally computed root: ${computedRoot}`);

  // ── 5/6. Chain reads — the trust anchor.
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (typeof bundle.anchor.chain_id === 'number' && bundle.anchor.chain_id !== 0) {
    allOk = report({
      name: 'RPC chain id matches bundle claim',
      ok: Number(network.chainId) === bundle.anchor.chain_id,
      detail: `rpc=${network.chainId} bundle=${bundle.anchor.chain_id}`,
    }) && allOk;
  } else {
    console.log(`  [info] RPC chain id: ${network.chainId}`);
  }

  const anchor = new Contract(contractAddress, PE_ANCHOR_ABI, provider);
  const batch = (await anchor.getBatch(claimedBatchId)) as unknown as [string, bigint, bigint, bigint, boolean];
  allOk = report({
    name: 'batch exists on-chain',
    ok: Boolean(batch[4]),
    detail: `getBatch(${claimedBatchId}).exists=${String(batch[4])}, peCount=${batch[1]}`,
  }) && allOk;

  const onChainRoot = String(batch[0]).toLowerCase();
  allOk = report({
    name: 'locally computed root equals ON-CHAIN root',
    ok: onChainRoot === computedRoot.toLowerCase(),
    detail: `on-chain=${onChainRoot}`,
  }) && allOk;

  // An RPC failure is NOT a false verdict (public endpoints throttle bursts)
  // — retry once, and if it still errors, say ERROR loudly instead of "false".
  let verifyPEOk = false;
  let verifyPEError: string | null = null;
  try {
    verifyPEOk = Boolean(await anchor.verifyPE(claimedBatchId, leaf, bundle.merkle_proof));
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      verifyPEOk = Boolean(await anchor.verifyPE(claimedBatchId, leaf, bundle.merkle_proof));
    } catch (err) {
      verifyPEError = err instanceof Error ? err.message.slice(0, 160) : String(err);
    }
  }
  allOk = report({
    name: 'contract verifyPE(batchId, leaf, proof)',
    ok: verifyPEOk,
    detail: verifyPEError
      ? `RPC ERROR (not a false verdict — retry with a dedicated RPC): ${verifyPEError}`
      : String(verifyPEOk),
  }) && allOk;

  // ── 7. Anchor tx receipt (informational binding to a public transaction).
  const txHash = bundle.anchor.anchor_tx_hash;
  if (typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const receipt = await provider.getTransactionReceipt(txHash);
    const toOk = Boolean(receipt && receipt.to && receipt.to.toLowerCase() === contractAddress.toLowerCase());
    allOk = report({
      name: 'anchor tx exists, succeeded, and targeted the contract',
      ok: Boolean(receipt && receipt.status === 1 && toOk),
      detail: receipt ? `status=${receipt.status} to=${receipt.to}` : 'receipt not found',
    }) && allOk;
    console.log(`  [link] https://basescan.org/tx/${txHash}`);
  } else {
    console.log('  [info] bundle carries no anchor_tx_hash (anchored root is still fully verified above)');
  }
  console.log(`  [link] https://basescan.org/address/${contractAddress}#readContract`);

  console.log('');
  console.log(allOk ? 'RESULT: PROOF VALID — this PE is anchored on Base.' : 'RESULT: PROOF INVALID.');
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Verifier error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
