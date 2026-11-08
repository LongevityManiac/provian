/**
 * @provian/agent-sdk
 *
 * SDK for AI agents to connect to Provian Wallet via Cloud Relay.
 * Minimal runtime deps (@noble/curves + @scure/base for crypto; viem for the
 * EVM signer/bond paths); uses native fetch for HTTP (Node 18+).
 */

export { ProvianClient } from './ProvianClient';

// SSRF egress guard (WS3): SDK-side enforcement for non-payment agent egress.
export { validateEgressTarget, isSSRFTarget } from './egress-guard';
export type { EgressGuardResult, HostResolver } from './egress-guard';

// Institution state vocabulary : the SDK/CLI mirror of the relay's single
// receipt-driven institution state machine. Logic-only — an agent/CLI/UI uses
// it to tell a record-only DRAFT from an authoritative ECONOMIC transition; the
// relay owns the receipt gate, the agent-wallet status check, and the
// idempotency ledger.
export {
  INSTITUTION_KINDS,
  INSTITUTION_STATES,
  INSTITUTION_TRANSITIONS,
  INITIAL,
  classifyTransition,
  isEconomicTransition,
  isLegalTransition,
} from './institution-state';
export type { InstitutionKind, TransitionClass } from './institution-state';

// Agent Wallet
export {
  createAgentWallet,
  generateAgentKeyPair,
  getTrustProfile,
  rotateKey,
  deriveAddressFromPrivateKey,
} from './wallet';
export {
  APPROVED_NETWORK_CONSTITUTION_VERSIONS,
  NETWORK_CONSTITUTION_VERSION,
  isCurrentNetworkConstitutionVersion,
} from './types';
export type {
  AgentWalletRegistrationHandle,
} from './types';
export type { InputOrigin, OriginWitness } from './types';
// Trust Layer §2.3: forward-only output_digests normalizer (three copies, one shape).
export type { OutputDigest, OutputDigestKind, OutputDigestsState } from './output-digests';
export {
  normalizeOutputDigests,
  outputDigestsState,
  OUTPUT_DIGEST_KINDS,
  OUTPUT_DIGESTS_MAX_ENTRIES,
} from './output-digests';
// Prompt 1/1b: forward-only input_origins normalizer + three-state classifier.
export {
  normalizeInputOrigins,
  normalizeOriginWitness,
  inputOriginsState,
  INPUT_ORIGINS_MAX_ENTRIES,
  INPUT_ORIGIN_HASH_MAX_LEN,
  INPUT_ORIGIN_IDENTIFIER_MAX_LEN,
  INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN,
  INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN,
  INPUT_ORIGIN_WITNESS_TIER_MAX_LEN,
} from './input-origins';
export type { InputOriginsState } from './input-origins';

// Agent Keystore - AES-256-GCM encrypted-at-rest persistence for the agent key
export {
  encryptKeystore,
  decryptKeystore,
  withDecryptedKey,
  saveKeystore,
  loadKeystore,
  exportKeystore,
  importKeystore,
  persistAgentWalletKey,
  getDefaultKeystorePath,
} from './keystore';
export {
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
  clearPendingAgentWalletRegistration,
  createChildAgentWallet,
  DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
} from './pending-wallet-registration';
export type {
  ParentAuthorizationProvider,
  ResumeAgentWalletRegistrationOptions,
} from './pending-wallet-registration';

// Parent-authorization proof-of-possession — the primitives a parent agent uses
// to authorize creating a child agent wallet (see createChildAgentWallet).
export {
  canonicalParentAuthorizationMessage,
  signParentAuthorization,
  fetchParentAuthorization,
} from './parent-pop';
export type { ParentProofOfAuthorization } from './parent-pop';

