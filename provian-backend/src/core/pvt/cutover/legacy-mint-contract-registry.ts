/**
 * the legacy PVT mint-contract registry.
 *
 * WHY THIS EXISTS. 's C11 chain reader bound the CURRENT PVTv8 token
 * unconditionally and asked it `batchMinted(bytes32)` about documents that were
 * never PVTv8 batches. Every answer was `false`, and a `false` from a contract
 * a batch was never minted against is SILENCE, not a negative. This registry is
 * what makes the question answerable: it maps a legacy mint document to the
 * exact contract its value actually attached to.
 *
 * PROVENANCE — every row was built from ON-CHAIN EVIDENCE plus
 * `contracts/deployments/*`, never from documentation prose and never from
 * memory. Specifically, on 2026-07-24:
 * - `deployment_tx`, where recorded, was confirmed by
 * `eth_getTransactionReceipt.contractAddress === address`.
 * - `creation_block` was established by binary search over `eth_getCode`
 * where no deployment tx is recorded in the artifacts (public RPC state
 * pruning prevented this for four Arbitrum/Optimism rows — recorded null).
 * - `runtime_code_sha256_16` is a digest over the LIVE runtime bytecode, so
 * two rows sharing it are provably the same deployed build.
 * - `total_supply_atomic` is a live `totalSupply()` read.
 * The document→contract bindings in `DOCUMENT_MINT_BINDINGS` were resolved from
 * each document's own recorded mint transaction receipt (`to` plus the log
 * emitter), NOT from any field a document asserts about itself.
 *
 * NOTHING HERE WRITES, MINTS, SETTLES, OR GRANTS AUTHORITY. It is a frozen data
 * table plus two lookups.
 */

/** Chains PVT was ever deployed to. */
export type LegacyMintChainId = 8453 | 42161 | 10;

/**
 * The source version a deployed address corresponds to.
 *
 * `UNIDENTIFIED` is a FINDING, not a footnote: it means an address that PVT was
 * or could have been minted against cannot be tied to a known source version.
 * The registry ships with none, and any future row that earns it must be
 * reported rather than absorbed.
 */
export type LegacyPvtSourceVersion =
  | 'PVTv2'
  | 'PVTv3'
  | 'PVTv4'
  | 'PVTv5'
  | 'PVTv6'
  | 'PVTv7'
  | 'PVTv8'
  | 'PVT_phase3'
  | 'UNIDENTIFIED';

export interface LegacyMintContractRow {
  /** Checksummed address exactly as recorded in the deployment artifact. */
  readonly address: string;
  readonly chain_id: LegacyMintChainId;
  /** Deployment transaction, where an artifact records one AND the receipt confirmed it. */
  readonly deployment_tx: string | null;
  /** Creation block: from the confirmed deploy receipt, or binary search over eth_getCode. */
  readonly creation_block: number | null;
  readonly source_version: LegacyPvtSourceVersion;
  /** The deployment artifacts this address appears in (evidence trail). */
  readonly artifact_sources: readonly string[];
  /** First 16 hex chars of sha256 over the LIVE runtime bytecode. */
  readonly runtime_code_sha256_16: string;
  readonly runtime_code_bytes: number;
  /** Live `totalSupply()` at 2026-07-24, atomic. Non-zero ⇒ value attached here. */
  readonly total_supply_atomic: string;
  /** Whether `batchMinted(bytes32)` returns a decodable bool word. */
  readonly exposes_batch_minted: boolean;
  /**
   * Inclusive UTC date range of mints observed against this contract by the C1
   * document set, or null where this registry observed no mint against it.
   * Absence of an observed mint is NOT proof no mint exists — it is the range
   * this evidence pass established, stated as such.
   */
  readonly observed_mint_range_utc: readonly [string, string] | null;
  /** Superseded by a later PVT deployment on the same chain. */
  readonly retired: boolean;
}

/**
 * Every PVT token contract recorded in `contracts/deployments/*`, verified live
 * on 2026-07-24. Sorted by chain then address.
 *
 * Base carries the only non-zero supplies; every Arbitrum and Optimism PVT
 * deployment reads `totalSupply() == 0`, which is the on-chain form of the
 * Base-only consolidation — those chains were deployed to but never minted on.
 */