// Git identity → wallet (Part 2): register the agent's git author
// identity so the GitHub / GitLab / Bitbucket webhook witness credits its
// commits on a connected repository. Same PoP shape as connect-pop / parent-pop.
// Registering is attribution, not activity — it mints nothing.
export {
  AUTHOR_MAPPING_POP_PURPOSE,
  GitIdentityError,
  githubIdentityLink,
  assertChallengeBindsToIdentity,
  assertOwnerChallengeBindsToIdentity,
  canonicalAuthorMappingMessage,
  completeGitIdentityChallenge,
  listGitIdentities,
  normalizeAuthorKey,
  readGitAuthorEmail,
  registerGitIdentity,
  revokeGitIdentity,
  signAuthorMapping,
} from './git-identity';
export type {
  AuthorKeyType,
  AuthorMappingChallengeReadResponse,
  AuthorMappingChallengeResponse,
  AuthorMappingClaims,
  CompleteGitIdentityParams,
  GitIdentityConfig,
  GitIdentityErrorCode,
  GitIdentityMapping,
  NormalizedAuthorKey,
  RegisterGitIdentityParams,
  RegisterGitIdentityResult,
} from './git-identity';
export {
  gitIdentityGuidanceLines,
  registerGitIdentityCommand,
  unmappedAuthorHint,
} from './git-identity-guidance';
export type { GitIdentityGuidanceInput, GitIdentityProvider } from './git-identity-guidance';
// The agent-credential and local-keystore-secret loaders, so a front door in
// another package (the `provian` CLI) resolves the SAME files the SDK bins do.
export { loadAgentCredentialsFile, AGENT_CREDS_PATH } from './scripts/agent-credentials-file';
export type { AgentCredentialsFile } from './scripts/agent-credentials-file';
export { readLocalKeystoreSecret, LOCAL_KEYSTORE_SECRET_PATH } from './local-keystore-secret';
export type {
  AgentKeystore,
  KeystoreCrypto,
  KeystoreKdfParams,
  EncryptKeystoreParams,
  DecryptedKey,
  PersistAgentWalletParams,
} from './keystore';

// External-address proof of control - an agent proves it controls an external
// EVM wallet it ALREADY runs, after which that address's go-forward on-chain
// financial activity on Base maps to PEs on the standard record path. Verify IS
// the link (one address -> one agent, Base-only). Off-chain signature, no gas,
// no custody move. Proving is attribution, not activity: the proof PE is
// record-only and mints 0 PVT.
export {
  linkExternalAddress,
  requestExternalAddressChallenge,
  verifyExternalAddress,
  assertChallengeBindsToAddress,
  buildExternalProofMessage,
  ExternalAddressError,
  EXTERNAL_ADDRESS_PROOF_CHAIN,
  EXTERNAL_ADDRESS_PROOF_CHAIN_ID,
  EXTERNAL_ADDRESS_PROOF_TTL_MS,
} from './external-address';
export type {
  ExternalAddressConfig,
  ExternalAddressChallenge,
  ExternalAddressProof,
  ExternalAddressSigner,
  LinkExternalAddressParams,
  ProofMessageBinding,
} from './external-address';

// Solana address proof-of-control: binds the agent's Solana address (its own, or one it
// holds) so its Solana x402 payments and receipts become witnessed PEs. Pays nothing.
export {
  proveSolanaAddress,
  proveExternalSolanaAddress,
  proveSolanaAddressBestEffort,
  requestSolanaAddressChallenge,
  verifySolanaAddress,
  listSolanaAddresses,
  assertSolanaChallengeForAgent,
  signSolanaProofMessage,
  normalizeSolanaAddress,
  fetchOwnAgentId,
  checkSolanaProofMessage,
  buildSolanaProofMessage,
  SolanaAddressProofError,
  SOLANA_PROOF_MESSAGE_HEADER,
  SOLANA_PROOF_MAX_LIFETIME_MS,
} from './solana-address-proof';
export type {
  SolanaAddressProof,
  SolanaAddressChallenge,
  SolanaAddressProofConfig,
  SolanaProofOrigin,
  ProvenSolanaAddress,
  ExternalSolanaSigner,
  SolanaProofStepResult,
  SolanaProofSubject,
  SolanaProofMessageBinding,
  SolanaProofMessageVerdict,
} from './solana-address-proof';

// Beneficiary linking - human-side EIP-191 link consent signing
export { signLinkPayload, signEip191Message } from './link-signing';
export type { LinkPayload, UnlinkPayload, ShareChangePayload, LinkConsentPayload } from './link-signing';
// the sovereign lane records ONLY a hardware-witnessed work occurrence
// (a non-actor key's report over the body). The x402 reputation PE builders and
// the witness-optional submitSovereignWork were removed — an agent's own signed
// claim about its work is never a PE.
export {
  buildSovereignWorkCanonicalMessage,
  newSovereignNonce,
  submitHardwareWitnessedWork,
  SOVEREIGN_WORK_CANONICAL_TAG,
} from './sovereign-pe';
export type {
  SovereignWorkFields,
  SubmitHardwareWitnessedWorkParams,
  SovereignSubmitResult,
} from './sovereign-pe';

// GitHub App connect flow (B4,): exported so the `provian` CLI's
// `connect github` subcommand can delegate to the SAME flow the SDK's own
// `connect-github` bin runs — one implementation, two front doors.
export { runConnectFlow } from './scripts/connect-github-flow';
export type { ConnectFlowDeps, ConnectFlowResult } from './scripts/connect-github-flow';
export { loadCredentials } from './scripts/credentials';
export type { ProvianCredentials } from './scripts/credentials';

// x402 - the agent signs its OWN EIP-3009 USDC payment with its OWN funded EOA
// (governance-free; agent's money). `ProvianClient.wrapFetchWithX402` is the
// fetch wrapper; these are the standalone signer + protocol primitives.
export {
  signX402Payment,
  buildPaymentHeader,
  getX402Network,
  X402_NETWORKS,
  getAgentUsdcBalance,
  getAgentPvtBalance,
  getErc20Balance,
  usdcAtomicToHuman,
  decodePaymentRequired,
  selectCompatibleRequirement,
  selectPinnedRequirement,
  parsePinnedPayment,
  decodePaymentResponse,
  eip712Digest,
  USDC_DECIMALS,
} from './x402-signer';
export type {
  X402Wallet,
  X402NetworkParams,
  SignedX402Authorization,
  SignX402PaymentArgs,
  PaymentRequired,
  PaymentRequirement,
  ERC3009Authorization,
  PaymentPayload,
  PaymentResponse,
  X402PinnedPayment,
  ParsedPinnedPayment,
} from './x402-signer';

// x402 on Solana (SVM): the agent pays USDC on Solana by building + partially
// signing a versioned transaction the facilitator co-signs. The agent's Solana
// address (funding/receiving) derives from the SAME secp256k1 secret. Same
// governance-free posture as EVM x402.
export {
  signX402SvmPayment,
  buildSvmPaymentHeader,
  selectCompatibleSvmRequirement,
  getX402SvmNetwork,
  isSvmNetwork,
  X402_SVM_NETWORKS,
  deriveSolanaKeypair,
  deriveSolanaAddressFromEvmKey,
  SVM_USDC_DECIMALS,
  resolveProvianFee,
  PROVIAN_SOLANA_FACILITATOR_FEE_WALLET,
  PROVIAN_SOLANA_FACILITATOR_FEE_MAX_ATOMIC,
} from './x402-signer-svm';
export type { SvmSignedPayment, SignX402SvmArgs, SvmNetworkParams, SvmPaymentPayload, ProvianSvmFee } from './x402-signer-svm';
export { deriveSolanaAddress, deriveSolanaEd25519Seed } from './chains';

// Agent EVM transaction signer (slice 1) - the agent's sovereign EOA signs and
// BROADCASTS native + ERC-20 transfers via viem (distinct from x402, which only
// signs an off-chain authorization). Key-per-call; allowlist is the safety
// boundary because the agent's own spending is ungoverned.
export {
  sendTransaction,
  transferToken,
  transferNative,
  encodeErc20Transfer,
  EvmSignerError,
} from './evm-signer';
export type {
  EvmWallet,
  EvmSendResult,
  TokenTransferResult,
  SendTransactionParams,
  TransferTokenParams,
  TransferNativeParams,
  PEReporter,
  PETransferReport,
} from './evm-signer';
export {
  TOKEN_ALLOWLIST,
  CONTRACT_ALLOWLIST,
  CHAIN_IDS,
  VIEM_CHAINS,
  isSupportedChain,
  getToken,
  isAllowlistedTarget,
  allowlistedTargets,
} from './evm-allowlist';
export type { SupportedChain, AllowlistedToken, TokenInfo } from './evm-allowlist';

// Local relay-session file (~/.provian/session.json) - the canonical session
// record shared with @provian/cli. Same filename + camelCase shape both tools
// read and write, so a session made by one is usable by the other.
export { readSessionFile, writeSessionFile, deleteSessionFile } from './session-file';
export type { AgentSessionFile } from './session-file';

// Types
export type {
  ProvianClientConfig,
  IntentContext,
  ActionCategory,
  ActionReport,
  ConnectionResult,
  AgentWalletConfig,
  AgentWalletResult,
  MultiChainAddresses,
  TrustProfile,
  WorkProductType,
  WorkProductReport,
  WorkProductResult,
  ActionResult,
} from './types';

// Re-export key rotation types from wallet module
export type { RotateKeyConfig, RotateKeyResult } from './wallet';

// Balance sweep for a VOLUNTARY rotation — moves the retired address's earned
// balance into the newly-rotated address instead of stranding it (the /
// re-key stranding). Fail-closed: a sweep failure never undoes the rotation and
// never falsely reports "all clear". `rotateKeyAndSweep` is the recommended entry
// for a voluntary rotation.
export { sweepErc20ToNewKey, rotateKeyAndSweep } from './sweep';
export type {
  SweepErc20Params,
  SweepResult,
  RotateKeyAndSweepResult,
  RotateKeyAndSweepOptions,
} from './sweep';

// Errors
export {
  ProvianError,
  ConnectionError,
  PEDescriptionError,
} from './errors';