export const LEGACY_MINT_CONTRACT_REGISTRY: readonly LegacyMintContractRow[] = [
  // ---------------------------------------------------------------- Base 8453
  {
    address: '0x871F0ff4934A2d1616B12E4EcAa61F91d0eE9194',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 42779056,
    source_version: 'PVT_phase3',
    artifact_sources: ['base-phase3.json/contracts/pvt'],
    runtime_code_sha256_16: '3725b7af714f8430',
    runtime_code_bytes: 4259,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x29Dc70947E94b7Ab423ADd2b1e31DDbe925868C9',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 42904334,
    source_version: 'PVTv2',
    artifact_sources: ['base-pvt-day-one.json/contracts/pvtV2'],
    runtime_code_sha256_16: '1d6645ebf01367ba',
    runtime_code_bytes: 7004,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    // 33.2 PVT live. Batch 0xc1ffc748… minted here (tx 0x4c06566c…, block 44394882).
    address: '0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 43292555,
    source_version: 'PVTv3',
    artifact_sources: [
      'base-pvt-v3.json/contracts/pvtV3',
      'base-foundation-membership.json/config/pvt',
    ],
    runtime_code_sha256_16: '2aa598b645e89ddf',
    runtime_code_bytes: 10290,
    total_supply_atomic: '33200000000000000000',
    exposes_batch_minted: true,
    observed_mint_range_utc: ['2026-05-04', '2026-05-04'],
    retired: true,
  },
  {
    address: '0xc3bd53E9a524f0c19ECb01e3eDbd67bE37442e8d',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 45089927,
    source_version: 'PVTv3',
    artifact_sources: ['base-sprint.json/contracts/pvtV3'],
    runtime_code_sha256_16: '57b6534e7568d346',
    runtime_code_bytes: 10477,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x539Ae0e36fBb1a63F4B5a5167425Ff6ddbB0a369',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 45100627,
    source_version: 'PVTv3',
    artifact_sources: [
      'base-sprint-fixes.json/contracts/pvtV3',
      'base-agent-bank-v4.json/config/pvt',
    ],
    runtime_code_sha256_16: '57b6534e7568d346',
    runtime_code_bytes: 10477,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    // 27.4 PVT live. Batch 0x1b730f3b… minted here (tx 0xcace2eb4…, block 45553349).
    address: '0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 45449039,
    source_version: 'PVTv4',
    artifact_sources: ['base-pvt-v4.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'bbad1fd2f05493ef',
    runtime_code_bytes: 16199,
    total_supply_atomic: '27400000000000000000',
    exposes_batch_minted: true,
    observed_mint_range_utc: ['2026-04-07', '2026-04-07'],
    retired: true,
  },
  {
    address: '0x62435696D4B5855990E1698291CC2084A03f957A',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 45710708,
    source_version: 'PVTv4',
    artifact_sources: ['base-chunk-i.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'd493eaa043d24798',
    runtime_code_bytes: 16482,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    // 10.6 PVT live. The three orphan snapshots minted here.
    address: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    chain_id: 8453,
    deployment_tx: '0x249da0145c6c109e4c7eaa7bbeffbb622c8283bbc55b9f419ad6f3ca3d811b80',
    creation_block: 45750803,
    source_version: 'PVTv4',
    artifact_sources: ['base-chunk-ii.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'cd51174cb5963a98',
    runtime_code_bytes: 16482,
    total_supply_atomic: '10600000000000000000',
    exposes_batch_minted: true,
    observed_mint_range_utc: ['2026-05-09', '2026-06-11'],
    retired: true,
  },
  {
    address: '0x27DE46B4974D47a760823b8eB4b06ae5C3D36Dc0',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 47727629,
    source_version: 'PVTv5',
    artifact_sources: ['base-pvt-v5.json/contracts/pvtV5', 'base-pvt-v6.json/retired/pvtV5'],
    runtime_code_sha256_16: 'b4b6c01408c4bfe3',
    runtime_code_bytes: 15031,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0xf5E75Cc0C8Ae22087121521776eD2949379517b0',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 47745864,
    source_version: 'PVTv6',
    artifact_sources: ['base-pvt-v6.json/contracts/pvtV6', 'base-pvt-v7.json/retired/pvtV6'],
    runtime_code_sha256_16: '50234238fe1b7387',
    runtime_code_bytes: 15371,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x33Ef8926A473b19330fe1525078c90790b9D2Aa9',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 47829054,
    source_version: 'PVTv7',
    artifact_sources: [
      'base-pvt-v7.json/contracts/pvtV7',
      'base-pvt-v8.json/retired/pvtV7',
      'base-bondcourt-redeploy.json/reused/pvtV7',
    ],
    runtime_code_sha256_16: '4fa6c325437aad95',
    runtime_code_bytes: 15371,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    // The CURRENT legacy token. Zero supply: nothing was ever minted on PVTv8,
    // which is exactly why 's unconditional binding could only say `false`.
    address: '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa',
    chain_id: 8453,
    deployment_tx: null,
    creation_block: 47870182,
    source_version: 'PVTv8',
    artifact_sources: [
      'base-pvt-v8.json/contracts/pvtV8',
      'base-pass3-redeploy.json/reused/pvtV8',
    ],
    runtime_code_sha256_16: '53473a8c7ffa4d66',
    runtime_code_bytes: 15371,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: false,
  },
  // ------------------------------------------------------------ Arbitrum 42161
  {
    address: '0x411dAcE53Ad2236e9ed1E5318822f750Aa2229E1',
    chain_id: 42161,
    deployment_tx: null,
    creation_block: null,
    source_version: 'PVTv2',
    artifact_sources: ['arbitrum-pvt-day-one.json/contracts/pvtV2'],
    runtime_code_sha256_16: '1d6645ebf01367ba',
    runtime_code_bytes: 7004,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x1A3Efca7f3000c59F7509f565d707B755B078664',
    chain_id: 42161,
    deployment_tx: null,
    creation_block: null,
    source_version: 'PVTv3',
    artifact_sources: [
      'arbitrum-pvt-v3.json/contracts/pvtV3',
      'arbitrum-agent-bank-v4.json/config/pvt',
      'arbitrum-bond-pool.json/wiring/pvtContract',
      'arbitrum-foundation-membership.json/config/pvt',
    ],
    runtime_code_sha256_16: '2aa598b645e89ddf',
    runtime_code_bytes: 10290,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x92099F2eF928239A89F2A29dAd5D66F7412002A7',
    chain_id: 42161,
    deployment_tx: null,
    creation_block: null,
    source_version: 'PVTv4',
    artifact_sources: ['arbitrum-pvt-v4.json/contracts/pvtV4'],
    runtime_code_sha256_16: '4c04b9e29a5956af',
    runtime_code_bytes: 16199,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0xb8E8Cf96f87a9CD1a313472818081c7c3267da41',
    chain_id: 42161,
    deployment_tx: '0x96884227422aa4b51b5f49c07526a050380376122d2d4038cfff261da0a3450a',
    creation_block: 460542396,
    source_version: 'PVTv4',
    artifact_sources: ['arbitrum-chunk-i.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'bc16ebcd82bd7264',
    runtime_code_bytes: 16482,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3',
    chain_id: 42161,
    deployment_tx: null,
    creation_block: null,
    source_version: 'PVTv4',
    artifact_sources: ['arbitrum-chunk-ii.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'a196f47fe7d5dffe',
    runtime_code_bytes: 16482,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  // ------------------------------------------------------------- Optimism 10
  {
    address: '0x411dAcE53Ad2236e9ed1E5318822f750Aa2229E1',
    chain_id: 10,
    deployment_tx: null,
    creation_block: 148499802,
    source_version: 'PVTv2',
    artifact_sources: ['optimism-pvt-day-one.json/contracts/pvtV2'],
    runtime_code_sha256_16: '1d6645ebf01367ba',
    runtime_code_bytes: 7004,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x1A3Efca7f3000c59F7509f565d707B755B078664',
    chain_id: 10,
    deployment_tx: null,
    creation_block: 148888010,
    source_version: 'PVTv3',
    artifact_sources: [
      'optimism-pvt-v3.json/contracts/pvtV3',
      'optimism-agent-bank-v4.json/config/pvt',
      'optimism-bond-pool.json/wiring/pvtContract',
      'optimism-foundation-membership.json/config/pvt',
    ],
    runtime_code_sha256_16: '2aa598b645e89ddf',
    runtime_code_bytes: 10290,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x92099F2eF928239A89F2A29dAd5D66F7412002A7',
    chain_id: 10,
    deployment_tx: null,
    creation_block: 151044430,
    source_version: 'PVTv4',
    artifact_sources: ['optimism-pvt-v4.json/contracts/pvtV4'],
    runtime_code_sha256_16: '4c04b9e29a5956af',
    runtime_code_bytes: 16199,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0xb8E8Cf96f87a9CD1a313472818081c7c3267da41',
    chain_id: 10,
    deployment_tx: '0x3c24c065580963c0dc55f4ef5324525be844f598e71c24f53ec52e9b2215f1f0',
    creation_block: 151306322,
    source_version: 'PVTv4',
    artifact_sources: ['optimism-chunk-i.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'bc16ebcd82bd7264',
    runtime_code_bytes: 16482,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
  {
    address: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3',
    chain_id: 10,
    deployment_tx: '0xa93809c2debedc0d17b17e1b28486be93b4efc950468af92c014efc92d7a33fd',
    creation_block: 151346346,
    source_version: 'PVTv4',
    artifact_sources: ['optimism-chunk-ii.json/contracts/pvtV4'],
    runtime_code_sha256_16: 'a196f47fe7d5dffe',
    runtime_code_bytes: 16482,
    total_supply_atomic: '0',
    exposes_batch_minted: true,
    observed_mint_range_utc: null,
    retired: true,
  },
];

/**
 * Every legacy mint document in the C1 reconciliation set, bound to the contract
 * its OWN mint transaction receipt actually touched.
 *
 * These bindings are receipt-derived, which matters: two of the five carry no
 * `pvt_contract_address` field at all (the pre-snapshot inline batch schema),
 * so a field-only resolution would have left them unresolvable — which is
 * exactly how came to record them as `minted_against_contract: null`.
 */
export interface DocumentMintBinding {
  readonly document_id: string;
  readonly mint_tx_hash: string;
  readonly chain_id: LegacyMintChainId;
  /** `to` of the mint transaction; also the sole log emitter. */
  readonly mint_contract_address: string;
  readonly mint_block: number;
  /** `batchMinted(document_id)` read live against `mint_contract_address`. */
  readonly batch_minted_on_correct_contract: boolean;
  /** The same question asked of PVTv8 — recorded to show it is not probative. */
  readonly batch_minted_on_pvtv8: boolean;
}

export const DOCUMENT_MINT_BINDINGS: readonly DocumentMintBinding[] = [
  {
    document_id: '0x1b730f3bb48e84a9ff9fdbb97522b57ff962685a3cf8e3a3a2ebc29bb8edafa0',
    mint_tx_hash: '0xcace2eb492f4409628e9d26424ab75fcc38090e88cf79f18b767c5e13cea1042',
    chain_id: 8453,
    mint_contract_address: '0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598',
    mint_block: 45553349,
    batch_minted_on_correct_contract: true,
    batch_minted_on_pvtv8: false,
  },
  {
    document_id: '0xc1ffc74839443070247b0e37c4518ddaa1f4f02e77b4d275a4889ef953e26683',
    mint_tx_hash: '0x4c06566c8b7d8e31b34c14b8792deb6d1a13a32b3bd165117cf6b49f6c2f86e1',
    chain_id: 8453,
    mint_contract_address: '0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4',
    mint_block: 44394882,
    batch_minted_on_correct_contract: true,
    batch_minted_on_pvtv8: false,
  },
  {
    document_id: '0x4669b38dd862d86b6768edbfd141c18a4c07a3d8fec1fa4345725cbbcb5df778',
    mint_tx_hash: '0x07d89705e2f145c5318030b8ec1c50ad7078a30134d0240e3d8e3cf623632ad1',
    chain_id: 8453,
    mint_contract_address: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    mint_block: 47367738,
    batch_minted_on_correct_contract: true,
    batch_minted_on_pvtv8: false,
  },
  {
    document_id: '0x4b953d26337b235a9a86fea056bb4e09b9df1d74d2d0dbeea60e0ed97f513177',
    mint_tx_hash: '0x704a8aca08ecdff04fb7622399c0fa3932f32340734c6fc7b3a1d1139d9c89d6',
    chain_id: 8453,
    mint_contract_address: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    mint_block: 45777056,
    batch_minted_on_correct_contract: true,
    batch_minted_on_pvtv8: false,
  },
  {
    document_id: '0xace10848e897fd3cda142143d75742164a4d5340e26a7a506bef38a83b6dd056',
    mint_tx_hash: '0x833ff00a6239405e107eda60d18edb11a32cca172af97ada05b17809c0e7f33f',
    chain_id: 8453,
    mint_contract_address: '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
    mint_block: 45777091,
    batch_minted_on_correct_contract: true,
    batch_minted_on_pvtv8: false,
  },
];

/** Thrown when no registry row can answer for a document. NEVER a `false`. */
export class LegacyMintContractUnresolved extends Error {
  public readonly documentId: string;

  constructor(documentId: string, detail: string) {
    super(`legacy_mint_contract_unresolved: ${documentId} — ${detail}`);
    this.name = 'LegacyMintContractUnresolved';
    this.documentId = documentId;
  }
}

const BINDINGS_BY_DOC: ReadonlyMap<string, DocumentMintBinding> = new Map(
  DOCUMENT_MINT_BINDINGS.map((b) => [b.document_id.toLowerCase(), b]),
);

const REGISTRY_BY_ADDRESS: ReadonlyMap<string, LegacyMintContractRow> = new Map(
  LEGACY_MINT_CONTRACT_REGISTRY
    .filter((r) => r.chain_id === 8453)
    .map((r) => [r.address.toLowerCase(), r]),
);

/** Every address the registry knows, lowercased, across all chains. */
export function isRegisteredMintContract(address: string): boolean {
  const lower = address.toLowerCase();
  return LEGACY_MINT_CONTRACT_REGISTRY.some((r) => r.address.toLowerCase() === lower);
}

/**
 * Resolve the contract a document's value attached to.
 *
 * Resolution order, most authoritative first:
 *   1. `DOCUMENT_MINT_BINDINGS` — the document's own mint-transaction receipt.
 *   2. `recordedContractAddress` — the `pvt_contract_address` a snapshot carries,
 *      accepted ONLY when the registry knows that address. An address the
 *      registry cannot account for is UNIDENTIFIED and throws.
 *
 * THROWS on anything else. There is deliberately no fallback to PVTv8 and no
 * `null` return: a caller that cannot reach the right contract must be unable
 * to express that as a negative answer.
 */
export function resolveMintContractForDocument(
  documentId: string,
  recordedContractAddress?: string | null,
): { readonly address: string; readonly chainId: LegacyMintChainId; readonly source: 'receipt' | 'recorded_field' } {
  const bound = BINDINGS_BY_DOC.get(documentId.toLowerCase());
  if (bound !== undefined) {
    return { address: bound.mint_contract_address, chainId: bound.chain_id, source: 'receipt' };
  }
  if (typeof recordedContractAddress === 'string' && recordedContractAddress.trim() !== '') {
    const row = REGISTRY_BY_ADDRESS.get(recordedContractAddress.trim().toLowerCase());
    if (row === undefined) {
      throw new LegacyMintContractUnresolved(
        documentId,
        `recorded pvt_contract_address ${recordedContractAddress} is not in the registry `
        + '(UNIDENTIFIED — this is a finding, not a negative answer)',
      );
    }
    return { address: row.address, chainId: row.chain_id, source: 'recorded_field' };
  }
  throw new LegacyMintContractUnresolved(
    documentId,
    'no mint-transaction binding and no recorded pvt_contract_address; the contract '
    + 'this document minted against is unknown, so no readback can speak for it',
  );
}

/** Registry rows carrying a non-zero live supply — where value demonstrably attached. */
export function contractsWithLiveSupply(): readonly LegacyMintContractRow[] {
  return LEGACY_MINT_CONTRACT_REGISTRY.filter((r) => r.total_supply_atomic !== '0');
}