// Commons institutions - currency-aware primitives (Workstream 4)
export {
  CommonsInstitutions,
  ProvianValidationError,
  ProvianNetworkError,
  BurnNotPresentedError,
  ProvianAuthError,
  ProvianVouchRefusedError,
  COMMONS_RELAY_CODES,
  MAX_COMMONS_JOB_BUDGET_USD,
  MAX_COMMONS_JOB_DEADLINE_HOURS,
  COMMONS_DISPUTE_REASON_MAX_LENGTH,
  COMMONS_DISPUTE_EVIDENCE_MAX_LENGTH,
  pvtWholeToAtomic,
  coercePvtAmount,
  PVT_PRINCIPAL_CHAINS,
} from './commons-institutions';
export type { RailHandshakeStateResult, AgentBalances, AgentInboxEvent, AgentInboxPage } from './commons-institutions';

// Burn-to-present — presenter binding + requester verify/challenge + handshake read
export {
  buildAgentPresentationRequest,
  claimsDigest as presentationClaimsDigest,
  presentationBindingString,
  canonicalReputationDirective,
  normalizeRequester,
  PRESENTATION_BINDING_TAG,
  PRESENTATION_BINDING_TAG_V2,
  // the burn id a pipelined present binds (`sha256("<chain>:<lowercase tx hash>")`).
  burnIdForTx,
  // PE meter: one pe_fact entry on the wire (the PE and its inclusion proof ride along).
  peFactWire,
} from './presentation';
export type { BuildPresentationParams, PresentationTier, PeFact, PeFactWire, PresentationRequester } from './presentation';
export {
  issuePresentationChallenge,
  parseChallengePayload,
  verifyPresentationToken,
  decodePresentationToken,
  PROVIAN_BASE_PE_ANCHOR,
  DEFAULT_BASE_RPC_URL,
  DEFAULT_PROVIAN_JWKS_URL,
} from './presentation-verify';
export type {
  PresentationChallenge,
  DomainRequesterSigningKey,
  Presentation,
  PresentationJwk,
  VerifyPresentationOptions,
  VerifyPresentationResult,
  PresentationRefusal,
} from './presentation-verify';
// signed challenges (provian-challenge-v1): requester keys, envelope verify, replay store
export {
  challengeSigningString,
  challengePredicatesDigest,
  requesterString,
  parseChallengeEnvelope,
  isSignedChallenge,
  checkSignedStructure,
  verifyChallengeEnvelope,
  signChallengeEnvelope,
  signDomainChallenge,
  generateRequesterKey,
  requesterWellKnownDocument,
  parseRequesterKeyDocument,
  fetchRequesterKeys,
  createRequesterKeyFetcher,
  fetchProvianPresentationKeys,
  describeChallengeVerdict,
  isRefusedVerdict,
  ChallengeRefusedError,
  createMemorySeenStore,
  createFileSeenStore,
  CHALLENGE_SIGNING_TAG,
  CHALLENGE_ENVELOPE_VERSION,
  CHALLENGE_MIN_TTL_SECONDS,
  CHALLENGE_MAX_TTL_SECONDS,
  CHALLENGE_DEFAULT_TTL_SECONDS,
  REQUESTER_WELL_KNOWN_PATH,
} from './challenge';
export type {
  ChallengeEnvelope,
  EnvelopeRequester,
  RequesterIdentity,
  RequesterJwk,
  RequesterPublicJwk,
  RequesterType,
  FetchRequesterKeys,
  ChallengeInvalidReason,
  ChallengeVerdict,
  RefusedChallengeVerdict,
  VerifyChallengeEnvelopeOptions,
  PresentationSeenStore,
} from './challenge';
export type { OnRequesterHook, ChallengeCheckOptions } from './commons-institutions';
export type {
  CommonsInstitutionsConfig,
  Chain,
  EscrowAmount,
  PromiseAmount,
  PoolAmount,
  JobBudget,
  CreateEscrowRequest,
  CreatePromiseRequest,
  CreatePoolRequest,
  PostJobRequest,
  EscrowResponse,
  PromiseResponse,
  PoolResponse,
  JobResponse,
  DirectoryProfile,
  DirectorySearchFilters,
  PayAgentPVTRequest,
  ListAvailableJobsFilters,
  ApplyToJobRequest,
  JobApplicationRecord,
  AcceptApplicantResponse,
  MyJobsFilters,
  MyJobsResponse,
  MyHumanJobsFilters,
  MyHumanJobsResponse,
  FundEscrowRequest,
  FundEscrowResponse,
  CompleteEscrowResponse,
  RegisterCapabilitiesRequest,
  HumanJobCategory,
  HumanJobCompensationType,
  HumanJobDirection,
  HumanJobSeeking,
  HumanJobCurrency,
  HumanJobLocationRequirement,
  PostHumanJobBase,
  PostHumanJobRequest,
  ApplyToHumanJobRequest,
  RateHumanJobRequest,
  BrowseHumanJobsFilters,
  BrowseCommonsJobsFilters,
  HumanJobResponse,
  HumanJobApplicationResponse,
  FeaturedPlacement,
  CommonsJobsPage,
  MarketJobsOptions,
  MarketStats,
  CommonsJobEscrow,
  CommonsJobDispute,
  AcceptCommonsApplicantResponse,
  CommonsJobFundingRecord,
  CommonsJobChainOpts,
  FundCommonsJobParams,
  FundCommonsJobResult,
  ReleaseCommonsJobResult,
  DisputeCommonsJobParams,
  DisputeCommonsJobResult,
  ClaimCommonsJobRefundResult,
  VouchResult,
  MyVouch,
  PublicVouch,
  JoinCommonsRequest,
  JoinCommonsResult,
  PostBondParams,
  PostBondResult,
  RenewBondParams,
  RenewBondResult,
  ReleaseEscrowParams,
  ReleaseEscrowResult,
  WithdrawFromPoolParams,
  WithdrawFromPoolResult,
  InviteDeviceRequest,
  InviteDeviceResult,
} from './commons-institutions';

// Bond origination calldata + helpers (slice 2), built on the EVM signer.
export {
  encodeApprove,
  encodePostBond,
  encodeRenewBond,
  grossUpTotalDeposit,
  requiredBondWei,
  bondPoolAddressForChain,
  waitForReceipt,
  BOND_POOL_ADDRESSES,
} from './evm-bond';

// Escrow release calldata + address pins (WS1-SDK), built on the EVM signer.
export {
  encodeReleaseEscrow,
  escrowAddressForChain,
  BYTES32_PATTERN,
  ESCROW_USDC_ADDRESSES,
  ESCROW_PVT_ADDRESSES,
  // the Commons hire legs (fund / dispute / refund) on ProvianEscrowV4.
  encodeCreateEscrow,
  encodeFundEscrow,
  encodeDisputeEscrow,
  encodeClaimDisputeTimeout,
  usdcToAtomic,
  randomOnchainEscrowId,
  ESCROW_CURRENCY_ENUM,
  ESCROW_CURRENCY_DECIMALS,
} from './evm-escrow';
export type { EscrowCurrency } from './evm-escrow';

// Pool withdrawal calldata + address pins (P4-01-SDK), built on the EVM signer.
export {
  encodeWithdrawContribution,
  poolAddressForChain,
  POOL_ADDRESSES,
} from './evm-pool';

// Single source of truth for protocol contract addresses (institution deployment/PVT9 Base
// institutions, env override → deployment-JSON default). evm-bond/evm-escrow/
// evm-allowlist resolve through this module — no per-file address literal survives.
export {
  BASE_PVT9_ADDRESSES,
  retiredBaseAddresses,
  resolveBondPoolAddress,
  resolveEscrowUsdcAddress,
  resolvePoolAddress,
  isRetiredAddress,
} from './contract-addresses';

// SDK self-version + client-side staleness evaluation (agent update signal).
export { SDK_VERSION } from './version';
export {
  parseSemver as parseSdkSemver,
  compareSemver as compareSdkSemver,
  evaluateStaleness,
  stalenessMessage,
  logStaleness,
} from './sdk-staleness';
export type { StalenessVerdict, StalenessLogger } from './sdk-staleness';

// daemon self-update from the Provian-signed release channel (same
// Ed25519 authority as the harness catalog; DEFAULT ON / opt-out, fail-closed,
// atomic apply).
export {
  verifyReleaseManifest,
  validateReleaseManifest,
  runSelfUpdateOnce,
  resolveSelfUpdateConfig,
  nodeVersionBelow,
  RELEASE_PUBLIC_KEY,
  RELEASE_POLL_INTERVAL_MS,
  RELEASE_MAX_BUNDLE_BYTES,
} from './observer/self-update';
export type {
  ReleaseManifest,
  ReleaseEnvelope,
  ReleaseVerification,
  ReleaseRejection,
  SelfUpdateIO,
  SelfUpdateOutcome,
  SelfUpdateConfig,
} from './observer/self-update';

// link_spend: the Stripe Link spend WITNESS. The agent completed a
// purchase through Link's wallet for agents; Provian records the spend-request
// RECORD (never a card object, a credential, or LINK_ACCESS_TOKEN) after the
// fact. Mint-once anchors on the `lsrq_…` id; only a SUCCEEDED spend prices.
export {
  LINK_SPEND_ACTION_TYPE,
  LINK_SPEND_ID_RE,
  LINK_SPEND_STATUSES,
  LINK_SPEND_ELIGIBLE_STATUS,
  LINK_SPEND_CREDENTIAL_TYPES,
  LinkSpendCredentialError,
  LinkSpendInvalidError,
  linkSpendCredentialLeak,
  linkSpendRawCredentialLeak,
  projectLinkSpendRecord,
  buildLinkSpendWitness,
  linkSpendWitnessMetadata,
  linkSpendDescription,
  recognizeLinkSpendInText,
} from './link-witness';
export type { LinkSpendInput, LinkSpendWitness, LinkSpendStatus, LinkSpendCredentialType } from './link-witness';
// the public recordLinkSpend (an agent's own report of its Link spend) was removed —
// the observer daemon's transcript lane witnesses the Link CLI result on the agent's box.
// Trust Layer build §2.6/§2.10: requester predicates + the human-approval origin helper.
export { normalizePredicateRequests, predicateMatchesRequest, canonicalPredicate, PREDICATE_OPS } from './presentation';
// Requester-named disclosure (2026-10-10): the shared request / answer core and the presenter's store finder.
export {
  normalizeDisclosureRequests, canonicalDisclosureRequest, disclosureRequestMatches, challengeDisclosuresDigest, disclosureCommitmentDigest,
  parseDisclosureAnswers, recordMatchesRequest, readFieldPath, DISCLOSURE_CONTENT_ELECTIONS, DISCLOSURE_REQUESTS_MAX, DISCLOSURE_RECORDS_MAX_LIMIT,
  type CanonicalDisclosureRequest, type DisclosureRequest, type DisclosureAnswer, type DisclosedRecord, type DisclosedWitness, type DisclosureContent, type DisclosureElection,
} from './disclosure-request';
export { findDisclosureRecords, storedPeMatches, PINNED_ROOT_SCHEME } from './meter/disclose';
export { disclosureAnswersForCommitment, type DisclosureAnswerInput, type DisclosedPeRecord } from './presentation';
export type { DisclosurePolicy } from './commons-institutions';
export type { PredicateRequest, PredicateOp, DisclosureDirective, CanonicalPredicate } from './presentation';
export { humanApprovalOrigin } from './input-origins';
// Trust Layer §2.9: hardware witness producers + the binding nonce every lane recomputes.
export {
  hardwareBindingNonceHex, attachHardwareWitness, canonicalJson as hardwareCanonicalJson,
  tpm2QuoteProvider, gcpConfidentialSpaceProvider, autoHardwareWitnessProvider,
  type HardwareWitnessInput, type HardwareWitnessProvider, type HardwareScheme,
} from './hardware-witness';

// PE meter : a PE lives with its owner. The device's own PE store
// (operators may supply their own `PeStore`), the daily batcher, and proving an act from it.
export { FsPeStore, MemoryPeStore, defaultPeStoreRoot, PE_STORE_DIR_ENV, PeStoreCorruptError } from './meter/pe-store';
export type {
  PeStore, StoredPe, StoredPeV2, AcceptedBatch, InFlightBatch, StoredBatchProof, ReceivedPe, MeterHalt,
  MeterBatchReceiptWire, MeterActReceiptWire, MeterAnchorProofWire, AppendResult, StoreHead,
} from './meter/pe-store';
export { MeterBatcher, parseLineageNote, METER_DEFAULT_MAX_BATCH_BYTES } from './meter/batcher';
export type { MeterBatcherOptions, SendReport, ProofsReport, MailboxReport, SealTarget } from './meter/batcher';
export { actInclusionProofFor, peFactFromStore } from './meter/prove';
export type { ActProofResult, StorePeFact, StorePeFactResult, StorePeFactFailure } from './meter/prove';
export { resolveLocalPeStore } from './meter/local-store';
export type { LocalPeStoreResolution } from './meter/local-store';
export { meterStatusOf, describeMeterStatus, PE_STORE_NOTICE } from './meter/status';
export type { MeterStatus } from './meter/status';
export {
  PE_V2_SCHEMA, PE_BATCH_SCHEMA, METER_GENESIS_PREV_HASH, MAX_ACTS_PER_BATCH, peHashOf, actRecordOf, actLeafOf,
  actsRootOf, batchHashOf, batchLeafOf, verifyActInclusion, merkleRootOf, merkleProofOf, canonicalJson as meterCanonicalJson,
} from './meter-wire';
export type { PeV2, ActRecord, PeBatch, SealedCopy, ActInclusionProof } from './meter-wire';
// The paid PE Archive : opt-in per wallet, $5 USDC per GB. The device seals each
// closed day to its owner (and an agent's linked human), uploads it, and — once the Archive
// confirms it — keeps only the most recent 30 days here; older PEs are pulled back to present.
export { ArchiveKeeper, createHttpArchiveTransport, ARCHIVE_RUN_INTERVAL_MS } from './meter/archive';
export type { ArchiveKeeperOptions, ArchivePullOptions, ArchiveRunReport, ArchiveTransport } from './meter/archive';
export { openLocalArchiveKeeper } from './meter/archive-local';
export { FileArchiveObjectCache, MemoryArchiveObjectCache, defaultArchiveCacheDir, DEFAULT_ARCHIVE_CACHE_MAX_BYTES } from './meter/archive-cache';
export type { ArchiveObjectCache } from './meter/archive-cache';
export type { ArchivedPeSource } from './meter/prove';
export type { ArchivedPeStub, ArchivedDayRecord, ArchiveDropPlan, ArchiveLocalState } from './meter/pe-store';
export { describeArchiveStatus } from './meter/status';
// PE export (provian.pe-export.v1, docs/PE_PROTOCOL_SPEC.md §14): every PE an agent owns in one file,
// verifiable against Base without any Provian server.
export {
  buildPeExport,
  exportPesToFile,
  selfCheckPeExport,
  listLocalDeviceStores,
  defaultExportFileName,
  writePeExportFile,
} from './meter/export';
export type { BuildPeExportInput, BuiltPeExport, PeExportArchiveSource, PeExportResult, PeExportSelfCheck, IncompleteEntry } from './meter/export';
export { exportLocalPes, PeExportUnavailableError } from './meter/export-local';
export type { ExportLocalPesOptions } from './meter/export-local';
export { verifyPeExportFile, verifyPeExportText, jsonRpcEthCall, DEFAULT_EXPORT_VERIFY_RPC_URL } from './meter/export-verify';
export type { PeExportVerification, VerifyPeExportOptions } from './meter/export-verify';
export { keepReceivedProofs, fetchBatchProofs, receivedProofOf, receivedBatchHashes } from './meter/received-proofs';
export type { BatchProofsFetch, KeepReceivedProofsReport } from './meter/received-proofs';
export type { ReceivedBatchProof, PeChainRow } from './meter/pe-store';
export {
  PE_EXPORT_SCHEMA,
  PE_EXPORT_SPEC_URL,
  PE_EXPORT_PE_ANCHOR,
  PE_EXPORT_BASE_CHAIN_ID,
  parseExport,
  serializeExport,
  verifyExportOffline,
  verifyAnchorsOnChain,
} from './pe-export-wire';
export type { ExportHeader, ExportBodyLine, ExportOfflineReport, ExportAnchorCheck } from './pe-export-wire';
export {
  ARCHIVE_BYTES_PER_GB, ARCHIVE_GB_PRICE_USDC_ATOMIC, ARCHIVE_LOCAL_KEEP_DAYS, PE_ARCHIVE_PART_SCHEMA,
  archiveDayOf, archiveDayDroppable, buildArchiveEntries, sealArchivePart, parseArchivePart, openArchivePart,
  splitArchiveObject, findArchivedEntry,
} from './pe-archive-wire';
export type { ArchivePartHeader, ArchivePayload, ArchiveEntry, ArchiveBatchRef, ArchiveRecipient } from './pe-archive-wire';
export type { DeviceRecordedPE } from './types';

// Commons communication: the E2E thread half (deterministic message key + sealed box).
export { deriveMessageKeyPair, sealThreadMessage, openThreadMessage, threadContentSha256 } from './thread-crypto';
export type { MessageKeyPair, SealedThreadMessage } from './thread-crypto';
export { SPEECH_AUDIENCE } from './commons-institutions';
export type { ThreadMessageInput, UnreadThreadMessages } from './commons-institutions';
// Agents reachable by default : key self-heal + inbox → local mailbox delivery.
export {
  ensureCommonsMessageKey, startCommonsMessageKeyHeal, deliverThreadMessagesOnce, startThreadDelivery,
  readMailbox, clearMailboxThreads, unreadMailNotice, actionRequiredNotice, mailboxPath,
  syncCommonsHeartbeatNotice, acknowledgeCommonsHeartbeat, commonsHeartbeatAcknowledged,
} from './commons-messaging';
export type { MessageKeyHealOutcome, MailboxMessage, Mailbox, CommonsMessagingRelay, HeartbeatNoticeOutcome } from './commons-messaging';
// item 4: the owner's reply policy the relay hands with every thread read.
export { readReplyPolicy, replyPolicyInstruction, strangerNextStep } from './reply-policy';
export type { ReplyPolicy, ReplyPolicyMode, AgentApprovalView, StrangerNextStep } from './reply-policy';
// The read loop: the Commons mail instruction every onboarding surface carries.
export { commonsHeartbeatInstruction } from './witness-setup';
// any of your linked agents onboards your other agents (one-hour, single-use link codes).
export { issueFleetCode, friendlyFleetCodeError } from './fleet-code';
export type { IssueFleetCodeParams, IssueFleetCodeResult, FleetCodeInstallLine } from './fleet-code';
export type { FleetCodeResult } from './commons-institutions';

// the agent's own swap (relay 0x quote → guard → own-key sign → record) and the
// shell act verbs the hosted bundle runs.
export { executeAgentSwap, agentSwapTokenAddress, isAgentSwapToken } from './agent-swap';
export type { AgentSwapToken, AgentSwapQuote, AgentSwapParams, AgentSwapResult } from './agent-swap';
export {
  decodeZeroXAllowanceHolderTx, assertZeroXExecutionMatches, assertGenuineZeroXSettler, SwapRouteRefusedError,
  ZEROX_ALLOWANCE_HOLDER, ZEROX_DEPLOYER, BASE_WETH,
  readEthUsdPrice, oracleExpectedOut, assertSwapWithinOracleBounds, BASE_CHAINLINK_ETH_USD,
  ORACLE_MAX_AGE_SECONDS, SWAP_ORACLE_TOLERANCE_BPS,
} from './zerox-swap-guard';
export { isTransientChainRecordRefusal } from './commons-institutions';
export { ARCHIVE_GB_FEE_USDC_ATOMIC, PAYOUT_FEE_USDC_ATOMIC, PROVIAN_SERVICE_FEE_RECIPIENT, PROVIAN_SERVICE_FEE_NETWORK, provianServiceFeePin } from './commons-institutions';
export type { ArchiveView, ArchiveStatusView, ArchiveQuote, ArchivePaymentView, PayoutQuote, PayoutStatus } from './commons-institutions';
export { ACT_VERBS, resolveActVerb, renderActHelp, runActVerb, runActVerbCli } from './act-verbs';
export type { ActVerbSpec, ActDeps } from './act-verbs';
export { loadInstalledAgent, InstalledAgentError } from './installed-agent';
export type { InstalledAgent } from './installed-agent';
// the retired "# Provian PE Reporting" instruction section (register-device no
// longer writes it) — exported so a cleanup step can match one already written.
export { PE_REPORTING_SECTION_HEADING, PE_REPORTING_SECTION_COMMAND_NEEDLE } from './pe-reporting-section';

// Signed outputs : every output an agent hands out carries its signature over the
// output's hash; a citation counts toward the producer's Consumption when it carries that signature
// and the citing act is witnessed. Device-key signing is `ProvianClient.signOutput`; capture of
// received signed outputs is `ProvianClient.wrapFetchWithOutputCitations` (and `wrapFetchWithX402`).
export {
  OUTPUT_SIGNATURE_HEADER, OUTPUT_SIGNATURE_JSON_KEY, OUTPUT_SIGNATURE_MESSAGE_PREFIX, OUTPUT_CITATION_SCHEME,
  outputSignatureMessage, outputSignatureDigestHex, encodeOutputSignatureHeader, decodeOutputSignatureHeader,
  normalizeOutputSignature, outputCitationOrigin, signedCitationOf, appOutputKeyId,
} from './output-signature';
export type { OutputSignature, OutputSigner, OutputSignerKind, OutputSignatureScheme, OutputCitationOrigin } from './output-signature';
export {
  outputHashOf, signOutputWithWalletKey, signOutputWithDigestSigner, signOutputWithP256Key, outputSignatureMatches,
  walletOutputSignatureRecovers, p256OutputSignatureVerifies, outputSignatureHeaders, outputSignatureJson,
  readOutputSignatureHeader, signResponse,
} from './output-signing';
export type { OutputBytes } from './output-signing';

export {sealRelayPrivateRequest} from './relay-private-request';

// The observer and its plugin interface: the same names `@provian/agent-sdk/observer` exports, so a
// custom capture plugin (docs/EXTERNAL_DEVICE_INTEGRATION.md §11b) can import from either entry.
export { ProvianObserver, ProcessPlugin } from './observer';
export type { ObserverPlugin } from './observer';

export { startCommonsEvents, CommonsEventConsumer, parseCommonsPoll } from './commons-events';
export type { CommonsEvent, CommonsPoll, CommonsRuntime, EventDeliveryInput } from './commons-events';
export { commonsRuntime } from './commons-runtime';

export { recoverEvmTransaction, listRecoverableEvmTransactions, ChainNonceError } from './evm-signer';
export type { SignerOpts } from './evm-signer';

export { githubPrRequestMessage, prepareGitHubPrRequest } from './github-pr-request';
export type { GitHubPrRequest, SignedGitHubPrRequest } from './github-pr-request';
