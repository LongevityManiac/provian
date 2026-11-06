import { pushLanguage, pushTokenHash } from './core/notifications/localization';
import { createGitHubTaskRouter } from './routes/github-tasks';
import { redispatchGitHubWebhookInbox } from './core/witnesses/github-webhook-inbox';
import { withJurisdictionRequest, evaluateMintCompliance } from './core/jurisdiction/mint-compliance';
import { countryFromIp } from './core/jurisdiction/country';
import { getJurisdictionPolicy } from './core/jurisdiction/jurisdiction-policy';
import { refreshSdn } from './core/jurisdiction/sdn';
import { ownerParticipantClass, newMobileDeviceRegistration } from './core/identity/participant-class';
import { burnTimingMiddleware } from './core/onchain/burn-timing';
import { createGcpRest, resolveGcpProjectId } from './core/cloud/google-rest';
import {recordResponseCompression} from './core/net/response-compression';
import { costCompression } from './core/net/cost-compression';
import './core/observability/diagnostic-privacy';
import { publicLatencyMiddleware } from './core/observability/public-latency';
import { publishRuntimeReadModel } from './core/pvt/runtime-read-model';
import {unwrapPrivateBatch} from './core/meter/private-pricing';
/**
 * Provian Cloud Run Backend
 * Handles PE recording, agent connection/witnessing, push notifications, multi-device sync
 */

import express, { Request, Response, NextFunction } from 'express';
import { RELAY_FIRESTORE_SETTINGS } from './firestore-settings';
import { DEFAULT_FIRESTORE_DATABASE_ID, relayDatabaseId, relayDb } from './firestore-db';
import { firestoreAppAttestKeyStore } from './core/hardware/app-attest-keys';
import { appleAssertionDepsFor } from './core/hardware/app-attest-register';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sendPush, sendPushToUser, pruneUserTokens, classifyToken, tokenPrefix, resolvePushToken } from './core/notifications/pushDispatcher';
import admin from 'firebase-admin';
import { OAuth2Client } from 'google-auth-library';
import { cache } from './cache';
import type { ConnectionTokenBeneficiaryLink } from './cache';
import { selectPreAuthRateBuckets } from './rate-limit-bucket';
import { lookupRecoveryUser, type RecoveryLookupDb } from './routes/recovery-user-select';
import { bumpOpsCounter } from './core/observability/ops-counters';
import { fetchBounded, DeadlineExceededError, ResponseTooLargeError } from './core/net/bounded-fetch';
import type { AgentWalletDocument } from './core/agent-wallet/types';
import { fetchAgentPEActivity, countVisibleAgentPEs } from './core/agent-wallet/agent-pe-activity';
import { projectLinkedAgentIdentity } from './core/agent-wallet/linked-agent-identity';
import { hasProvenExternalAddress } from './core/external-address/link';
import { generateConnectionToken } from './core/connection-token-format';
import { isValidAnchorPubkeyB64u } from './core/agent-recovery-escrow';
import { recordPEAccrual, readNetworkCounters, resolveX402PayerAddress, resolveX402SettlementTxHash } from './pvt-accrual';
import {
  boardRankForAddress,
  parseRankContext,
  parseWindow,
  readNetworkStats,
  resolveWalletRank,
} from './network-stats-projection';
import type { RecordPEAccrualParams } from './pvt-accrual';
import { decodeKeysetCursor } from './core/pagination/keyset-cursor';
import { singleFlight } from './core/concurrency/single-flight';
import { advanceRelayAct, priceRelayAct, replayStuckRelayActs, type RelayActIntake } from './core/meter/meter-relay-authored';
import { sweepPendingEvidence } from './core/pvt/pending-evidence-resolver';
import { sweepRegistryHolds } from './core/pvt/registry-hold-resolver';
import { resolveMintRecipientAddress } from './core/pvt/mint-recipient-resolver';
import { verifyEvmTxFrom } from './core/onchain/tx-verifier';
import { normalizeAttestationTier } from './core/pvt/pe-weight-framework';
import { createCoinbaseSessionToken, CoinbaseNotConfiguredError } from './core/onramp/coinbase-session';
import {
  decideOnrampVerification,
  deriveOnrampPartnerRef,
  fetchOnrampTransactions,
  CoinbaseTransactionsError,
} from './core/onramp/coinbase-transactions';
import { initPEBatchWriter, drainPEBatchWriter } from './pe-batch-writer';
import {
  exactGenesisReservedGrossForRoleAtomic,
  formatPvtAtomic,
  projectCurrentSettlementPEAtomic,
  recordPointsForRoleAtomic,
  resolveContributorIdentities,
  type CurrentSettlementProjectionContext,
} from './core/pvt/policy/economic-projection';
// M5: the dashboard read is the accrual-time aggregate (frozen totals +
// live 72h tail), not the O(history) fold. Same result shape; the fold is the
// reference it is reconciled against and the fallback it serves on drift.
import { emptyAggregateReadTrace, readEconomicAccrualProjection } from './core/pvt/policy/economic-aggregate-read';
import { readPvt9SettlementFactors } from './core/pvt/pvt9-settlement-factors';
import {
  listRecentActKeys,
  pricedActView,
  readActorPeTotals,
  readParticipationSummary,
  sendPeKeptByOwner,
} from './core/meter/owner-reads';
import { readNetworkMeter24h } from './core/meter/actor-meter-totals';
import { deleteUserRelayData } from './core/wallet/delete-user-data';
import { endHumanBeneficiaryLinks } from './core/agent-wallet/end-human-beneficiary-links';
import { invalidateDeviceCache } from './routes/middleware/device-auth';
import { leaveCommons } from './core/commons/profiles';
import { recoverRecoverySigner, recoveryNonceMaterial, RECOVERY_PURPOSE } from './routes/recovery-eip712';
import { createAgentWalletRouter } from './routes/agent-wallet';
import { createAgentLeaderboardRouter } from './routes/agent-leaderboard';
import { createAgentInviteRouter } from './routes/agent-invite';
import { createAgentEscrowRouter } from './routes/agent-escrow';
import { createAgentPromisesRouter } from './routes/agent-promises';
import { createHumanPromisesRouter } from './routes/human-promises';
import { processHumanPromiseExpiry } from './core/human-promises/human-promises';
import { createAgentPoolsRouter } from './routes/agent-pools';
import { createAgentCourtRouter } from './routes/agent-court';
import { createAgentBondsRouter } from './routes/agent-bonds';
import { createWitnessesGitHubRouter } from './routes/witnesses-github';
import { createGitHubIdentityRouter } from './routes/github-identity';
import { createGitHubPrGateRouter } from './routes/github-pr-gate';
import { createWitnessesGitLabRouter } from './routes/witnesses-gitlab';
import { createWitnessesBitbucketRouter } from './routes/witnesses-bitbucket';
import { createWitnessesInstallsRouter } from './routes/witnesses-installs';
import { processAutoReleases, processDefaults, processExpiredPools } from './core/agent-bank/scheduler';
import { createEscrowChainGateway } from './core/agent-bank/escrow-release';
import { createPoolKeeperGateway } from './core/agent-bank/pool-keeper';
import { createBondKeeperGateway } from './core/agent-bank/bond-keeper';
import { drainAgentBankEventOutbox } from './core/agent-bank/event-outbox';
import { sweepBurnFinality } from './core/presentation/burn-finality';
import { processCourtDeadlines } from './core/agent-bank/court';
import { createEcosystemRouter } from './routes/ecosystem';
import { createGenesisStatusRouter, type GenesisStatusRouterDeps } from './routes/genesis-status';
import { createAgentDirectoryRouter } from './routes/agent-directory';
import { createFacilitatorSettlementRouter } from './routes/x402-facilitator';
import { createX402SellersRouter } from './routes/x402-sellers';
import { buildFacilitatorLaneDeps } from './core/pvt/x402-facilitator-lane';
import { createAgentProfileRouter } from './routes/agent-profile';
import { createAgentRecordRouter } from './routes/agent-record';
import { createReputationRouter } from './routes/reputation';
import { createAgentJobsRouter } from './routes/agent-jobs';
import { createWebhookRouter } from './routes/agent-webhooks';
import { createPEProposalRouter } from './routes/pe-proposals';
import { createEarningProposalRouter } from './routes/earning-proposals';
import { createWantsRouter } from './routes/wants';
import { createThreadsRouter } from './routes/threads';
import { createNamesRouter } from './routes/names';
import { createStandingRouter } from './routes/standing';
import { createPledgesRouter } from './routes/pledges';
import { createPEVerifyRouter } from './routes/pe-verify';
import { createPresentRouter } from './routes/present';
import { buildPeSchema } from './core/schema/pe-schema';
import { createWalletPresentationRouter } from './routes/wallet-presentation';
import { createDeviceOutputKeyRouter, createWalletOutputKeyHandler } from './routes/output-signing-keys';
import { createSetupRouter } from './routes/setup';
import { createBootstrapRouter } from './routes/bootstrap';
import { createWalletAttestationRouter } from './routes/wallet-attestation';
import {
} from './core/agent-wallet/proof-of-possession';
import { createConformanceRouter } from './routes/conformance';
import { validateEmailConfig, sendConnectCommand } from './email';
import {
  buildDeviceRegisterCommand,
  mintCommandIdempotencyKey,
  resolveRelayUrl,
} from './core/setup-command';
import { buildAgentDeviceInstallLines } from './core/agent-bootstrap-script';
// P4-13: passkey router is unmounted until its registration half exists (see
// the /v1/auth/passkey mount site below). Import retained, commented, for the
// eventual re-enable.
// import { createPasskeyAuthRouter } from './routes/passkey-auth';
import { mountOpenAPIRoutes } from './routes/openapi';
import { mountMCPRoutes } from './routes/mcp';
import { createCommonsRouter } from './routes/commons';
import { createPEProjectionsRouter } from './routes/pe-projections';
import { createContractRegistryRouter, createContractRegistryPublicRouter } from './routes/contract-registry';
import { createScamListRouter } from './routes/scam-list';
import { mountRetiredRecorders } from './routes/meter-retired-recorders';
import {
  canonicalDeviceEconomicAttestationTier,
  createDeviceRouter,
  createDeviceSelfRouter,
  createRegisterDeviceHandler,
  linkedAgentCaptureFields,
  resolveAttestationTierFromSigning,
  type DeviceEconomicAttestationTier,
} from './routes/devices';
import { createDeviceRegisterAuth, consumeHumanDeviceToken } from './routes/middleware/device-register-auth';
import { getDeviceRegistrationId } from './routes/middleware/device-registration-id';
import { createAgentAttributionRouter } from './routes/agent-attribution';
import { verifyBoundDeviceSignature } from './routes/middleware/device-signature-binding';
import {
  getAuthenticatedHumanMobileDevice,
  authenticateRequestHumanMobileDevice,
} from './routes/pe-submit-mobile-device-ownership';
import { createProvisionalRouter } from './routes/provisional';
import {
  rejectEmbeddedBeneficiaryLink,
} from './routes/connection-token';
import { createEnterpriseRouter } from './routes/enterprise';
import { createNotifyRouter } from './routes/notify';
import { createUnsubscribeRouter } from './routes/unsubscribe';
import { createCommunityRouter } from './routes/community';
import { createAgentAuthMiddleware } from './routes/middleware/agent-auth';
import { skipReservedAgentSegments } from './routes/middleware/reserved-agent-segments';
import { processGenesisQualification, drainGenesisQualifications } from './core/pvt/genesis-award-state-machine';
import { backfillRetainedGenesisQualifications } from './core/pvt/genesis-retention-backfill';
import { enforceGenesisLaunchSequenceAtStartup } from './core/pvt/genesis-launch-guard';
import { buildPeAnchorReadContract } from './core/pvt/pe-anchor-runtime';
import { createHumanWalletRegistrationHandler } from './routes/human-wallet-registration';
import { createPersonExternalAddressRouter } from './routes/person-external-address';
import { createAgentSolanaAddressRouter, createPersonSolanaAddressRouter } from './routes/solana-address';
import { createLaunchStateRouter } from './routes/launch-state';
import { retiredLegacyAgentWalletCreateHandler } from './routes/retired-wallet-creation';
import { seedCatalog, startCatalogFlushTimer } from './core/provenance/pe-type-catalog';
import {
  getChainProvider,
  validateVerifierProviderIdentities,
} from './core/onchain/rpc-provider';
import { readAgreedBaseHead } from './core/onchain/economic-discovery';
import {
  assertNoExposedKeyAsLiveValueRecipient,
  LIVE_VALUE_RECIPIENT_VARS,
} from './core/config/live-value-recipients';
import { createPvt9RuntimeBoundary } from './core/pvt/wp2-runtime-boundary';
import { preLaunchSurfaceGate } from './routes/middleware/pre-launch-surface-gate';
import {
  consoleRequestCounterMiddleware,
  recordConsoleEndpointError,
} from './core/observability/request-counters';
import { isAppClientDiscoveryAdmissible } from './routes/middleware/public-launch-gate';
import { durableCollectionIds, startDurableExport, RELAY_EXPORT_BUCKET } from './core/backup/durable-export';
import { maintenanceMiddleware } from './core/maintenance/maintenance-mode';
import { createPayoutRouter } from './routes/payout';
import { createPayoutDeps } from './core/payout/payout-runtime';
import { createArchiveRouter } from './routes/archive';
import { createX402DiscoveryRouter } from './routes/x402-discovery';
import { createStorePurchaseRouter } from './routes/store-purchases';
import { createStorePurchaseDeps } from './core/store-purchases/store-runtime';
import type { StorePurchaseDeps } from './core/store-purchases/store-purchase-service';
import { createArchiveDeps } from './core/archive/archive-runtime';
import type { ArchiveDeps } from './core/archive/archive-service';
import type { PayoutDeps } from './core/payout/on-demand-payout';
import { createPvt9OperationsRouter } from './routes/pvt9-operations';
import { createBurnFloorOperationsRouter } from './routes/burn-floor-operations';
import { mountPvtPublicReads } from './routes/pvt-public-reads';
import { BODY_DEADLINE_MS, InstanceHealth, bodyDeadline, requestDeadline } from './instance-health';
import { rawPrivateFirestore } from './core/provenance/private-store';

// Initialize Redis cache (no-op if env vars are missing)
cache.initialize();

// Initialize Firebase Admin (for Firestore + FCM)
// Cloud Run sets GOOGLE_CLOUD_PROJECT automatically
const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'provian-ai';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
}

// The relay's Firestore database comes from ONE setting, FIRESTORE_DATABASE_ID
// (unset/empty = "(default)"); every module reads it through relayDb().
const firestoreDatabaseId = relayDatabaseId();
let db: admin.firestore.Firestore;
if (firestoreDatabaseId === DEFAULT_FIRESTORE_DATABASE_ID) {
  // Configure Firestore to ignore undefined values (cleaner than checking each field)
  admin.firestore().settings(RELAY_FIRESTORE_SETTINGS);
  db = relayDb();
} else {
  // relayDb() applies RELAY_FIRESTORE_SETTINGS to the named client exactly once.
  db = relayDb();
}

console.log(`Firebase initialized with project: ${projectId}, Firestore database: ${firestoreDatabaseId}`);

// Initialize PE batch writer for ~100x Firestore write cost reduction
const peBuffer = initPEBatchWriter(db);

const app = express();
// Bypass application auth/rate limits, but check the very same pooled client
// used by handlers. Existence is immaterial; an empty field mask reads no data.
const rawDb = rawPrivateFirestore(db);
const instanceHealth = new InstanceHealth(() => rawDb.getAll(
  rawDb.doc('system_status/monetary_activation'), { fieldMask: [] },
));
// Only the ingress port is publicly routed. Dependency probes use a separate
// listener so public health checks cannot turn into unmetered database reads.
const probeApp = express();
probeApp.get('/startup', instanceHealth.startup);
probeApp.get('/health', instanceHealth.liveness);
app.get('/health', instanceHealth.startup);
// First, so a public request's latency is timed from arrival (internal job routes excluded).
app.use(publicLatencyMiddleware());
app.use(instanceHealth.admit);
app.use(bodyDeadline());
app.use(burnTimingMiddleware);

// Trust the first proxy hop (Cloud Run's HTTPS load balancer). Without this,
// req.ip resolves to the load balancer's connecting IP, collapsing every
// per-IP rate limit on unauthenticated routes (including
// /v1/wallet/agent/create) into a single global bucket. Setting trust proxy
// to 1 makes Express read X-Forwarded-For and assign the first hop to req.ip.
// Re-audit MED-1 (docs/audit/chunk_h_reaudit_2026_05.md §3 MED-1).
app.set('trust proxy', 1);
app.use((_req, _res, next) => withJurisdictionRequest(() => next()));

// =============================================================================
// PRE-LAUNCH LOCKDOWN - single env flag gates the public discovery surface.
// When PUBLIC_LAUNCH=false (default), these endpoints return 404:
//   GET /v1/agent/wallet/invite/:invite_id (in routes/agent-wallet.ts)
//   GET /v1/pvt/network-stats
//   GET /v1/openapi.json, /v1/openapi.yaml, /.well-known/openapi.json (in routes/openapi.ts)
//   GET /v1/ecosystem (in routes/ecosystem.ts)
// /mcp and /.well-known/mcp.json open on PUBLIC_LAUNCH=true OR MCP_AGENT_ONBOARDING=true
// (routes/mcp-access.ts); MCP_AGENT_ONBOARDING is false in production until launch.
// To flip on at launch — EXACTLY these two variables (FLIP_RUNBOOK §4.2); PUBLIC_LAUNCH=true alone
// is refused at boot (genesis-launch-guard: refused_minting_flag_absent), and the same two lines go
// into provian-backend/.env.deploy so the next deploy-env.sh does not revert them:
//   gcloud run services update provian-api --region us-central1 --project provian-ai \
//     --update-env-vars PUBLIC_LAUNCH=true,PVT_MINTING_DELIBERATELY_ENABLED=true
// =============================================================================
const PUBLIC_LAUNCH = process.env.PUBLIC_LAUNCH === 'true';
console.log(`[startup] PUBLIC_LAUNCH=${PUBLIC_LAUNCH} (public discovery endpoints ${PUBLIC_LAUNCH ? 'OPEN' : 'gated to 404'})`);

// Middleware
app.use(helmet());
app.use(costCompression());
app.use(recordResponseCompression());
// : the database-move switch (RELAY_MAINTENANCE=1 → writes answer 503; devices queue).
app.use(maintenanceMiddleware());
const ALLOWED_ORIGINS = [
  'https://provian.ai',
  'https://www.provian.ai',
  'https://commons.provian.ai',
];
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:8081');
}
// A disallowed browser origin is a client-side access decision, not a server
// fault. Tag the rejection so the handler below maps it to 403 — never a raw
// thrown Error, which Express renders as 500 and thereby inflates the Cloud Run
// 5xx SLO. On 2026-09-02 a WordPress exploit scanner sending an Origin header on
// ~270 probes in 3 min pushed the 5xx ratio to 0.60 and paged, though every
// probe hit a nonexistent route (would-be 404s turned into 500s here).
class CorsOriginError extends Error {
  constructor(public readonly origin: string) {
    super('Not allowed by CORS');
    this.name = 'CorsOriginError';
  }
}
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new CorsOriginError(origin));
  },
  credentials: true,
}));
// Map the CORS origin rejection to an explicit 403 (not Express's default 500).
// Placed immediately after cors() so it intercepts the rejection before routing;
// any other error is passed through untouched.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof CorsOriginError) {
    res.status(403).json({ error: 'origin_not_allowed' });
    return;
  }
  next(err);
});
// SECURITY: Capture raw body string for wallet auth body-hash verification (Task 1).
// The verify callback fires before JSON parsing. We store the raw UTF-8 string
// on req so authenticate() can SHA-256 it and compare against the token's `bh` field.
// PE METER: a batch carries up to 500 acts plus their sealed copies, so the batch routes take a
// larger body than the 100 kb default (the SDK keeps each batch under METER_BATCH_BODY_LIMIT).
// Mounted first, so the global parser below finds the body already parsed. Same raw-body capture.
const METER_BATCH_BODY_LIMIT = '5mb'; // encrypted transport of the unchanged 2 MB logical batch
app.use(['/v1/meter/batch', '/v1/meter/batch/mobile', '/v1/meter/transit'], express.json({ inflate: false,
  limit: METER_BATCH_BODY_LIMIT,
  verify: (req, _res, buf) => {
    (req as Request).rawBody = buf.toString('utf8');
  },
}));
// : an Archive upload carries one sealed part of one day (up to 24 MB of ciphertext
// line, ARCHIVE_MAX_PART_BYTES), so its two upload routes take a larger body. Same raw-body capture
// (the device route is body-bound; the app's token binds the body hash).
const ARCHIVE_PART_BODY_LIMIT = '53mb'; // encrypted transport of the unchanged 24 MB part
app.use(['/v1/archive/device/parts', '/v1/archive/mobile/parts'], express.json({ inflate: false,
  limit: ARCHIVE_PART_BODY_LIMIT,
  verify: (req, _res, buf) => {
    (req as Request).rawBody = buf.toString('utf8');
  },
}));
app.use(express.json({ inflate: false,
  limit: '220kb', // authenticated ciphertext of the former 100 KB logical request
  // express types `req` here as the raw http.IncomingMessage; cast to the express
  // Request so the globally-augmented `rawBody` slot is typed (no `any`).
  verify: (req, _res, buf) => {
    (req as Request).rawBody = buf.toString('utf8');
  },
}));
// A slow untrusted upload can expire its own connection. Only a handler whose
// JSON body was received can enter the process-retirement watchdog.
app.use(requestDeadline());

// PE METER : every single-PE recorder is retired and answers 410 with its
// successor batch route. Mounted ahead of the runtime boundary quarantine and all auth. See
// routes/meter-retired-recorders.ts.
mountRetiredRecorders(app);

// runtime boundary: explicit legacy/dependent route quarantine. Mounted before auth and all
// route dependencies so disabled paths cannot touch a signer, provider, or DB.
// Safe PE record/history reads and the Forum remain outside the blocked set.
app.use(createPvt9RuntimeBoundary());

// M10: close every pre-launch surface an ANONYMOUS caller could reach. Mounted here, ahead of
// all routes and all auth, because the defect it fixes was distributed: `publicDiscoveryGate`
// was correct but mounted on three routers, so `GET /v1/agents/directory` served 200 and the
// agent-credential doors (`/v1/agent/wallet/challenge`, `/parent-challenge`) answered 400 —
// reaching their own validators — with `PUBLIC_LAUNCH=false`. See pre-launch-surface-gate.ts.
// Adds a refusal only; authenticates nobody and opens nothing.
app.use(preLaunchSurfaceGate());

// Phase 1: per-instance request counters for the operator console. In
// memory only — a plain integer bump on response finish, no I/O on the hot path.
app.use(consoleRequestCounterMiddleware());

// =============================================================================
// PHASE 2.18 (Theme 10): strip caller-asserted identity fields from request
// bodies. Identity must come from authenticated session state, never from
// client-controlled JSON fields. This middleware deletes the fields the
// audit flagged so any handler that accidentally reaches into req.body for
// them will see undefined and have to use the canonical req.user / req.agentWallet
// path instead.
// =============================================================================
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    // These three fields are NEVER trusted from the client. Identity must
    // be derived server-side from the auth context. The fields are
    // recorded in audit logs if a request supplies them so we can spot
    // misbehaving clients without breaking them.
    const stripped = ['user_id', 'wallet_id', 'actor_address'];
    for (const field of stripped) {
      if (field in req.body) {
        delete (req.body as Record<string, unknown>)[field];
      }
    }
  }
  next();
});

// =============================================================================
// AGENT-SDK STALENESS HEADERS
// -----------------------------------------------------------------------------
// Advertise the latest / minimum-supported @provian/agent-sdk version on EVERY
// relay response. The SDK learns staleness passively — on connect and on every
// heartbeat GET — without a dedicated call. Advisory only: fail-open, never a
// gate, and NOTHING here gates an agent's own x402 spending. See core/sdk-version.ts.
// =============================================================================
import { sdkVersionInfo, SDK_LATEST as SDK_LATEST_HDR, SDK_MIN_SUPPORTED as SDK_MIN_HDR } from './core/sdk-version';
app.use((_req, res, next) => {
  res.set('X-Provian-SDK-Latest', SDK_LATEST_HDR);
  res.set('X-Provian-SDK-Min', SDK_MIN_HDR);
  next();
});

// =============================================================================
// SECURITY HELPERS
// =============================================================================

// Constant-time admin/scheduler secret compare lives in the shared helper so
// every call site applies the same length-check + timingSafeEqual pattern.
import { safeSecretCompare } from './routes/middleware/admin-secret';

/**
 * Redact a wallet address for logging. Returns "0x...abcd" preserving only
 * the last 4 hex chars so the log line remains diagnosable without tying
 * the relay user_id to the on-chain identity in plaintext.
 */
function redactAddress(addr: string | null | undefined): string {
  if (!addr || typeof addr !== 'string') return '<unknown>';
  const clean = addr.toLowerCase();
  if (clean.length < 6) return clean;
  return `0x...${clean.slice(-4)}`;
}

/**
 * Authenticate Cloud Scheduler requests using OIDC tokens (primary) or shared secret (fallback).
 *
 * OIDC is the recommended method for Cloud Scheduler → Cloud Run authentication.
 * The shared secret fallback allows manual testing and backward compatibility.
 *
 * @param req - Express request object
 * @returns Promise<boolean> - true if authenticated, false otherwise
 */
const EXPECTED_SCHEDULER_EMAIL = 'provian-scheduler@provian-ai.iam.gserviceaccount.com';
const oauthClient = new OAuth2Client();

// Cloud Scheduler mints its OIDC token with an audience equal to the URL it
// invokes - the canonical *.run.app service URL - not our custom domain. So we
// must accept both. CLOUD_RUN_SERVICE_URL may be a comma-separated list to add
// the run.app URL without a code change. Verifying audience (rather than
// skipping it) keeps the token bound to this service.
const SCHEDULER_OIDC_AUDIENCES: string[] = (
  process.env.CLOUD_RUN_SERVICE_URL || 'https://api.provian.ai'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function authenticateScheduler(req: Request): Promise<boolean> {
  // Primary: Check for OIDC Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      // Verify the OIDC token using Google's public keys
      // This validates signature, expiration, and issuer
      // The audience should be the Cloud Run service URL
      const ticket = await oauthClient.verifyIdToken({
        idToken: token,
        audience: SCHEDULER_OIDC_AUDIENCES,
      });

      const payload = ticket.getPayload();

      // Verify the email claim matches the expected scheduler service account
      if (payload?.email === EXPECTED_SCHEDULER_EMAIL) {
        console.log('[Scheduler Auth] OIDC token verified successfully');
        return true;
      } else {
        console.warn(`[Scheduler Auth] OIDC token email mismatch: ${payload?.email}`);
        return false;
      }
    } catch (error) {
      console.error('[Scheduler Auth] OIDC verification failed:', error);
      // Fall through to shared secret check
    }
  }

  // Fallback: Check shared secret header
  const secret = req.headers['x-scheduler-secret'];
  if (safeSecretCompare(secret, process.env.SCHEDULER_SECRET)) {
    console.log('[Scheduler Auth] Shared secret verified (fallback)');
    return true;
  }

  console.warn('[Scheduler Auth] All authentication methods failed');
  bumpOpsCounter('auth.scheduler_403');
  return false;
}

// =============================================================================
// ERROR CLASSIFICATION
// =============================================================================

/**
 * Detect transient infrastructure errors (Firestore overload, network timeouts).
 * Returns true for errors that are temporary and should result in HTTP 503
 * instead of HTTP 500 (which implies a permanent/bug issue).
 *
 * In our endpoint handlers, errors are almost exclusively from Firestore/gRPC
 * operations. Any error with a .code property (string or number) is from the
 * infrastructure layer and is transient under load.
 */
function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  // Any error with a .code property is from Firestore/gRPC/Firebase - transient under load
  if (e.code !== undefined) return true;
  // Check error message for common transient patterns
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase();
    return msg.includes('deadline') || msg.includes('unavailable') || msg.includes('resource exhausted')
      || msg.includes('too many requests') || msg.includes('aborted') || msg.includes('rst_stream')
      || msg.includes('econnreset') || msg.includes('socket hang up') || msg.includes('stream removed');
  }
  return false;
}

function handleEndpointError(res: Response, error: unknown, label: string): void {
  console.error(`[${label}] Error:`, error);
  recordConsoleEndpointError();
  if (isTransientError(error)) {
    res.status(503).json({ error: 'Service temporarily unavailable' });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
}

// =============================================================================
// TYPES
// =============================================================================

interface Agent {
  id: string;
  user_id: string;
  name: string;
  status: 'active' | 'inactive';
  created_at: number;
  daily_budget: number;
  auto_approve_threshold: number;
  spent_today: number;
  last_reset: number;
  last_activity: number;
}

interface User {
  id: string;
  created_at: number;
  fcm_tokens: string[];  // Registered push tokens (Expo AND/OR native FCM). The
                         // push dispatcher routes each token by format at send
                         // time, so this stays the single canonical token list
                         // regardless of platform - no migration needed.
  /**
   * Format of the most recently registered push token ('expo' | 'fcm'),
   * derived server-side from the token string. Informational/diagnostic only;
   * delivery routing is per-token at send time (a user may hold both types
   * across devices). See core/notifications/pushDispatcher.ts.
   */
  token_type?: 'expo' | 'fcm';
  devices: { id: string; name: string; last_seen: number; created_at?: number }[];
  // auth_secret moved to dedicated 'auth_secrets' collection (Gemini audit finding)
  wallet_address?: string; // EVM address - links relay identity to on-chain identity
}

interface ConnectionToken {
  token: string;
  user_id: string;
  label?: string;
  created_at: number;
  expires_at: number;
  used: boolean;
  /**
   * Optional human-initiated beneficiary invite. When present, the agent that
   * redeems this token has a pending link recorded on its session; the link is
   * bound onto the agent wallet when (and only when) the agent opts in by
   * creating one. Wallet creation stays the agent's explicit choice.
   */
  beneficiary_link?: ConnectionTokenBeneficiaryLink;
  /**
   * Phone-minted x25519 recovery anchor public key (base64url), set at "Invite an
   * agent". The agent seals a recoverable copy of its wallet key to this pubkey
   * and escrows the ciphertext; the human's phone holds the matching secret. The
   * relay only ever sees this PUBLIC key and opaque ciphertext — never a secret.
   */
  recovery_anchor_pubkey?: string;
}

// Rate limiting - Redis-backed via cache.checkRateLimit (atomic INCR + EXPIRE).
// Falls open if Redis is unavailable (cache.checkRateLimit returns {allowed: true}).

// =============================================================================
// API PROXY CONFIGURATION (G-1 Security Fix)
// =============================================================================
// API keys are stored as environment variables on the server.
// The client routes all requests through these proxy endpoints.

const PROXY_CONFIG = {
  alchemy: {
    apiKey: process.env.ALCHEMY_API_KEY || '',
    rpcRateLimit: 100,
  },
  // P4-14: onramper proxy config removed — Onramper retired post-Coinbase cutover.
  zeroX: {
    apiKey: process.env.ZEROX_API_KEY || '',
    rateLimit: 10,
  },
  explorer: {
    apiKeys: {
      ethereum: process.env.ETHERSCAN_API_KEY || '',
      base: process.env.BASESCAN_API_KEY || '',
      arbitrum: process.env.ARBISCAN_API_KEY || '',
      optimism: process.env.OPTIMISM_ETHERSCAN_API_KEY || '',
    } as Record<string, string>,
    rateLimit: 10,
  },
};

// Alchemy network to hostname mapping. Includes Solana clusters: Alchemy serves
// Solana JSON-RPC at solana-{mainnet,devnet}.g.alchemy.com/v2/{KEY}, so the
// wallet's Solana balances/history/send ride the SAME authenticated, keyed,
// rate-limited proxy as EVM RPC (the proxy forwards the JSON-RPC body verbatim).
const ALCHEMY_NETWORKS: Record<string, string> = {
  'eth-mainnet': 'eth-mainnet',
  'base-mainnet': 'base-mainnet',
  'arb-mainnet': 'arb-mainnet',
  'opt-mainnet': 'opt-mainnet',
  'eth-sepolia': 'eth-sepolia',
  'base-sepolia': 'base-sepolia',
  'arb-sepolia': 'arb-sepolia',
  'opt-sepolia': 'opt-sepolia',
  'solana-mainnet': 'solana-mainnet',
  'solana-devnet': 'solana-devnet',
};

// =============================================================================
// PROXY ERROR SANITIZATION + PASSTHROUGH
// =============================================================================

/**
 * Sanitize an upstream error body before forwarding it to the mobile client.
 *
 * Goal: make upstream 4xx responses diagnostically useful (pass through the
 * status code and the error message) without leaking credentials. Upstream
 * bodies might echo our API key back in a URL, include a JWT in a header
 * dump, or reference internal account identifiers. The mobile client has
 * no business seeing any of that.
 *
 * Redacts:
 *   - Every PROXY_CONFIG API key by value (exact-string replace)
 *   - JWT-shaped tokens (three dot-separated base64 segments, 20+ chars total)
 *   - URLs containing /v2/{key} or ?api-key={key} patterns
 *   - Long opaque keys (32+ chars of [A-Za-z0-9_-] not preceded by 'sig=' etc.)
 *   - Truncated to 1KB so a huge upstream body can't become a huge proxy response
 */
function sanitizeUpstreamBody(input: unknown): unknown {
  const KNOWN_SECRETS: string[] = [
    PROXY_CONFIG.alchemy.apiKey,
    PROXY_CONFIG.zeroX.apiKey,
    process.env.LIFI_API_KEY || '',
    process.env.JUPITER_API_KEY || '',
    ...Object.values(PROXY_CONFIG.explorer.apiKeys),
  ].filter(s => typeof s === 'string' && s.length >= 8);

  const redact = (str: string): string => {
    let out = str;
    // 1. Known secrets - replace exact matches with [REDACTED]
    for (const secret of KNOWN_SECRETS) {
      if (!secret) continue;
      // Escape regex metachars in the secret value
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
    // 2. api-key query parameters - strip value
    out = out.replace(/([?&](api[-_]?key|token|apikey)=)[^&"'\s]+/gi, '$1[REDACTED]');
    // 3. Bearer tokens in headers dumps
    out = out.replace(/(Bearer\s+)[^\s"'}]+/g, '$1[REDACTED]');
    // 4. JWT-shaped strings (three base64 segments)
    out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
    // 5. Alchemy-style URL with embedded key: /v2/{key}
    out = out.replace(/(\.alchemy\.com\/v2\/)[^/?"'\s]+/g, '$1[REDACTED]');
    return out;
  };

  // Serialize to string, redact, then cap at 1KB. Downstream clients only
  // need enough to diagnose - they don't need the full upstream dump.
  let serialized: string;
  try {
    serialized = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return '[unserializable upstream body]';
  }
  const redacted = redact(serialized);
  const capped = redacted.length > 1024 ? redacted.slice(0, 1024) + '…[truncated]' : redacted;

  // Try to return it as a parsed object so the client gets structured data.
  // Fall back to the string on parse failure.
  try {
    return JSON.parse(capped);
  } catch {
    return capped;
  }
}

/**
 * Forward an upstream proxy response to the mobile client.
 *
 * On 2xx: passes the body through unchanged (res.json).
 * On 4xx: passes the status code + sanitized body so the client can
 *         distinguish "user action needed" (e.g. Alchemy free-tier limit)
 *         from real infrastructure failure.
 * On 5xx: returns opaque 502 EXTERNAL_ERROR - upstream infrastructure
 *         failures should not be exposed to mobile clients verbatim.
 *
 * All four proxy handlers share this pattern after round-4 testing
 * revealed that the previous blanket 502 translation was hiding the
 * actual root causes (Alchemy free-tier block-range cap) behind a useless
 * "EXTERNAL_ERROR" code.
 */
/**
 * H-4 (audit 2026-05-11): per-call timeout for upstream proxy fetches.
 *
 * Without this, a stuck Alchemy/Onramper/0x/Etherscan upstream
 * pins the request indefinitely (Node's undici has no default body
 * timeout) and exhausts Cloud Run concurrency before any 5xx surfaces.
 *
 * 10s is the default - long enough for normal upstream latency on slow
 * paths (e.g. Alchemy NFT enumeration on a busy wallet), short enough
 * that a stuck upstream can only burn one request per worker. Caller
 * can override.
 *
 * On timeout we throw a Sentinel error that handlers map to 504
 * UPSTREAM_TIMEOUT.
 */
const PROXY_FETCH_TIMEOUT_MS = 10_000;

/**
 * default body cap for upstream proxy reads (explorer, swap quotes, Solana
 * RPC reads). The Alchemy RPC route passes its own cap (routes/alchemy-rpc-proxy.ts).
 * 5 MiB is far above any quote/RPC answer these routes serve.
 */
const PROXY_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Strip injected proxy credentials (Alchemy `/v2/<KEY>` path segment,
 * Etherscan-family `apikey=` query) from anything that reaches a log line.
 * fetch/undici errors embed the full request URL in their message.
 */
function redactUpstreamUrl(text: string): string {
  return text
    .replace(/\/v2\/[^/?#\s"']+/g, '/v2/[redacted]')
    .replace(/([?&]apikey=)[^&#\s"']+/gi, '$1[redacted]');
}

function redactedErrorForLog(error: unknown): string {
  if (error instanceof Error) return redactUpstreamUrl(`${error.name}: ${error.message}`);
  return redactUpstreamUrl(String(error));
}

class UpstreamTimeoutError extends Error {
  public readonly url: string;
  constructor(url: string) {
    const redacted = redactUpstreamUrl(url);
    super(`Upstream timed out: ${redacted}`);
    this.url = redacted;
    this.name = 'UpstreamTimeoutError';
  }
}

async function fetchWithTimeout(
  url: string,
  init?: Parameters<typeof fetch>[1],
  timeoutMs: number = PROXY_FETCH_TIMEOUT_MS,
  maxBytes: number = PROXY_MAX_RESPONSE_BYTES,
): Promise<Awaited<ReturnType<typeof fetch>>> {
  // Express's `Response` shadows the fetch `Response` in this module's
  // scope (server.ts imports Response from express). Sidestep the clash
  // by typing the return as Awaited<ReturnType<typeof fetch>>.
  //
  // the timeout used to be cleared the moment fetch() resolved at the
  // response HEADERS, leaving every caller's `await res.json()` unbounded in time
  // and size. fetchBounded holds ONE deadline across connect + headers + the whole
  // body and aborts the transfer past `maxBytes`; the Response it returns is
  // already fully read. Over-cap surfaces as ResponseTooLargeError (→ 502).
  try {
    return await fetchBounded(url, init, { deadlineMs: timeoutMs, maxBytes });
  } catch (err) {
    if (err instanceof DeadlineExceededError) {
      throw new UpstreamTimeoutError(url);
    }
    throw err;
  }
}

function forwardUpstreamResponse(
  res: Response,
  externalRes: { ok: boolean; status: number },
  body: unknown,
): void {
  if (externalRes.ok) {
    res.json(body);
    return;
  }

  if (externalRes.status >= 400 && externalRes.status < 500) {
    res.status(externalRes.status).json({
      error: 'Upstream rejected request',
      code: 'UPSTREAM_4XX',
      upstream_status: externalRes.status,
      upstream_body: sanitizeUpstreamBody(body),
    });
    return;
  }

  // 5xx (or unusual status) - real infrastructure failure.
  res.status(502).json({
    error: 'External API error',
    code: 'EXTERNAL_ERROR',
    external_status: externalRes.status,
  });
}

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================

// req.user is typed globally in src/types/express.d.ts.

// SECURITY: Request-bound HMAC wallet auth (v2-only since H-4) with replay
// resistance. v2 token = base64({ sub, device_id, iat, exp, jti, mth, pth, bh })
// followed by HMAC-SHA256(payloadB64, authSecret). The shared verifier lives
// in routes/middleware/wallet-auth.ts so the PVT router uses the same logic.
import { verifyWalletAuthToken as verifyWalletAuthTokenShared } from './routes/middleware/wallet-auth';
import { createSwapProxyRouter } from './routes/swap-proxy';
import { createAlchemyRpcHandler } from './routes/alchemy-rpc-proxy';
import {
  createPriceFeed,
  PRICE_FEED_COLLECTION,
  PRICE_FEED_DOC,
  PRICE_FEED_MAX_RESPONSE_BYTES,
  PRICE_FEED_UPSTREAM_TIMEOUT_MS,
  type PriceFeedSnapshot,
} from './core/prices/price-feed';

function verifyWalletAuthToken(token: string, req: Request) {
  return verifyWalletAuthTokenShared(token, req, { db, cache });
}

async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      bumpOpsCounter('auth.wallet_401');
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);

    // Check for setup_token (email-based device registration) before HMAC validation.
    // Setup tokens don't contain a dot, so we check for that first.
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex === -1) {
      if (req.method !== 'POST' || req.path !== '/v1/devices/register') {
        return res.status(401).json({ error: 'Device setup token is registration-scoped' });
      }
      const registrationId = getDeviceRegistrationId(req);
      if (registrationId === null) {
        return res.status(400).json({ error: 'Idempotency-Key is required for device registration' });
      }
      // VALIDATE BEFORE BURN : PRECHECK only — full validation, no
      // write. The register handler burns via burnPendingDeviceSetupToken
      // after the request body validates, so a malformed or mangled paste
      // never consumes the invite; the consume-mode transaction re-runs every
      // check, so a correct line stays single-use under races (the Phase 2.13
      // concurrent-registration property, moved to the burn site).
      try {
        const prechecked = await consumeHumanDeviceToken(db, token, registrationId, 'precheck');
        if (prechecked.kind === 'user') {
          req.user = { id: prechecked.userId, device_id: 'setup_token' };
          req.pendingDeviceSetupToken = { kind: 'device_registration', token };
          return next();
        }
      } catch (error) {
        console.error('[Auth] Setup token validation error:', error);
      }
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const result = await verifyWalletAuthToken(token, req);
    if (!result.ok) {
      if (result.status === 401) bumpOpsCounter('auth.wallet_401');
      return res.status(result.status).json({ error: result.error });
    }
    req.user = { id: result.userId, device_id: result.deviceId };
    next();
  } catch (error) {
    console.error('[Auth] Wallet auth infrastructure error:', error);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
  }
}

// =============================================================================
// WALLET-AUTH RECORDER MIDDLEWARE
// =============================================================================
// the relay agent-session channel (`POST /v1/relay/agent/connect` and
// `Bearer {session_id}`) is REMOVED. The PVT read endpoints and the two relay PE
// recorders below authenticate with the phone's request-bound wallet token ONLY.
// An agent records with its own sovereign key (`/v1/sovereign/*`), its API key
// (`/v1/agent/wallet/*`), or its registered device (`/v1/pe/submit`) — never a
// relay session. req.userId / req.authType are typed globally in
// src/types/express.d.ts.

async function authenticateWalletRecorder(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.substring(7);
    const result = await verifyWalletAuthToken(token, req);
    if (result.ok) {
      req.userId = result.userId;
      req.authType = 'wallet';
      return next();
    }
    // Surface diagnosable parse failures distinctly from auth failures.
    if (result.status === 400) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(401).json({ error: 'Invalid authentication' });
  } catch (error) {
    console.error('[Auth] Wallet recorder auth infrastructure error:', error);
    res.status(503).json({ error: 'Authentication service temporarily unavailable' });
  }
}

// Rate limit check for proxy endpoints (per service per user)
async function checkProxyRateLimit(userId: string, service: string, maxRequests: number, cost = 1): Promise<boolean> {
  // `cost` charges a batched request once per call it carries (Alchemy RPC).
  const result = await cache.checkRateLimit(`ratelimit:proxy:${userId}:${service}`, maxRequests, 60, cost);
  return result.allowed;
}

// =============================================================================
// REDIS-BACKED RATE LIMITING MIDDLEWARE
// =============================================================================

/**
 * Redis-backed rate limiting middleware.
 * Uses INCR + EXPIRE pattern for atomic, race-free rate limiting.
 * Falls back to in-memory rate limits if Redis is unavailable.
 *
 * Runs BEFORE authentication, so NO bucket may be keyed on a claimed, unverified
 * identity (F38/F51/F63). Buckets:
 * - Global: 500 req/2s (key: rl:global:{epoch_second})
 * - Per-IP: transport-IP bound (rl:ip:{ip} / rl:ip-fcmtoken:{ip}) — the
 * pre-auth abuse bound, HIGH per the invariant: .
 * - Per-credential (optional): the api-key prefix bucket (rl:apikey:{prefix})
 * or the session-token-hash bucket (rl:session:{hash}) — keyed on the
 * CREDENTIAL, never a claimed identity. A single-use wallet HMAC token
 * carries no accumulating credential bucket; it is bounded by the IP
 * bucket alone.
 * See selectPreAuthRateBuckets.
 */
async function redisRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // Global rate limit: 500 req/sec
    const epochSecond = Math.floor(Date.now() / 1000);
    const globalResult = await cache.checkRateLimit(`rl:global:${epochSecond}`, 500, 2);
    if (!globalResult.allowed) {
      res.set('Retry-After', String(globalResult.retryAfter || 1));
      return res.status(503).json({ error: 'Server at capacity. Try again shortly.' });
    }

    // Transport-IP + credential-scoped buckets. NONE is keyed on the unverified
    // `sub`/`x-agent-id` an attacker could set to lock out a victim: an unknown
    // caller is bounded by their own transport IP, and a credentialed caller by
    // a hash of the credential they actually hold.
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const preAuthBuckets = selectPreAuthRateBuckets({
      method: req.method,
      originalUrl: req.originalUrl,
      authHeader: req.headers.authorization,
      clientIp,
    });
    for (const bucket of preAuthBuckets) {
      // Ops observability (Part D): per-bucket-prefix attribution alongside the aggregate, so the
      // console can tell which client class (ip / apikey / session / ip-fcmtoken) is hammering the
      // relay. The prefix is the bucket-KIND token from `rl:<prefix>:...` — never the identity tail.
      const bucketPrefix = bucket.key.split(':')[1] || 'unknown';
      const result = await cache.checkRateLimit(bucket.key, bucket.limit, 60);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter || 60));
        bumpOpsCounter('ratelimit.429');
        bumpOpsCounter(`ratelimit.429.${bucketPrefix}`);
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
      bumpOpsCounter(`ratelimit.allowed.${bucketPrefix}`);
    }

    next();
  } catch (error) {
    // Rate limiting should never block requests on error - fall through
    console.error('[RateLimit] Middleware error:', error);
    next();
  }
}

// Apply Redis rate limiting to all API routes. `/api` (the Alchemy / explorer /
// Coinbase / swap proxies) is included (2026-10-17): it had only post-auth per-user
// limits, so an anonymous caller with a syntactically valid token could drive an
// unbounded stream of `auth_secrets/{sub}` reads with an attacker-chosen `sub`.
app.use('/v1', redisRateLimitMiddleware);
app.use('/api', redisRateLimitMiddleware);

// =============================================================================
// CACHED HELPERS - connection token lookups
// =============================================================================

/**
 * Phone presence threshold: a phone is considered online if its last heartbeat
 * was received within this window. Heartbeats are sent every ~30 seconds while
 * the mobile app is foregrounded, so 90 seconds gives us ~3 missed intervals
 * of grace before we classify the phone as offline.
 */

// generateConnectionToken moved to ./core/connection-token-format (the single
// source of truth its two resolvers now guard against — see that module for the
// drift bug this consolidation fixed).

// =============================================================================
// ROUTES: Agents
// =============================================================================

/**
 * POST /v1/agents
 * Register a new agent
 */
app.post('/v1/agents', authenticate, async (req: Request, res: Response) => {
  try {
    const { name, daily_budget = 500, auto_approve_threshold = 50 } = req.body;
    const user_id = req.user!.id;

    const agent: Agent = {
      id: `agent_${uuidv4()}`,
      user_id,
      name: name || 'ClawdBot',
      status: 'active',
      created_at: Date.now(),
      daily_budget,
      auto_approve_threshold: Math.min(auto_approve_threshold, daily_budget),
      spent_today: 0,
      last_reset: Date.now(),
      last_activity: Date.now(),
    };

    await db.collection('agents').doc(agent.id).set({ ...agent, network_class: 'external' });

    res.status(201).json(agent);

  } catch (error) {
    console.error('Agent creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/agents
 * List all agents for user
 */
app.get('/v1/agents', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;

    const snapshot = await db.collection('agents')
      .where('user_id', '==', user_id)
      .get();

    const agents = snapshot.docs.map(doc => doc.data());

    res.json(agents);

  } catch (error) {
    console.error('Agent list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/agents/:identifier/profile - PUBLIC, no auth required
 * Must be registered BEFORE the authenticated :agentId route to avoid catch
 */
app.use('/v1/agents', createAgentProfileRouter({ db, cache }));

/**
 * GET /v1/agents/:identifier/record + /:identifier/badge.svg - PUBLIC, no auth
 * (the Agent Passport / Provenance Record; PUBLIC_LAUNCH-gated inside the
 * router). Registered BEFORE the authenticated :agentId route, same as the
 * profile router above.
 */
app.use('/v1/agents', createAgentRecordRouter({ db, cache }));

/**
 * GET /v1/agents/:agentId
 * Get a specific agent
 *
 * skipReservedAgentSegments runs FIRST: this legacy param route is registered
 * ~7,700 lines before the public agent-directory router on the same prefix,
 * so without the guard it swallows GET /v1/agents/directory and 401s a
 * documented public read (see routes/middleware/reserved-agent-segments.ts).
 */
app.get('/v1/agents/:agentId', skipReservedAgentSegments, authenticate, async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const user_id = req.user!.id;

    const doc = await db.collection('agents').doc(agentId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = doc.data() as Agent;

    if (agent.user_id !== user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(agent);

  } catch (error) {
    console.error('Agent get error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /v1/agents/:agentId
 * Update an agent
 */
app.put('/v1/agents/:agentId', skipReservedAgentSegments, authenticate, async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const user_id = req.user!.id;
    const updates = req.body;

    const doc = await db.collection('agents').doc(agentId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = doc.data() as Agent;

    if (agent.user_id !== user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Only allow updating certain fields
    const allowedUpdates: Partial<Agent> = {};
    if (updates.name) allowedUpdates.name = updates.name;
    if (updates.status) allowedUpdates.status = updates.status;
    if (updates.daily_budget) allowedUpdates.daily_budget = updates.daily_budget;
    if (updates.auto_approve_threshold) {
      allowedUpdates.auto_approve_threshold = Math.min(
        updates.auto_approve_threshold,
        updates.daily_budget || agent.daily_budget
      );
    }

    await db.collection('agents').doc(agentId).update(allowedUpdates);

    res.json({ ...agent, ...allowedUpdates });

  } catch (error) {
    console.error('Agent update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /v1/agents/:agentId
 * Delete an agent
 */
app.delete('/v1/agents/:agentId', skipReservedAgentSegments, authenticate, async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const user_id = req.user!.id;

    const doc = await db.collection('agents').doc(agentId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = doc.data() as Agent;

    if (agent.user_id !== user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.collection('agents').doc(agentId).delete();

    res.status(204).send();

  } catch (error) {
    console.error('Agent delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// ROUTES: Phone presence
// =============================================================================

/**
 * [M-15] POST /v1/security/biometric-lockout
 * Report biometric auth failure count to server for server-side tracking.
 * Fire-and-forget from client - does not block UX.
 */
app.post('/v1/security/biometric-lockout', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const { failure_count, lockout_until, device_id } = req.body;

    if (typeof failure_count !== 'number' || failure_count < 0) {
      return res.status(400).json({ error: 'Invalid failure_count' });
    }

    await db.collection('biometric_lockouts').doc(user_id).set({
      failure_count,
      lockout_until: lockout_until || null,
      device_id: device_id || null,
      updated_at: Date.now(),
    }, { merge: true });

    // If lockout triggered (>=5 failures), send a security alert to all devices.
    // Routes each registered token to Expo or FCM by format and prunes any that
    // come back permanently invalid.
    if (failure_count >= 5) {
      await sendPushToUser(db, user_id, {
        title: 'Security Alert: Multiple Failed Auth Attempts',
        body: `${failure_count} failed biometric attempts detected on your wallet.`,
        data: {
          type: 'biometric_lockout',
          user_id,
          failure_count: String(failure_count),
        },
      }).catch(() => {}); // Fire-and-forget
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[M-15] Biometric lockout report error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * [M-15] GET /v1/security/biometric-lockout
 * Check server-side biometric lockout status.
 */
app.get('/v1/security/biometric-lockout', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;

    const doc = await db.collection('biometric_lockouts').doc(user_id).get();
    if (!doc.exists) {
      return res.json({ failure_count: 0, lockout_until: null, is_locked: false });
    }

    const data = doc.data()!;
    const isLocked = data.lockout_until ? data.lockout_until > Date.now() : false;

    res.json({
      failure_count: data.failure_count || 0,
      lockout_until: data.lockout_until || null,
      is_locked: isLocked,
    });
  } catch (error) {
    console.error('[M-15] Biometric lockout check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/security/break-glass-alert
 * [FIX-8] Canary notification: sends FCM push to ALL registered devices when
 * break-glass recovery is initiated. Must fire before the 48-hour countdown
 * begins so the user can cancel from another device if this was unauthorized.
 */
app.post('/v1/security/break-glass-alert', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const { device_id } = req.body;

    const userDoc = await db.collection('users').doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await sendPushToUser(db, user_id, {
      title: 'Security Alert: Break-Glass Recovery Started',
      body: 'An emergency recovery was started for your Provian wallet. If this wasn\'t you, open Provian immediately to cancel.',
      data: {
        type: 'break_glass_canary',
        user_id,
        device_id: device_id || 'unknown',
        initiated_at: String(Date.now()),
      },
      priority: 'high',
      sound: 'default',
      contentAvailable: true,
    });

    res.json({ notified_devices: result.expoCount + result.fcmCount });

  } catch (error) {
    console.error('[BreakGlass] Alert error:', error);
    // Non-fatal - the break-glass flow should not be blocked by notification failure
    res.json({ notified_devices: 0, warning: 'Failed to send notifications' });
  }
});

/**
 * DELETE /v1/user/data
 * Delete the person's relay-side data (Delete All Data in the app, which sends this under wallet
 * auth BEFORE wiping the phone and treats only a 200 as deleted). What is deleted, released and
 * kept — bound to the Privacy Policy — is documented and implemented in
 * `core/wallet/delete-user-data.ts` (`deleteUserRelayData`). The relay keeps no PEs to delete
 * (they live on the owner's devices); earnings are kept until they mint.
 */
app.delete('/v1/user/data', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    console.log(`[UserDataDeletion] Starting deletion for user ${user_id}`);
    const result = await deleteUserRelayData(user_id, {
      db,
      invalidateDeviceCache,
      endBeneficiaryLinks: (userId) => endHumanBeneficiaryLinks(agentBankDeps, userId),
      leaveCommons: (walletId) => leaveCommons(agentBankDeps, walletId),
      invalidateAuthSecret: (userId) => cache.deleteUserAuthSecret(userId),
    });
    console.log(`[UserDataDeletion] Deleted ${result.deleted} documents for user ${user_id}`);
    res.status(200).json({ deleted: result.deleted });
  } catch (error) {
    console.error('[UserDataDeletion] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// ROUTES: Users & Devices
// =============================================================================

/**
 * POST /v1/users
 * Create or get user
 */
app.post('/v1/users', async (req: Request, res: Response) => {
  try {
    const { device_id } = req.body;

    // The app mints `device_<hex>`; bound the shape here so an arbitrary value can
    // never land in `users.devices[]` or a log line (2026-10-17).
    if (typeof device_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(device_id)) {
      return res.status(400).json({ error: 'device_id required' });
    }

    // F54: per-IP limiter. This endpoint is unauthenticated and writes two
    // durable Firestore docs per call, so without a per-caller bound one IP can
    // loop it (bounded only by the shared global 500/2s bucket) into a
    // write-amplification DoS that also inflates the users/auth_secrets
    // collections. Keyed on the trust-proxy-resolved client IP like every other
    // per-IP limiter. Fails OPEN on a Redis outage (the tree convention — the
    // global bucket remains the backstop) so a blip never blocks onboarding.
    // HIGH per the invariant: a real device calls this about once, so 60/hour/IP
    // comfortably covers reinstalls and a shared NAT while bounding a flood.
    const usersClientIp = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const usersIpRate = await cache.checkRateLimit(`rl:users-create:ip:${usersClientIp}`, 60, 3600);
      if (!usersIpRate.allowed) {
        res.set('Retry-After', String(usersIpRate.retryAfter || 3600));
        return res.status(429).json({ error: 'Too many account creations from this network. Try again later.' });
      }
    } catch (rlErr) {
      console.error('[Users] create rate-limit check failed (failing open):', rlErr);
    }

    // Accept the canonical `push_token` and the legacy `fcm_token` (what the app
    // currently sends). Either may carry an Expo OR a native token; the
    // dispatcher routes by format at send time.
    const pushToken = resolvePushToken(req.body);

    const userId = `user_${uuidv4()}`;

    // SECURITY FIX: C-1 - Generate cryptographic auth secret per user
    const authSecret = crypto.randomBytes(32).toString('hex');

    const user: User = {
      id: userId,
      created_at: Date.now(),
      fcm_tokens: pushToken ? [pushToken] : [],
      devices: [newMobileDeviceRegistration(device_id, 'Primary Device', Date.now())],
    };
    if (pushToken) user.token_type = classifyToken(pushToken);

    // F46: DO NOT persist a caller-supplied wallet_address here. This endpoint is
    // unauthenticated with no proof of address control, so accepting `wallet_address`
    // let an attacker create shell users docs carrying a VICTIM's address —
    // which then won the `limit(1)` lottery in POST /v1/users/recover and hijacked
    // the victim's recovery. An address now binds to a users doc ONLY through a
    // signed/authenticated path: /v1/wallet/human/register (wallet-HMAC auth, sets
    // users.wallet_address for its own user) or /v1/users/recover (EIP-712 signature
    // proving control). The `wallet_address` field of this request body is ignored.

    // Write user doc and auth secret to separate collections atomically
    const batch = db.batch();
    batch.set(db.collection('users').doc(userId), { ...user, network_class: 'external', devices: user.devices.map(device => ({ ...device, network_class: 'external' })) });
    batch.set(db.collection('auth_secrets').doc(userId), { secret: authSecret, created_at: Date.now() });
    await batch.commit();

    res.status(201).json({
      user_id: userId,
      auth_secret: authSecret, // Mobile stores in SecureStore, uses for HMAC signing
    });

  } catch (error) {
    console.error('User creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/users/recover
 *
 * Re-establish relay credentials after wallet recovery.
 * The caller proves ownership by signing a challenge with the wallet's private key.
 * If the wallet_address matches an existing user, rotates auth_secret and returns
 * new credentials. If no existing user is found, creates a new one.
 *
 * Signature format: EIP-712 typed data only.
 *   signature = signTypedData(domain, types, message) with
 *   domain = { name: 'Provian Relay Recovery', version: '1', chainId: 8453,
 *              verifyingContract: '0x94F3D06c...' }
 *   types  = { RelayRecovery: [user, timestamp, purpose] }
 *   message must include user_id-equivalent fields and is replay-protected
 *   via a Redis nonce keyed on the typed-data digest.
 *
 * The earlier legacy personal_sign recovery path was removed; the
 * domain-separated EIP-712 path is the only accepted format.
 */
const RECOVER_NONCE_TTL_SECONDS = 600; // 10 minutes (covers +5/-1 timestamp window with margin)

async function consumeRecoveryNonce(nonceKey: string): Promise<{ ok: boolean; available: boolean }> {
  // SETNX-style consume. Returns ok=false if already consumed (replay).
  // available=false signals Redis is unconfigured/down so the caller can fail closed.
  if (!cache.isEnabled()) {
    return { ok: false, available: false };
  }
  try {
    const accepted = await cache.setNx(nonceKey, 1, RECOVER_NONCE_TTL_SECONDS);
    return { ok: accepted, available: true };
  } catch {
    return { ok: false, available: false };
  }
}

app.post('/v1/users/recover', async (req: Request, res: Response) => {
  try {
    const {
      wallet_address,
      timestamp,
      signature,
      device_id,
      eip712,
    } = req.body as {
      wallet_address?: string;
      timestamp?: number;
      signature?: string;
      device_id?: string;
      eip712?: {
        domain?: Record<string, unknown>;
        types?: Record<string, unknown>;
        message?: Record<string, unknown>;
      };
    };

    if (!wallet_address || !timestamp || !signature || !device_id) {
      return res.status(400).json({ error: 'wallet_address, timestamp, signature, and device_id are required' });
    }
    // 2026-10-17: a NON-NUMERIC `timestamp` ("x", {}) made every age comparison below
    // `NaN > …` = false, so the +5/-1 minute window never applied and a captured recovery
    // payload replayed once its Redis nonce (10 min) lapsed — rotating the victim's auth
    // secret to the replayer. The window is a number comparison or nothing.
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)
      || typeof wallet_address !== 'string' || typeof signature !== 'string'
      || typeof device_id !== 'string' || device_id.length > 128) {
      return res.status(400).json({ error: 'wallet_address, timestamp, signature, and device_id are required' });
    }

    // Per-IP rate limit FIRST. 20 attempts per hour per IP. Strict (fail
    // closed under Redis outage) since this is security-critical. Mirrors the
    // /v1/wallet/agent/create per-IP shape (req.ip behind the Cloud Run edge).
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    {
      const ipRes = await cache.checkRateLimitStrict(`recover:ip:${clientIp}`, 20, 3600);
      if (ipRes.error === 'rate_limit_unavailable') {
        return res.status(503).json({ error: 'recovery_temporarily_unavailable' });
      }
      if (!ipRes.allowed) {
        return res.status(429).json({ error: 'Too many recovery attempts from this network. Try again later.', retry_after: ipRes.retryAfter });
      }
    }

    // Reject stale recovery attempts (+5 / -1 minute window).
    // The mobile EIP-712 path emits seconds; tolerate ms too in case a future
    // client variant emits it. Anything below year 2002 epoch ms is treated
    // as seconds.
    const tsMs = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const age = Date.now() - tsMs;
    if (age > 5 * 60 * 1000 || age < -60 * 1000) {
      return res.status(400).json({ error: 'Recovery timestamp expired or invalid' });
    }

    // Per-wallet gate: read-only check first, increment after sig verify.
    // Prevents an attacker who knows a victim's wallet_address from exhausting
    // the victim's per-wallet limit with invalid signatures.
    const walletKey = `recover:${wallet_address.toLowerCase()}`;
    if (cache.isEnabled()) {
      try {
        const current = await cache.get<number>(walletKey);
        if (typeof current === 'number' && current >= 5) {
          return res.status(429).json({ error: 'Too many recovery attempts. Try again later.', retry_after: 3600 });
        }
      } catch {
        // Read failures fall through; the post-verify increment still gates abuse.
      }
    } else {
      // Redis unavailable: recovery is security-critical, fail closed (M-5).
      return res.status(503).json({ error: 'recovery_temporarily_unavailable' });
    }

    // Verify EIP-712 typed-data signature.
    if (!eip712 || !eip712.domain || !eip712.types || !eip712.message) {
      return res.status(400).json({ error: 'eip712 { domain, types, message } is required' });
    }
    const msg = eip712.message as Record<string, unknown>;
    // The message is bound to the wallet via `user` and to time via `timestamp`.
    if (typeof msg.user !== 'string' || typeof msg.timestamp !== 'number' || typeof msg.purpose !== 'string') {
      return res.status(400).json({ error: 'eip712.message must include user (address), timestamp (uint256), and purpose (string)' });
    }
    if (msg.user.toLowerCase() !== wallet_address.toLowerCase()) {
      return res.status(400).json({ error: 'eip712.message.user does not match wallet_address' });
    }
    const msgTsMs = (msg.timestamp as number) < 1e12 ? (msg.timestamp as number) * 1000 : (msg.timestamp as number);
    if (!Number.isFinite(msgTsMs) || Math.abs(msgTsMs - tsMs) > 60 * 1000) {
      return res.status(400).json({ error: 'eip712.message.timestamp does not match request timestamp' });
    }
    // The SIGNED timestamp carries the same window as the request's (the two may differ by
    // up to a minute above, so the window is applied to both, not derived from one).
    const msgAge = Date.now() - msgTsMs;
    if (msgAge > 5 * 60 * 1000 || msgAge < -60 * 1000) {
      return res.status(400).json({ error: 'Recovery timestamp expired or invalid' });
    }
    // WS5: verify against the PINNED domain + types reconstructed server-side
    // (recovery-eip712.ts), ignoring the client-supplied eip712.domain/types.
    // Trusting the client domain meant a same-key EIP-712 signature from another
    // dApp whose struct matched {user,timestamp,purpose} could be replayed here.
    if (msg.purpose !== RECOVERY_PURPOSE) {
      return res.status(400).json({ error: 'eip712.message.purpose is not a recovery purpose' });
    }
    // Reconstruct the message from the validated fields only (drops any extra
    // attacker-supplied fields; the struct hashes exactly these three).
    const recoveryMessage = { user: msg.user, timestamp: msg.timestamp as number, purpose: msg.purpose };

    let recoveredAddress: string;
    let nonceMaterial: string;
    try {
      recoveredAddress = recoverRecoverySigner(recoveryMessage, signature);
      // Nonce material binds the typed-data digest so this exact signed payload
      // cannot be replayed within the TTL window.
      nonceMaterial = recoveryNonceMaterial(recoveryMessage);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet_address.toLowerCase()) {
      return res.status(403).json({ error: 'Signature does not match wallet_address' });
    }

    // Replay buffer: signature has verified; refuse if this exact signed
    // payload has already been consumed within the TTL window. Fail closed
    // when Redis is unavailable since this is a security-critical surface.
    const nonceKey = `recover:nonce:${crypto.createHash('sha256').update(nonceMaterial).digest('hex')}`;
    const nonceResult = await consumeRecoveryNonce(nonceKey);
    if (!nonceResult.available) {
      return res.status(503).json({ error: 'recovery_temporarily_unavailable' });
    }
    if (!nonceResult.ok) {
      return res.status(409).json({ error: 'replay_detected' });
    }

    // Increment the per-wallet counter ONLY after successful signature verify
    // so attacker-supplied invalid signatures cannot exhaust the victim's
    // 5-per-hour budget (M-6). Strict limiter: fails closed if Redis is down.
    {
      const incRes = await cache.checkRateLimitStrict(walletKey, 5, 3600);
      if (incRes.error === 'rate_limit_unavailable') {
        return res.status(503).json({ error: 'recovery_temporarily_unavailable' });
      }
      if (!incRes.allowed) {
        return res.status(429).json({ error: 'Too many recovery attempts. Try again later.', retry_after: incRes.retryAfter });
      }
    }

    // Look up existing user by wallet_address. F46: resolve ambiguity FAIL-CLOSED.
    // The old `.limit(1)` query picked an ARBITRARY users doc when several carried
    // the same address, so an attacker's shell doc (created via the old
    // unauthenticated POST /v1/users squat) could win the lottery and hand the
    // real key holder a rotated secret on an empty identity. POST /v1/users no
    // longer persists wallet_address, so no NEW duplicates form; this handles any
    // legacy duplicates. Query WITHOUT limit(1) (capped for cost); when >1 users
    // doc matches, disambiguate to the one backed by a first-party human `wallets`
    // doc for this address (written only through the authenticated register path),
    // and refuse with 409 if that is still ambiguous.
    const addressLc = wallet_address.toLowerCase();
    const newAuthSecret = crypto.randomBytes(32).toString('hex');

    // The human-wallet OWNER is authoritative (, see lookupRecoveryUser): a
    // `type: 'human'` wallets doc is written only through the authenticated register
    // path under an address-uniqueness index, and is read on EVERY recovery — a users
    // doc that predates the users.wallet_address bind (F46) is otherwise invisible
    // and the key holder would be handed a fresh shell account with no human wallet.
    const lookup = await lookupRecoveryUser(db as unknown as RecoveryLookupDb, wallet_address);
    if (lookup.kind === 'ambiguous') {
      console.warn(`[Recovery] Ambiguous recovery refused: ${lookup.usersMatched} users docs / ${lookup.owners} human owners for ${redactAddress(wallet_address)}`);
      return res.status(409).json({ error: 'ambiguous_recovery' });
    }
    if (lookup.kind === 'owner_missing') {
      // the registration's owner account is gone (its users doc was deleted), so it can
      // never authenticate again. This used to answer 409 forever and lock the key holder out.
      // The caller has just PROVEN the key, so it gets a fresh account below; its app then
      // registers WITH proof, which displaces the orphaned registration (genesis-ingress).
      console.warn(`[Recovery] Human wallet owner ${lookup.userId} has no users doc for ${redactAddress(wallet_address)}; issuing a fresh account (orphaned registration is displaceable)`);
    }
    const existingUser: User | null = lookup.kind === 'existing' ? (lookup.user as unknown as User) : null;

    if (existingUser) {
      // Re-associate: rotate auth_secret, add device
      const userId = existingUser.id;

      const devices = existingUser.devices || [];
      const existingDevice = devices.find(d => d.id === device_id);
      if (!existingDevice) {
        devices.push(newMobileDeviceRegistration(device_id, 'Recovered Device', Date.now()));
      } else {
        existingDevice.last_seen = Date.now();
      }

      const recoveryNetworkClass = await ownerParticipantClass(db, userId);
      const recoverBatch = db.batch();
      // Backfill the address bind (the key holder just proved control) so the
      // users doc carries it from here on.
      for (const device of devices) Object.assign(device, { network_class: recoveryNetworkClass });
      recoverBatch.update(db.collection('users').doc(userId), { devices, wallet_address: addressLc });
      recoverBatch.set(db.collection('auth_secrets').doc(userId), { secret: newAuthSecret, created_at: Date.now() });
      await recoverBatch.commit();

      // Invalidate Redis cache so next auth reads the new secret
      cache.setUserAuthSecret(userId, newAuthSecret).catch(() => {});

      console.log(`[Recovery] Re-associated user ${userId} with wallet ${redactAddress(wallet_address)} on device ${device_id}`);

      return res.json({
        user_id: userId,
        auth_secret: newAuthSecret,
        recovered: true,
      });
    }

    // No existing user - create a new one with the wallet_address.
    // This is a fresh credential bootstrap (recovered: false), NOT a wallet
    // recovery - label the device accordingly so it doesn't misleadingly read
    // as "Recovered Device" for someone who just created a brand-new wallet.
    const userId = `user_${uuidv4()}`;
    const user: User = {
      id: userId,
      created_at: Date.now(),
      fcm_tokens: [],
      devices: [newMobileDeviceRegistration(device_id, 'New Device', Date.now())],
      wallet_address: wallet_address.toLowerCase(),
    };

    const newUserBatch = db.batch();
    newUserBatch.set(db.collection('users').doc(userId), { ...user, network_class: 'external', devices: user.devices.map(device => ({ ...device, network_class: 'external' })) });
    newUserBatch.set(db.collection('auth_secrets').doc(userId), { secret: newAuthSecret, created_at: Date.now() });
    await newUserBatch.commit();

    console.log(`[Recovery] Created new user ${userId} for recovered wallet ${redactAddress(wallet_address)}`);

    res.status(201).json({
      user_id: userId,
      auth_secret: newAuthSecret,
      recovered: false,
    });

  } catch (error) {
    console.error('[Recovery] Error:', error);
    res.status(500).json({ error: 'Recovery failed' });
  }
});

/**
 * POST /v1/users/:userId/fcm-token
 * Register a push token (Expo or native FCM) for push notifications.
 * Accepts either `push_token` (canonical) or `fcm_token` (legacy) in the body.
 */
app.post('/v1/users/:userId/fcm-token', authenticate, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (req.user!.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Accept the canonical `push_token` and the legacy `fcm_token`. `push_token`
    // wins if both are present. The dispatcher routes by token format at send
    // time, so an Expo or a native token is stored identically here.
    const pushToken = resolvePushToken(req.body);
    if (!pushToken) {
      return res.status(400).json({ error: 'push_token or fcm_token required' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userDoc.data() as User;
    const tokenType = classifyToken(pushToken);
    if (!user.fcm_tokens.includes(pushToken)) {
      user.fcm_tokens.push(pushToken);
      await db.collection('users').doc(userId).update({
        fcm_tokens: user.fcm_tokens,
        token_type: tokenType,
        [`push_languages.${pushTokenHash(pushToken)}`]: pushLanguage(req.body.language),
      });
    } else {
      // Token already registered - refresh the derived type (idempotent).
      await db.collection('users').doc(userId).update({ token_type: tokenType, [`push_languages.${pushTokenHash(pushToken)}`]: pushLanguage(req.body.language) });
    }

    res.status(204).send();

  } catch (error) {
    console.error('Push token registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// ROUTES: Provenance Envelopes
// =============================================================================

/**
 * GET /v1/provenance-envelopes, GET /v1/provenance-envelopes/summaries
 * PATCH /v1/provenance-envelopes/:peId/hidden
 *
 * PE METER : the relay no longer stores PEs. They live with their
 * owner — the daemon/SDK local store, and the phone's own iCloud/Drive backup — so a full listing
 * of PE bodies (and the recovery walk's "Source 2" summaries) is the device's job, and hiding a
 * PE is a display flag on the device. These answer 410 `pe_kept_by_owner`, naming where PEs live.
 * The relay's own per-act view is the priced recent-activity list (`GET /v1/pvt/history`).
 *
 * `/summaries` is declared BEFORE any '/v1/provenance-envelopes/:peId' route so the literal
 * 'summaries' path is never captured as a :peId param.
 */
app.get('/v1/provenance-envelopes', authenticate, (_req: Request, res: Response) => {
  sendPeKeptByOwner(res);
});

app.get('/v1/provenance-envelopes/summaries', authenticate, (_req: Request, res: Response) => {
  sendPeKeptByOwner(res);
});

app.patch('/v1/provenance-envelopes/:peId/hidden', authenticate, (_req: Request, res: Response) => {
  sendPeKeptByOwner(res, { hint: 'hide a PE in the app; the flag is a display choice on the owner’s device' });
});

/**
 * DELETE /v1/provenance-envelopes/:peId
 * BLOCKED - Provenance Envelopes are immutable and cannot be deleted.
 */
app.delete('/v1/provenance-envelopes/:peId', authenticate, (_req: Request, res: Response) => {
  res.status(403).json({ error: 'Provenance Envelopes are immutable and cannot be deleted.' });
});

// =============================================================================
// ROUTES: Relay - Connection Token
// =============================================================================

// In-app connection-code validity. 1 hour so a slow one-command agent bootstrap
// never expires mid-setup (was 15m). Mirrors the email path's 1h window.
const CONNECTION_TOKEN_IN_APP_TTL_MS = 60 * 60 * 1000;

/**
 * POST /v1/relay/connection-token
 * Phone generates a connection token for the Connect Agent screen
 */
app.post('/v1/relay/connection-token', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const { label, beneficiary_link, recovery_anchor_pubkey } = req.body;

    const beneficiaryLinkRejection = rejectEmbeddedBeneficiaryLink(beneficiary_link);
    if (beneficiaryLinkRejection) {
      return res.status(409).json(beneficiaryLinkRejection);
    }

    // Optional phone-minted recovery anchor (two-touch onboarding). If present it
    // must be a well-formed 32-byte x25519 public key; a malformed one is a client
    // bug, not something to silently drop, so fail closed with a plain message.
    if (recovery_anchor_pubkey !== undefined && !isValidAnchorPubkeyB64u(recovery_anchor_pubkey)) {
      return res.status(400).json({ error: 'recovery_anchor_pubkey must be a base64url 32-byte x25519 public key' });
    }

    const token = generateConnectionToken();
    const now = Date.now();
    // 1-hour validity ("link codes expire in an hour",). The old 15-minute
    // window could expire mid-setup while the agent ran the one-command bootstrap
    // (create wallet -> register -> daemon -> file link request). Nothing burns a
    // human code (the relay connect that once did was retired,): /create and
    // /v1/bootstrap/agent only read it, and request-link enforces expires_at and
    // files one pending request per agent. The app's Connect screen can regenerate
    // without a restart. (A fleet code — POST /v1/agent/wallet/:id/fleet-code — is
    // the single-use kind; see core/agent-wallet/fleet-code.ts.)
    const expiresAt = now + CONNECTION_TOKEN_IN_APP_TTL_MS;

    const connectionToken: ConnectionToken = {
      token,
      user_id,
      created_at: now,
      expires_at: expiresAt,
      used: false,
    };

    // Only add label if provided (Firestore doesn't accept undefined)
    if (label) {
      connectionToken.label = label;
    }
    if (recovery_anchor_pubkey) {
      connectionToken.recovery_anchor_pubkey = recovery_anchor_pubkey;
    }

    await db.collection('connection_tokens').doc(token).set(connectionToken);
    // Write-through cache for the immediate connect flow (30s TTL).
    await cache.setConnectionToken(token, {
      user_id,
      expires_at: expiresAt,
      used: false,
      ...(recovery_anchor_pubkey ? { recovery_anchor_pubkey } : {}),
    });

    // Get relay URL from environment or use default custom domain
    const relayUrl = process.env.RELAY_URL || 'https://api.provian.ai';

    res.status(201).json({
      connection_token: token,
      relay_url: relayUrl,
      expires_at: expiresAt,
    });

  } catch (error) {
    handleEndpointError(res, error, 'Connection token');
  }
});

// =============================================================================
// ROUTE: Email a ready-to-run connect/setup command to the user
// =============================================================================
// Wallet auth only. This mints a setup token, so it must never be reachable by
// an agent credential — `authenticate` only accepts wallet HMAC tokens (or a
// short-lived setup token), never an agent API key (the agent session is gone,
//), so the boundary holds.
//
// Setup tokens minted here use a 1-hour TTL (the same window as the in-app
// connection code): email can arrive minutes after the request, and the token
// must still be live when the user opens it on their computer. The setup_tokens
// Firestore write is awaited before the email is sent, so the consumer always
// finds it. This delivers the single command by email so the user never has to
// retype a token onto a second device.
const EMAIL_CONNECT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_ADDRESS_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/v1/relay/connect/email-command', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const kind = req.body?.kind;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

    // kind 'agent' (the keyless `provian connect` session) no longer exists.
    if (kind !== 'device' && kind !== 'agent_device') {
      return res.status(400).json({ error: "kind must be 'device' or 'agent_device'" });
    }
    if (!EMAIL_ADDRESS_REGEX.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (EMAIL_DISABLED) {
      return res.status(503).json({ error: 'email_unavailable' });
    }

    // Email-abuse anti-spam (M5). This sends Provian-branded email to a
    // user-supplied address, so cap hard and fail CLOSED on a Redis outage:
    //   - per-user: 5/hour (existing)
    //   - per-email: 5/day (new) - prevents one user blasting one address.
    const emailHash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
    const rl = await cache.checkRateLimitStrict(`email-connect-cmd:user:${user_id}`, 5, 3600);
    if (rl.error === 'rate_limit_unavailable') {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many setup emails. Try again later.', retry_after: rl.retryAfter });
    }
    const rlEmail = await cache.checkRateLimitStrict(`email-connect-cmd:email:${emailHash}`, 5, 86400);
    if (rlEmail.error === 'rate_limit_unavailable') {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    if (!rlEmail.allowed) {
      return res.status(429).json({ error: 'Too many setup emails. Try again later.', retry_after: rlEmail.retryAfter });
    }

    const now = Date.now();
    const expiresAt = now + EMAIL_CONNECT_TOKEN_TTL_MS;
    let command: string;
    let windowsCommand: string | undefined;

    if (kind === 'device') {
      // Device registration token (mirrors POST /v1/setup/generate-token).
      const token = crypto.randomBytes(32).toString('hex');
      await db.collection('setup_tokens').doc(token).set({
        user_id,
        type: 'device_registration',
        created_at: now,
        expires_at: expiresAt,
        used: false,
      });
      // Pre-flip the SDK is unpublished (npm E404), so the emailed line is the
      // hosted curl flow — the exact endpoint that consumes this token. The
      // idempotency key is minted here so a re-run replays instead of failing.
      command = buildDeviceRegisterCommand({
        token,
        idempotencyKey: mintCommandIdempotencyKey(),
      });
    } else if (kind === 'agent_device') {
      // Agent-owned device registration (human-initiated path). Authorize via
      // the agent wallet's linked_human_user_id. M8 ordering prevents a
      // null-equality bypass: existence -> active -> non-null linked id ===
      // req.user.id. The minted token registers a device to the agent wallet so
      // future device PEs attribute to the agent chain.
      const agentWalletId =
        typeof req.body?.agent_wallet_id === 'string' ? req.body.agent_wallet_id : '';
      if (!agentWalletId) {
        return res.status(400).json({ error: 'agent_wallet_id is required for kind="agent_device"' });
      }

      const agentDoc = await db.collection('agent_wallets').doc(agentWalletId).get();
      if (!agentDoc.exists) {
        return res.status(404).json({ error: 'Agent wallet not found' });
      }
      const agentWallet = agentDoc.data() as AgentWalletDocument;
      if (agentWallet.status !== 'active') {
        return res.status(403).json({ error: 'Agent wallet is not active' });
      }
      if (
        !agentWallet.linked_human_user_id ||
        agentWallet.linked_human_user_id !== user_id
      ) {
        return res.status(403).json({ error: 'Not your agent' });
      }

      // Mint the agent-device-registration token. Field ALLOWLIST (M6): write
      // ONLY these keys. NEVER write api_key/api_secret/hash/salt. owner_address
      // comes from the loaded wallet doc (source of truth).
      const token = crypto.randomBytes(32).toString('hex');
      await db.collection('setup_tokens').doc(token).set({
        agent_wallet_id: agentWalletId,
        agent_id: agentWallet.agent_id,
        owner_type: 'agent',
        owner_address: agentWallet.address || '',
        type: 'agent_device_registration',
        created_at: now,
        expires_at: expiresAt,
        used: false,
        email_hash: emailHash,
      });
      // the hosted agent-device installer — the SAME SHA-pinned bundle
      // the Connect line runs, which registers this machine to the agent's
      // wallet and installs + starts the observer (a bare register POST left
      // the machine with nothing witnessing). The token is still honored only
      // at POST /v1/devices/register (device-register-auth middleware).
      const lines = buildAgentDeviceInstallLines(token, resolveRelayUrl());
      command = lines.sh;
      windowsCommand = lines.powershell;
    } else {
      // Unreachable (the kind guard above admits exactly the two branches); kept so
      // `command` is definitely assigned and a future kind cannot fall through silently.
      return res.status(400).json({ error: "kind must be 'device' or 'agent_device'" });
    }

    const sent = await sendConnectCommand(email, kind, command, expiresAt, undefined, undefined, windowsCommand, 'app', req.body?.language);
    if (!sent) {
      return res.status(502).json({ error: 'email_send_failed' });
    }

    res.status(200).json({ sent: true, expires_at: expiresAt });
  } catch (error) {
    handleEndpointError(res, error, 'Email connect command');
  }
});

// =============================================================================
// ROUTES: Relay - Agent Connection
// =============================================================================

/**
 * GET /v1/relay/agent/sessions
 * The human's linked agents (agent wallets naming this human as beneficiary).
 * relay agent sessions no longer exist, so the response carries ONLY
 * `linked_agents`; the route path is kept so deployed apps keep working.
 */
app.get('/v1/relay/agent/sessions', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    // This is live owner state. iOS URLSession otherwise revalidates Express's
    // ETag and receives 304, which older clients interpreted as an empty list.
    res.set('Cache-Control', 'private, no-store, max-age=0');
    // Also fetch agent wallets linked to this human as beneficiary
    const linkedSnap = await db.collection('agent_wallets')
      .where('linked_human_user_id', '==', user_id)
      .where('status', '==', 'active')
      .get();

    // Earn only needs identity truth to render "Connected" instead of "Set up".
    // Skip the three per-agent enrichment reads so that truth is not held behind
    // PE-count, device-health, or external-address latency. The full Agent Hub
    // response remains the default for deployed clients.
    if (req.query.view === 'identity') {
      res.json({
        linked_agents: linkedSnap.docs.map((doc) => projectLinkedAgentIdentity(doc.id, doc.data())),
      });
      return;
    }

    // the LIVE PE count is each agent's running total (one point read per
    // agent, `countVisibleAgentPEs`), so BOUND the fan-out — compute it for at most this many linked agents (the
    // common case is 1–few); beyond the cap return the same zero fallback used
    // for an enrichment failure. This keeps the endpoint's cost bounded
    // regardless of how many agents a human links.
    const LIVE_COUNT_FANOUT_CAP = 25;
    const linked_agents = await Promise.all(linkedSnap.docs.map(async (doc, idx) => {
      const w = doc.data();
      const identity = projectLinkedAgentIdentity(doc.id, w);
      // The LIVE visible PE count (same source as the pe-activity endpoint).
      // the stored agent_wallets.pe_count tally is deleted, so there is no
      // stored fallback — a per-agent read failure falls back to 0 rather than a
      // stale field, and one bad query never 500s the whole list.
      // the card must read CAPTURE-HEALTH of the agent's EARNING
      // device, not the session-connect heartbeat (`session.last_active`), which
      // froze on 2026-08-26 while Atlas kept earning via the device path — the
      // stale "last activity" bug. The linked wallet IS the earning identity
      // (one wallet, one device), so read the freshest agent-owned device's
      // capture_health. `last_capture_at_ms` is the REAL last activity; `broken`
      // catches a fresh silence even when a PE landed today. Bounded fan-out,
      // best-effort (one bad query never fails the list).
      // Display-only: has this agent PROVEN control of an external Base wallet it
      // already runs (an economically-active proven-address record)? Surfaces the
      // "external wallet linked" indicator on the operator's agent cards.
      // Best-effort, bounded by the same fan-out cap; a read failure just reads as
      // "not linked". Never a mint/eligibility decision — that stays in the
      // watcher, keyed on proven_addresses, not on this display flag.
      // These enrichments are independent. Running them serially made Atlas's
      // one-agent response take 7–23 seconds in production; the five-second hub
      // poll then stacked overlapping requests until some failed at the edge.
      const [pe_count, capture, external_address_linked] = await Promise.all([
        (async (): Promise<number> => {
          if (!w.agent_id || idx >= LIVE_COUNT_FANOUT_CAP) return 0;
          try { return await countVisibleAgentPEs(db, w.agent_id); }
          catch { return 0; }
        })(),
        (async (): Promise<ReturnType<typeof linkedAgentCaptureFields>> => {
          const empty = {
            last_capture_at_ms: null,
            capture_reported_at_ms: null,
            capture_broken: false,
            capture_broken_reason: null,
            capture_receiving: true,
            capture_broken_since_ms: null,
          } as const;
          if (idx >= LIVE_COUNT_FANOUT_CAP) return empty;
          try {
            const devSnap = await db.collection('devices').where('owner_wallet_id', '==', doc.id).get();
            let best: FirebaseFirestore.DocumentData | null = null;
            let bestT = -1;
            for (const dd of devSnap.docs) {
              const d = dd.data();
              if (d.owner_type !== 'agent') continue;
              const ch = d.capture_health;
              const t = (ch && typeof ch.updated_at === 'number') ? ch.updated_at
                : (typeof d.last_pe_at === 'number' ? d.last_pe_at : 0);
              if (t > bestT) { bestT = t; best = d; }
            }
            if (!best) return empty;
            return linkedAgentCaptureFields((best.capture_health || {}) as Record<string, unknown>, best.last_pe_at);
          } catch { return empty; }
        })(),
        (async (): Promise<boolean> => {
          if (!w.agent_id || idx >= LIVE_COUNT_FANOUT_CAP) return false;
          try { return await hasProvenExternalAddress(db, w.agent_id); }
          catch { return false; }
        })(),
      ]);
      return {
        ...identity,
        pe_count,
        external_address_linked,
        // capture-health of the earning device — the card's truthful
        // "is it receiving now / last real activity" source.
        ...capture,
      };
    }));

    res.json({ linked_agents });

  } catch (error) {
    handleEndpointError(res, error, 'Sessions list');
  }
});

// GET /v1/relay/agent/:agentId/pe-activity - a human reads the PE activity of an
// agent they own (linked as beneficiary). Powers the Recent Activity list on the
// agent detail screen. Human WALLET auth + ownership guard (the agent's
// linked_human_user_id must equal the caller). PE METER: `pe_count` is the agent's
// running total; `entries` are its live (≤31-day) act keys, priced rows only — the
// agent's PEs themselves live on its own machine (and in the human's mailbox/backup).
// Read-only; never mutates.
app.get('/v1/relay/agent/:agentId/pe-activity', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const { agentId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);

    // Ownership: the agent wallet must be linked to THIS human.
    const walletSnap = await db.collection('agent_wallets')
      .where('agent_id', '==', agentId)
      .limit(1)
      .get();
    if (walletSnap.empty) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }
    const wallet = walletSnap.docs[0].data();
    if (wallet.linked_human_user_id !== user_id) {
      res.status(403).json({ error: 'agent is not linked to this account' });
      return;
    }

    // the ONE live-count source, shared with the sessions list so every
    // surface shows the same number (was: stale agent_wallets.pe_count on the
    // hub card vs live count here).
    //
    // Beneficiary view: this human is the agent's linked beneficiary (guarded
    // above), so we surface the human's projected beneficiary PVT from this
    // agent — the SAME eligible-only, PVT9-native settlement projection the
    // dashboard serves, fail-closed to null on any factor error. The
    // split is READ from each PE's sealed `beneficiaryAgentShareBps`, never
    // re-derived here (display-only, no money-path change).
    const projectionContext = await readDashboardSettlementProjectionContext();
    const { peCount, entries, beneficiary } = await fetchAgentPEActivity(db, agentId, limit, {
      beneficiaryUserId: user_id,
      projectionContext,
    });

    // The human's CURRENT share of this link. `operational_reserve_bps` is the
    // agent's share (default 2000 = 20% agent / 80% human); the human receives
    // the remainder. Read-only display of the live link setting.
    const agentShareBps = typeof wallet.operational_reserve_bps === 'number'
      ? wallet.operational_reserve_bps
      : 2000;

    res.json({
      agent_id: agentId,
      pe_count: peCount,
      entries,
      solana_address: (wallet.chain_addresses && wallet.chain_addresses.solana) || null,
      beneficiary: {
        agent_share_bps: agentShareBps,
        human_share_bps: 10000 - agentShareBps,
        pe_count: beneficiary?.peCount ?? 0,
        projection_available: (beneficiary?.projectedPendingPvtAtomic ?? null) !== null,
        projected_pending_pvt: beneficiary?.projectedPendingPvt ?? null,
        projected_pending_pvt_atomic: beneficiary?.projectedPendingPvtAtomic ?? null,
      },
    });
  } catch (error) {
    handleEndpointError(res, error, 'Agent PE activity');
  }
});

// =============================================================================
// CORROBORATION
// =============================================================================
//
// The placeholder `corroborateMatchingPE` that previously lived here was a
// parallel implementation that nothing called. Step 4b (Witness 3 GitHub
// webhook, PR #54 → follow-up) folded its job into the LIVE
// `emitBackendCorroboration` path in `core/corroboration/CorroborationManager.ts`
// - one corroboration mechanism, not two. The Witness 3 cross-witness
// path uses the new `'github_webhook_attestation'` signal type, which
// maps to corroboration_status `'service_grant_attested'` (recognized at
// corroborated tier by the PVT9 claim inlet, `core/pvt/wp4/claim-inlet-source.ts`). The commit-hash
// lookup helper used by the webhook handler is in
// `core/witnesses/pe-lookup.ts`.

// =============================================================================
// API PROXY ROUTES (G-1 Security Fix)
// =============================================================================
// These endpoints proxy requests to external APIs, adding API keys server-side.
// This prevents API keys from being embedded in the mobile app binary.

/**
 * POST /api/proxy/alchemy/rpc/:network
 * Proxy for Alchemy JSON-RPC API
 * External: https://{network}.g.alchemy.com/v2/{API_KEY}
 */
app.post('/api/proxy/alchemy/rpc/:network', authenticate, createAlchemyRpcHandler({
  // Own-property check: `constructor`/`toString` are truthy on a plain object
  // and would otherwise build a URL around the API key (which then lands in logs).
  upstreamUrlFor: (network) => (Object.prototype.hasOwnProperty.call(ALCHEMY_NETWORKS, network)
    ? `https://${ALCHEMY_NETWORKS[network]}.g.alchemy.com/v2/${PROXY_CONFIG.alchemy.apiKey}`
    : null),
  apiKeyConfigured: () => Boolean(PROXY_CONFIG.alchemy.apiKey),
  checkProxyRateLimit,
  rateLimitPerMin: PROXY_CONFIG.alchemy.rpcRateLimit,
  // H-4 + one 10 s deadline over connect + headers + body, body capped.
  fetch: (url, init, maxBytes) => fetchWithTimeout(url, init, PROXY_FETCH_TIMEOUT_MS, maxBytes),
  forwardUpstreamResponse,
  isUpstreamTimeout: (err) => err instanceof UpstreamTimeoutError,
  logError: (label, err) => console.error(label, redactedErrorForLog(err)),
}));

/**
 * GET /api/proxy/prices — the wallet's USD price feed (item 5). The phone no
 * longer calls CoinGecko itself (CoinGecko's CDN blocks per client IP); the relay
 * fetches server-side, holds each answer 60 s, and keeps a durable per-symbol
 * last-known copy so a down source is answered with last-known prices and their
 * ages — never $0.00. See core/prices/price-feed.ts.
 */
const walletPriceFeed = createPriceFeed({
  fetch: (url, init) => fetchWithTimeout(url, init, PRICE_FEED_UPSTREAM_TIMEOUT_MS, PRICE_FEED_MAX_RESPONSE_BYTES),
  now: () => Date.now(),
  coingeckoApiKey: process.env.COINGECKO_API_KEY || undefined,
  alchemyApiKey: PROXY_CONFIG.alchemy.apiKey || undefined,
  loadLastKnown: async () => {
    const snap = await db.collection(PRICE_FEED_COLLECTION).doc(PRICE_FEED_DOC).get();
    return snap.exists ? (snap.data() as PriceFeedSnapshot) : null;
  },
  saveLastKnown: async (snapshot) => {
    await db.collection(PRICE_FEED_COLLECTION).doc(PRICE_FEED_DOC).set(snapshot);
  },
  logWarn: (label, err) => console.warn(label, redactedErrorForLog(err)),
});

app.get('/api/proxy/prices', authenticate, async (req: Request, res: Response) => {
  try {
    if (!(await checkProxyRateLimit(req.user!.id, 'prices', 30))) {
      res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json(await walletPriceFeed.read());
  } catch (err) {
    console.error('[price-feed] read failed', redactedErrorForLog(err));
    res.status(503).json({ error: 'Price feed unavailable', code: 'PRICE_FEED_UNAVAILABLE' });
  }
});

// P4-14 (Pass-4 reachability audit): the /api/proxy/onramper/* handler was
// removed. Onramper is retired as a fiat on-ramp — Coinbase Onramp (below) is
// the sole live path. The handler 503'd on a blank ONRAMPER_API_KEY and had no
// remaining client caller after the Coinbase cutover, so it was a dead
// affordance. The PROXY_CONFIG.onramper entry and the mobile getOnramperUrl
// helper were removed alongside it.

/**
 * POST /api/proxy/coinbase/session-token
 * Coinbase Onramp secure initialization. Mints a single-use session token
 * server-side (CDP Secret API Key) so the wallet address never travels as a
 * query param. The app passes the returned token into the onramp URL.
 *
 * Wallet auth only (human buy flow). Returns { token }.
 * 503 if CDP credentials are not provisioned; 502 on upstream failure.
 */
app.post('/api/proxy/coinbase/session-token', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { address, assets } = (req.body || {}) as { address?: unknown; assets?: unknown };
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: 'Valid EVM address required' });
    return;
  }

  // Coinbase wants the real end-user IP. Behind Cloud Run that is `req.ip` under
  // `trust proxy 1` (the entry the Google front end APPENDED); the FIRST
  // X-Forwarded-For entry is whatever the client itself sent, so it was spoofable.
  const clientIp = req.ip || undefined;

  try {
    const { token } = await createCoinbaseSessionToken({
      address,
      assets: Array.isArray(assets) ? assets.filter((a): a is string => typeof a === 'string') : undefined,
      clientIp,
    });
    // Return the stable per-user partnerUserRef so the device attaches it as the
    // `partnerUserId` query param on the pay.coinbase.com buy URL. Coinbase links
    // every session transaction to this ref; it is the join key the relay uses to
    // later confirm the buy on-chain via GET /onramp/v1/buy/user/{ref}/transactions
    // (#30 relay-side source verification). Deterministic (derived from the
    // authenticated user), non-PII, recomputed relay-side at verify time.
    res.json({ token, partnerUserRef: deriveOnrampPartnerRef(userId) });
  } catch (err) {
    if (err instanceof CoinbaseNotConfiguredError) {
      res.status(503).json({ error: 'coinbase_onramp_not_configured' });
      return;
    }
    console.error('[Coinbase] session token error:', err);
    res.status(502).json({ error: 'coinbase_session_token_failed' });
  }
});

/**
 * POST /api/proxy/coinbase/verify-buy
 * Relay-side confirmation that a device's pending on-ramp deposit actually came
 * from a Coinbase buy (#30). Queries the CDP Transaction Status API for the
 * authenticated user's `partnerUserRef` and, on a settled SUCCESS matching the
 * device's wallet, SERVER-MINTS a verified `onramp` PE into the user's canonical
 * chain (deduped by Coinbase transaction_id) — the source attribution is thus
 * relay-verified, not device-asserted (which on-device attribution can't be).
 *
 * DESIGN DECISION (server-mint vs device-bind) — SIGNED OFF 2026-07-02 :
 * SERVER-MINT is authoritative. The relay owns the verified-onramp PE. Rationale:
 * (1) the whole reason #30 was deferred is that only the relay can PROVE a
 * Coinbase source; a device-bound PE would still be device-asserted for
 * `source`. (2) The relay already owns canonical chain-tip advancement for
 * mobile PEs (advanceChainTipWithProvisionalPE), so recording a verified PE is
 * the same primitive the mobile-submit path uses — no parallel chain. (3) It
 * mirrors the existing verified transfer/record precedent (tx_hash-idempotent,
 * relay re-checked). The device treats a verified result as authoritative and
 * SKIPS its own (source-unverified) heuristic mint, so there is exactly one
 * onramp PE per buy. This path is live (no decision-pending flag).
 *
 * Wallet auth only. Returns { verified, status,..., pe_id? }.
 * 503 if CDP creds absent; 429 if CDP rate-limits; 502 on upstream failure.
 */
app.post('/api/proxy/coinbase/verify-buy', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { address, sinceMs } = (req.body || {}) as { address?: unknown; sinceMs?: unknown };
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: 'Valid EVM address required' });
    return;
  }
  const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : undefined;

  // Rate-limit the same way as the other Coinbase proxy path (per-user).
  if (!(await checkProxyRateLimit(userId, 'coinbase_verify', 10))) {
    res.status(429).json({ error: 'RATE_LIMITED' });
    return;
  }

  try {
    const partnerUserRef = deriveOnrampPartnerRef(userId);
    const page = await fetchOnrampTransactions(partnerUserRef, { pageSize: 10 });
    const decision = decideOnrampVerification(page, { walletAddress: address, sinceMs: since });

    if (decision.kind !== 'verified') {
      res.json({ verified: false, status: decision.kind }); // 'in_progress' | 'none'
      return;
    }

    const { tx } = decision;
    const txId = tx.transactionId;
    if (!txId) {
      // A SUCCESS with no stable id can't be safely deduped — don't mint.
      res.json({ verified: false, status: 'none', reason: 'missing_transaction_id' });
      return;
    }

    // Idempotency: exactly one verified PE per Coinbase transaction_id. Claim the
    // marker TRANSACTIONALLY (create-if-absent) BEFORE minting, so two concurrent
    // verify calls for the same buy (e.g. two devices on one account) can't each
    // advance the chain with a distinct PE — the chain tip serializes them onto
    // DIFFERENT prev_hashes, so content-hash dedup would NOT catch the double.
    // The loser returns idempotent. The claim is released (deleted) if minting
    // fails, so a mint is never permanently blocked by an orphaned marker.
    const markerRef = db.collection('onramp_verified_transactions').doc(txId);
    const claim = await db.runTransaction(async (t) => {
      const snap = await t.get(markerRef);
      if (snap.exists) {
        return { claimed: false, prior: snap.data() as { pe_id?: string; user_id?: string } };
      }
      t.create(markerRef, {
        user_id: userId,
        tx_hash: tx.txHash ?? null,
        status: 'minting',
        created_at: Date.now(),
      });
      return { claimed: true, prior: null as { pe_id?: string } | null };
    });
    if (!claim.claimed) {
      res.json({
        verified: true,
        idempotent: true,
        status: 'success',
        tx_hash: tx.txHash,
        transaction_id: txId,
        purchase_amount: tx.purchaseAmount,
        purchase_currency: tx.purchaseCurrency,
        pe_id: claim.prior?.pe_id ?? null,
      });
      return;
    }

    // Server-mint the verified onramp PE into the user's canonical chain, using
    // the SAME primitive the mobile-submit path uses. The verification evidence
    // rides in `metadata` (part of the hashed canonical content — tamper-evident);
    // `durability` is storage-only and never enters the hash.
    const peId = uuidv4();
    const timestamp = Date.now();
    const amountValue = tx.purchaseAmount?.value ?? null;
    // PE METER: a relay-authored PE v2 — the verification evidence rides in `metadata` (hashed,
    // tamper-evident); the human-readable line is the PE's free-text `description`, which the
    // relay never keeps (it reaches the owner only inside the sealed copy).
    const onrampContent: Record<string, unknown> = {
      wallet_id: userId,
      user_id: userId,
      actor_address: address.toLowerCase(),
      attestation_type: 'software_verified',
      description: amountValue
        ? `Verified Coinbase on-ramp: ${amountValue} ${tx.purchaseCurrency ?? 'USDC'}`
        : 'Verified Coinbase on-ramp',
      metadata: {
        onramp: {
          verified: true,
          source: 'coinbase',
          transaction_id: txId,
          tx_hash: tx.txHash,
          network: tx.purchaseNetwork,
          purchase_amount: tx.purchaseAmount,
          purchase_currency: tx.purchaseCurrency,
        },
      },
      compute: null,
      geo: null,
      execution_env: null,
      cited_pe_ids: null,
      parent_goal_pe_id: null,
    };
    const peCreatedAt = Date.now();

    // cutover reconciliation: ONE pure builder feeds both the durable ordinary-accrual intake
    // row (co-committed inside the tip transaction) and the live accrual call.
    // The intake grants NO mint/settlement authority — best-effort transport
    // stays sealed record_only.
    const buildAccrualParams = (committedPeHash: string): RecordPEAccrualParams => ({
      peId,
      userId,
      actionType: 'onramp',
      integrationSource: 'coinbase_onramp_verifier',
      attestationDepth: 'software_verified',
      peHash: committedPeHash,
      timestamp,
      inputSummary: 'Coinbase on-ramp (relay-verified)',
      tx_hash: tx.txHash ?? undefined,
      isDevicePE: true,
      attestation_verified: true,
      ownerType: 'human',
      walletAddress: address.toLowerCase(),
    });

    let onrampPeHash: string;
    let onrampIntake: RelayActIntake;
    try {
      const advanced = await advanceRelayAct(db, {
        actorId: userId,
        walletId: userId,
        ownerType: 'human',
        peId,
        timestamp,
        actionType: 'onramp',
        content: onrampContent,
        accrual: buildAccrualParams,
        validateTimestampAgainstTip: true,
      });
      onrampPeHash = advanced.peHash;
      onrampIntake = advanced.intake;
    } catch (chainErr) {
      console.error(`[Coinbase] verified-onramp chain advance failed for ${userId}:`, chainErr);
      // Release the claim so a retry can re-mint (never orphan the marker on a
      // failed mint, which would permanently block this buy's verified PE).
      await markerRef.delete().catch(() => {});
      res.status(409).json({ error: 'chain_contention', message: 'Please retry.' });
      return;
    }

    cache.set(`pe:latest:${userId}`, onrampPeHash, 300).catch(() => {});

    // Finalize the claim (already created above) with the minted pe_id, so a
    // later idempotent replay returns it.
    await markerRef.set({ pe_id: peId, status: 'minted', created_at: peCreatedAt }, { merge: true });

    // Price it through the meter (the staged intake is the replay source if this is lost).
    priceRelayAct(db, onrampIntake).catch((accErr) => {
      console.error('[Coinbase] verified-onramp pricing failed (replay sweep will finish it):', accErr);
    });

    res.json({
      verified: true,
      status: 'success',
      tx_hash: tx.txHash,
      transaction_id: txId,
      purchase_amount: tx.purchaseAmount,
      purchase_currency: tx.purchaseCurrency,
      pe_id: peId,
    });
  } catch (err) {
    if (err instanceof CoinbaseNotConfiguredError) {
      res.status(503).json({ error: 'coinbase_onramp_not_configured' });
      return;
    }
    if (err instanceof CoinbaseTransactionsError) {
      const status = err.kind === 'rate_limited' ? 429 : 502;
      res.status(status).json({ error: 'coinbase_transactions_failed', kind: err.kind });
      return;
    }
    console.error('[Coinbase] verify-buy error:', err);
    res.status(502).json({ error: 'coinbase_verify_failed' });
  }
});

// Etherscan-family network to API base URL mapping
const EXPLORER_NETWORKS: Record<string, string> = {
  'ethereum': 'https://api.etherscan.io/api',
  'base': 'https://api.basescan.org/api',
  'arbitrum': 'https://api.arbiscan.io/api',
  'optimism': 'https://api-optimistic.etherscan.io/api',
};

/**
 * GET /api/proxy/explorer/:network
 * Proxy for Etherscan-family block explorer APIs
 * External: https://api.{network}.io/api?apikey={KEY}&... (per-chain)
 */
app.get('/api/proxy/explorer/:network', authenticate, async (req: Request, res: Response) => {
  try {
    const user_id = req.user!.id;
    const { network } = req.params;

    if (!Object.prototype.hasOwnProperty.call(EXPLORER_NETWORKS, network)) {
      return res.status(400).json({ error: `Unknown explorer network: ${network}`, code: 'INVALID_NETWORK' });
    }

    if (!(await checkProxyRateLimit(user_id, 'explorer', PROXY_CONFIG.explorer.rateLimit))) {
      return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    }

    const apiKey = PROXY_CONFIG.explorer.apiKeys[network];
    if (!apiKey) {
      console.error(`[Proxy] Explorer API key not configured for ${network}`);
      return res.status(503).json({ error: 'Service not configured', code: 'SERVICE_UNAVAILABLE' });
    }

    console.log(`[Proxy] Explorer ${network} [GET] for user ${user_id}`);

    // Build external URL, injecting the API key
    const queryParams = new URLSearchParams(req.query as Record<string, string>);
    queryParams.set('apikey', apiKey);
    const externalUrl = `${EXPLORER_NETWORKS[network]}?${queryParams.toString()}`;

    // H-4: 10s timeout via AbortController.
    const externalRes = await fetchWithTimeout(externalUrl);
    const data = await externalRes.json();

    // Pass through upstream 4xx status + sanitized body (for user-actionable
    // errors like Alchemy free-tier limits); translate
    // 5xx to opaque 502 (real infrastructure failure). See
    // forwardUpstreamResponse() and sanitizeUpstreamBody() for details.
    forwardUpstreamResponse(res, externalRes, data);

  } catch (error) {
    if (error instanceof UpstreamTimeoutError) {
      console.warn('[Proxy] Explorer timeout:', error.url);
      return res.status(504).json({ error: 'Upstream timed out', code: 'UPSTREAM_TIMEOUT' });
    }
    if (error instanceof ResponseTooLargeError) {
      return res.status(502).json({ error: 'Upstream response too large', code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
    }
    console.error('[Proxy] Explorer error:', redactedErrorForLog(error));
    res.status(500).json({ error: 'Proxy request failed', code: 'PROXY_ERROR' });
  }
});

/**
 * Swap proxies (0x same-chain EVM, LI.FI cross-chain, Jupiter same-chain Solana).
 * Every route sets Provian's 25 bps swap fee ON THE RELAY and refuses an upstream answer it
 * cannot verify as fee-bearing — see routes/swap-proxy.ts and core/swap/swap-fees.ts. The old
 * `ALL /api/proxy/zerox/*` transparent pass-through (no fee) is gone.
 */
app.use('/api/proxy', createSwapProxyRouter({
  authenticate,
  checkProxyRateLimit,
  fetch: (url, init) => fetchWithTimeout(url, init),
  forwardUpstreamResponse,
  isUpstreamTimeout: (err) => err instanceof UpstreamTimeoutError,
  env: process.env,
}));

// =============================================================================
// WALLET TYPES
// =============================================================================

interface WalletDocument {
  id: string;
  type: 'human' | 'agent';
  agent_id?: string;
  user_id?: string;
  address: string;
  public_key: string;
  created_at: number;
  pe_count: number;
  pvt_earned: number;       // Numeric for FieldValue.increment() compatibility
  trust_score: number;
  foundation_eligible: boolean;
  constitution_accepted_at?: number;
  constitution_version?: string;
  /**
   * Test-data marker (the invariant: , 2026-08-13). 'test' excludes
   * the wallet from public network statistics — same convention as
   * agent_wallets.platform, checked via isTestPlatformWallet(). Absent on real
   * wallets; propagated at registration for platform:'test' agent signups and
   * backfilled by scripts/mark-test-wallets.ts.
   */
  platform?: string;
}

/**
 * Foundation membership requires biometric attestation. Agent wallets
 * are never eligible regardless of other conditions.
 * Check: wallet.type === 'human' && wallet.foundation_eligible === true
 */
function requireFoundationEligibility(wallet: WalletDocument): boolean {
  return wallet.type === 'human' && wallet.foundation_eligible === true;
}

/**
 * Derive EVM address from a hex-encoded uncompressed secp256k1 public key.
 * Uses keccak256 hash - the last 20 bytes become the address.
 */
export function deriveAddressFromPublicKey(publicKeyHex: string): string {
  const pubKeyBuf = Buffer.from(publicKeyHex, 'hex');
  if (pubKeyBuf.length !== 64) {
    throw new Error('Public key must be 64 bytes (128 hex chars, no 04 prefix)');
  }
  // keccak256 of the uncompressed public key (without 04 prefix)
  const hash = keccak256(pubKeyBuf);
  return '0x' + hash.subarray(12).toString('hex');
}

// Keccak256 implementation. Clean-room from FIPS 202 spec.
// Constants RC, ROTC, PI are FIPS 202 mathematical values
// (public domain). No upstream library code derived.
// No attribution required.
/**
 * Minimal keccak256 for EVM address derivation on the backend.
 * Matches the SDK's keccak256 implementation.
 */
export function keccak256(input: Buffer): Buffer {
  const RC: bigint[] = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
    0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
    0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROTC = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
  ];
  const PI = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
  ];
  const MASK64 = (1n << 64n) - 1n;

  function rotl64(x: bigint, n: number): bigint {
    return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
  }

  function keccakF(state: bigint[]): void {
    for (let round = 0; round < 24; round++) {
      const C = new Array<bigint>(5);
      for (let x = 0; x < 5; x++) {
        C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) {
          state[x + y] = (state[x + y] ^ D) & MASK64;
        }
      }
      let last = state[1];
      for (let i = 0; i < 24; i++) {
        const j = PI[i];
        const temp = state[j];
        state[j] = rotl64(last, ROTC[i]);
        last = temp;
      }
      for (let y = 0; y < 25; y += 5) {
        const t0 = state[y], t1 = state[y + 1], t2 = state[y + 2], t3 = state[y + 3], t4 = state[y + 4];
        state[y] = (t0 ^ (~t1 & t2)) & MASK64;
        state[y + 1] = (t1 ^ (~t2 & t3)) & MASK64;
        state[y + 2] = (t2 ^ (~t3 & t4)) & MASK64;
        state[y + 3] = (t3 ^ (~t4 & t0)) & MASK64;
        state[y + 4] = (t4 ^ (~t0 & t1)) & MASK64;
      }
      state[0] = (state[0] ^ RC[round]) & MASK64;
    }
  }

  const rate = 136;
  const state = new Array<bigint>(25).fill(0n);
  const padded = Buffer.alloc(Math.ceil((input.length + 1) / rate) * rate);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate && i + 7 < rate; i += 8) {
      const laneIdx = i / 8;
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[offset + i + b]) << BigInt(b * 8);
      }
      state[laneIdx] ^= lane;
    }
    keccakF(state);
  }

  const output = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    const lane = state[i];
    for (let b = 0; b < 8; b++) {
      output[i * 8 + b] = Number((lane >> BigInt(b * 8)) & 0xFFn);
    }
  }
  return output;
}

// =============================================================================
// WALLET ENDPOINTS
// =============================================================================

// The 'wallets' collection is the unified trust graph.
// It tracks wallet identity and reputation for both humans and agents.
// It does NOT replace the 'users' collection, which handles auth and device state.
// Human wallets are created when a user completes biometric verification.
// Agent wallets are created only by the canonical PoP-bound
// POST /v1/agent/wallet/create service.

/**
 * POST /v1/wallet/agent/create
 * Hard-retired compatibility route. It previously wrote only `wallets` while
 * production watcher/auth enumeration expects canonical `agent_wallets`
 * identity and admission state.
 */
app.post('/v1/wallet/agent/create', retiredLegacyAgentWalletCreateHandler);

/**
 * POST /v1/wallet/human/register
 * Register a human wallet after biometric verification on the mobile app.
 * Creates a wallet document in the unified trust graph with Foundation eligibility.
 * Idempotent - returns existing wallet if one already exists for this user_id.
 *
 * Auth: Wallet auth (Bearer signed token)
 * Body: { publicKey: string, address: string }
 * Returns: { walletId, address, firstEnvelopeId, createdAt }
 */
app.post(
  '/v1/wallet/human/register',
  authenticate,
  createHumanWalletRegistrationHandler({
    db,
    peBuffer,
    recordPEAccrual,
    processGenesisQualification: (qualificationId: string) =>
      processGenesisQualification(agentBankDeps, qualificationId),
    readBaseRegistrationHead: () => readAgreedBaseHead(),
  }),
);

/**
 * GET /v1/trust/profile/:address
 * Unified trust profile for any wallet address - human or agent.
 * One trust graph. One reputation standard.
 *
 * Auth: Wallet auth (the agent-session half was retired)
 * Returns: TrustProfile
 */
// SECURITY: Auth handled by authenticateWalletRecorder middleware - do NOT reimplement inline.
// The prior inline implementation decoded the wallet-auth payload without HMAC
// verification and only checked that the stated user exists - any valid JSON
// blob with a real user_id was accepted. See audit Theme 2.
// the trust profile is readable by the phone (wallet auth) OR by an agent
// with its own API key — the retired relay session was the only other reader.
async function authenticateTrustReader(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('Bearer pvn_live_')) return authenticateAgent(req, res, next);
  return authenticateWalletRecorder(req, res, next);
}

app.get('/v1/trust/profile/:address', authenticateTrustReader, async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    if (!address || !address.startsWith('0x')) {
      return res.status(400).json({ error: 'Invalid address format' });
    }

    // Look up wallet by address. skip a registration the address's key holder
    // displaced — the live wallet for this address is the one that proved it.
    const liveWallet = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
      docs.find((d) => (d.data() as { displaced_at_ms?: unknown }).displaced_at_ms === undefined) ?? null;
    const walletQuery = await db.collection('wallets')
      .where('address', '==', address.toLowerCase())
      .limit(10)
      .get();

    // Also try original case (addresses may not be normalized)
    let walletDoc = liveWallet(walletQuery.docs);
    if (!walletDoc) {
      const walletQuery2 = await db.collection('wallets')
        .where('address', '==', address)
        .limit(10)
        .get();
      walletDoc = liveWallet(walletQuery2.docs);
    }

    if (!walletDoc) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const wallet = walletDoc.data() as WalletDocument;

    // PE METER: the action breakdown and count are the wallet's running totals
    // (`actor_stats_v1`, applied once per act), summed over the ids its PEs are
    // keyed by — the owner's user id and the wallet doc id (server-authored
    // witness PEs) — never a scan of stored PEs (the relay keeps none).
    // peCount is the LIVE count, never a stored per-wallet tally.
    const walletRecord = wallet as unknown as Record<string, unknown>;
    const actorIds = [wallet.id, walletRecord.user_id, walletRecord.agent_id]
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const peTotals = await readActorPeTotals(db, actorIds);
    const actionBreakdown: Record<string, number> = { ...peTotals.byType };

    // Return identical structure for human and agent wallets.
    return res.json({
      address: wallet.address,
      ownerType: wallet.type,
      peCount: peTotals.peCount,
      pvtEarned: wallet.pvt_earned,
      trustScore: wallet.trust_score,
      memberSince: new Date(wallet.created_at).toISOString(),
      actionBreakdown,
    });

  } catch (error) {
    console.error('Trust profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// PVT (PROVENANCE VALUE TOKEN) DASHBOARD ENDPOINTS
// =============================================================================
// categorizeActionType() is now imported from pvt-accrual.ts

async function readDashboardSettlementProjectionContext(): Promise<
CurrentSettlementProjectionContext | null
> {
  // the real PVT9-native settlement-rate reader. Returns the eligible-only
  // projection factor `getEpochPolicy(lastOpenedEpoch).mintRate / 1e18` — the exact
  // rate the kernel applies on-chain (`ProvianPVT9.sol:574`) and the settlement
  // runtime mirrors (`settlement-chain-adapter.ts:167`, `settlement-cycle-runner.ts:300`).
  // NOT the PVTv8 `readContractSettlementFactors` (which reads functions the PVT9
  // kernel does not expose). Fail-closed: `null` on any RPC/config error or a
  // non-positive rate → the dashboard falls back to the PE COUNT, NEVER a
  // record-points sum. The eligible-only gate stays in `projectCurrentSettlementPEAtomic`
  // (`mint_status === 'eligible'`); this only supplies the correct rate.
  return readPvt9SettlementFactors();
}

/**
 * GET /v1/pvt/accrual
 * Personal participation stats: sealed record points, a current non-final
 * settlement projection, and exact fixed Genesis reserved gross issuance.
 *
 * Auth: Wallet auth (the agent-session half was retired)
 */
app.get('/v1/pvt/accrual', authenticateWalletRecorder, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const cacheKey = `pvt:accrual:v4:${userId}`;

    // Check Redis cache first (30s TTL)
    const cachedAccrual = await cache.get<Record<string, unknown>>(cacheKey);
    if (cachedAccrual) {
      return res.json(cachedAccrual);
    }

    // Wallet, Abundance, Earn, and PVT Detail can request the same summary at
    // once. One verified user's cache miss needs only one aggregate read per
    // Cloud Run instance. Re-check Redis inside the flight for a fill by another
    // instance; request-bound wallet auth has already run for every joiner.
    const accrualResponse = await singleFlight(`pvt-accrual:${userId}`, async () => {
      const filled = await cache.get<Record<string, unknown>>(cacheKey);
      if (filled) return filled;
      const startedAt = Date.now();

      // Display the actual most-recent PE evidence tier. Human/Foundation status
      // is linkage/identity state and must never fabricate hardware attestation.
      const [accrualTierDoc, settlementProjection] = await Promise.all([
        db.collection('pvt_accrual').doc(userId).get(),
        readDashboardSettlementProjectionContext(),
      ]);
      const preludeMs = Date.now() - startedAt;
      const attestationDepth = normalizeAttestationTier(
        accrualTierDoc.exists ? accrualTierDoc.data()?.attestationDepth : null,
      );

      const aggregateTrace = emptyAggregateReadTrace();
      const data = await readEconomicAccrualProjection(db, userId, { settlementProjection }, aggregateTrace);
      const breakdown = Object.entries(data.pesByCategory)
        .filter(([, count]) => count > 0)
        .map(([category, peCount]) => ({
          category,
          peCount,
          recordPoints: formatPvtAtomic(
            data.recordPointsByCategoryAtomic[category] ?? '0',
            1,
          ),
          recordPointsAtomic: data.recordPointsByCategoryAtomic[category] ?? '0',
          currentSettlementProjectionPVT:
            data.currentSettlementProjectionByCategoryAtomic === null
              ? null
              : formatPvtAtomic(
                data.currentSettlementProjectionByCategoryAtomic[category] ?? '0',
                1,
              ),
          currentSettlementProjectionAtomic:
            data.currentSettlementProjectionByCategoryAtomic?.[category] ?? null,
          exactGenesisReservedGrossPVT: formatPvtAtomic(
            data.exactGenesisReservedGrossByCategoryAtomic[category] ?? '0',
            1,
          ),
          exactGenesisReservedGrossAtomic:
            data.exactGenesisReservedGrossByCategoryAtomic[category] ?? '0',
        }));

      const response = {
        recordPoints: {
          label: 'Sealed record points (not PVT)',
          unit: 'record_points_atomic',
          total: formatPvtAtomic(data.totalRecordPointsAtomic, 1),
          totalAtomic: data.totalRecordPointsAtomic,
        },
        currentSettlementProjection: data.currentSettlementProjection === null
          ? {
            available: false,
            label: 'Current settlement projection (non-final)',
            isFinal: false,
            unavailableReason: data.currentSettlementProjectionUnavailableReason,
          }
          : {
            available: true,
            label: 'Current settlement projection (non-final)',
            isFinal: false,
            totalPVT: formatPvtAtomic(data.totalCurrentSettlementProjectionAtomic!, 1),
            totalPvtAtomic: data.totalCurrentSettlementProjectionAtomic,
            projectedAtMs: data.currentSettlementProjection.projectedAtMs,
            factorVintage: data.currentSettlementProjection.factorVintage,
          },
        exactGenesisReservedGross: {
          label: 'Exact fixed Genesis reserved gross issuance',
          totalPVT: formatPvtAtomic(data.exactGenesisReservedGrossAtomic, 1),
          totalAtomic: data.exactGenesisReservedGrossAtomic,
        },
        totalPEs: data.totalPEs,
        weeklyPEs: data.weeklyPEs,
        attestationDepth,
        breakdown,
        integrityFailures: data.integrityFailures,
        projectionFailures: data.projectionFailures,
      };

      // Cache for 30 seconds
      // Fill the shared cache before releasing the in-process flight, so the
      // next request cannot race a still-pending Redis write into another fold.
      await cache.set(cacheKey, response, 30);
      const totalMs = Date.now() - startedAt;
      if (totalMs >= 1000) {
        console.info(JSON.stringify({
          event: 'pvt_accrual_miss_timing',
          total_ms: totalMs,
          prelude_ms: preludeMs,
          aggregate_ms: totalMs - preludeMs,
          aggregate_stages_ms: aggregateTrace.timingsMs ?? null,
          tail_act_keys: aggregateTrace.tailActKeys,
        }));
      }
      return response;
    });

    return res.json(accrualResponse);

  } catch (error) {
    handleEndpointError(res, error, 'PVT accrual');
  }
});

/**
 * GET /v1/pvt/history
 * The caller's RECENT priced acts (sealed record points, optional current non-final projection,
 * exact fixed Genesis reserved gross), newest first, paginated.
 *
 * PE METER : the relay keeps no PE history. This lists the caller's
 * live act keys — the last ≤31 days, the priced row of each act (type, time, disposition,
 * points), never content — behind a small limit on the indexed `(actor_id, timestamp)` query.
 * The full history is on the owner's devices. `total` is the caller's lifetime PE count (its
 * running total); `windowDays` names how far back the list reaches.
 *
 * Query params: limit (default 50, max 100), offset (default 0), cursor
 * Auth: Wallet auth (the agent-session half was retired)
 *
 * M4 — `cursor` is the keyset alternative to `offset`, and supersedes it when both are
 * supplied; `nextCursor` rides in the body.
 */
app.get('/v1/pvt/history', authenticateWalletRecorder, (_req: Request, res: Response) => {
  sendPeKeptByOwner(res);
});

/**
 * GET /v1/pvt/network-stats
 * Network-wide participation stats + PE-count leaderboard.
 * PUBLIC endpoint - no auth required. Cached for 30 seconds via Redis.
 * If auth header present, includes userRank and userAddress.
 *
 * the app's MyProvenance dashboard reads this, so it must serve a
 * wallet-authed caller before the flip (the app is gated by not being
 * published, not by PUBLIC_LAUNCH). isAppClientDiscoveryAdmissible admits on
 * launch OR a Bearer credential; an anonymous public-web caller (no credential)
 * still gets 404, so the non-disclosure posture is unchanged. Read per-request
 * (not the boot-captured PUBLIC_LAUNCH constant) so the decision reflects now.
 */
app.get('/v1/pvt/network-stats', async (req: Request, res: Response) => {
  if (!isAppClientDiscoveryAdmissible(req)) {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const window = parseWindow(req.query.window);
    if (window === null) {
      return res.status(400).json({ error: 'invalid_window' });
    }

    // Check Redis cache first (30s TTL, per window). The cached blob carries a
    // private _rank context for rank resolution — strip it before serving on
    // EVERY path (the old spread forwarded whatever the blob contained).
    const cached = await cache.getNetworkStats<Record<string, unknown>>(window);
    if (cached) {
      const userRankData = await resolveUserRank(req, cached._rank, cached.leaderboard);
      const { _rank: _omitted, ...publicStats } = cached;
      return res.json({ ...publicStats, ...userRankData });
    }

    // H2 — SINGLE-FLIGHT the miss path. Without coalescing every request
    // arriving inside the 30s window was its own miss and its own recompute:
    // the cost of a miss multiplied by the request rate, exactly when the
    // endpoint is busiest. IN-PROCESS only, so it coalesces per Cloud Run
    // instance, not fleet-wide — stated in the helper. `resolveUserRank` stays
    // OUTSIDE: it depends on this request's auth header, so it must never be
    // shared between callers.
    const computed = await singleFlight(`network-stats:${window}`, async () => {
    // Re-check inside the flight: another INSTANCE may have filled the cache
    // between our outer read and winning this key. One Redis GET to avoid a
    // recompute is a trade worth making every time.
    const filled = await cache.getNetworkStats<Record<string, unknown>>(window);
    if (filled) return filled;

    // Sum sharded network counters
    const counters = await readNetworkCounters();

    // H2 CLOSE-OUT — the FULL `wallets` scan (and the full `pvt_accrual`
    // scan for the weekly window) are GONE. `readNetworkStats` issues only
    // bounded reads: count() aggregations for the totals, ONE ordered query
    // over-fetched by the (small, bounded) test-wallet set for the board, and
    // the test set itself. A caller's rank is resolved later by a bounded
    // count() of the rows above it (`resolveWalletRank`), never from a map of
    // every wallet. The earlier H2 slice already removed the `agent_wallets`
    // name-map scan; names are joined AFTER ranking for exactly the agent rows
    // on the board — a bounded `getAll` of ≤50 docs.
    //
    // The legacy wallet.pvt_earned/network totalEstimatedPVT counters were
    // sealed-time display estimates, not settled PVT. Do not expose them as
    // monetary truth. The board ranks by the independently meaningful PE
    // count (the sort key is chosen in ONE place, network-stats-projection.ts).
    const projection = await readNetworkStats(db, {
      window,
      now: Date.now(),
      counters,
    });

    // Get 24h PE count from Redis sliding window. PE METER: when Redis is
    // unavailable, the Firestore twin of those hourly buckets — the batch commit
    // counts the SAME network-countable acts (test-platform actors excluded) per
    // commit hour — is summed: a fixed 24 × shard point reads, never a scan.
    let pesLast24h = await cache.get24hPECount();
    if (pesLast24h < 0) {
      pesLast24h = await readNetworkMeter24h(db, Date.now());
    }
    projection.statsData.pesLast24h = pesLast24h;

    // H2 — bounded display-name join: fetch names ONLY for the agent
    // wallets that made the board (≤50 doc reads), replacing the full
    // `agent_wallets` scan. `leaderboardWalletIds` is positionally aligned with
    // `leaderboard`, so a name always lands on the row it belongs to.
    // Best-effort by design: a name is cosmetic, and a failed join must not take
    // down a public stats endpoint that is otherwise correct.
    const boardAgentIds = projection.statsData.leaderboard
      .map((entry, index) => ({ entry, id: projection.leaderboardWalletIds[index] }))
      .filter((row) => row.entry.ownerType === 'agent' && typeof row.id === 'string');
    if (boardAgentIds.length > 0) {
      try {
        const nameDocs = await db.getAll(
          ...boardAgentIds.map((row) => db.collection('agent_wallets').doc(row.id)),
        );
        const nameById = new Map<string, string>();
        for (const doc of nameDocs) {
          const name = doc.data()?.display_name;
          if (typeof name === 'string' && name.length > 0) nameById.set(doc.id, name);
        }
        for (const row of boardAgentIds) {
          const name = nameById.get(row.id);
          if (name !== undefined) row.entry.displayName = name;
        }
      } catch (nameError) {
        console.warn('[network-stats] leaderboard display-name join failed:', nameError);
      }
    }

    // Humans get the name they PUBLISHED on their Commons profile (an active
    // `commons_profiles/{user_id}` doc — public by design), else they stay an
    // address. Same bounded, best-effort shape as the agent join above.
    const boardHumans = projection.statsData.leaderboard
      .map((entry, index) => ({ entry, ownerId: projection.leaderboardOwnerIds[index] }))
      .filter((row) => row.entry.ownerType === 'human' && typeof row.ownerId === 'string');
    if (boardHumans.length > 0) {
      try {
        const profileDocs = await db.getAll(
          ...boardHumans.map((row) => db.collection('commons_profiles').doc(row.ownerId)),
        );
        const nameById = new Map<string, string>();
        for (const doc of profileDocs) {
          const data = doc.data();
          const name = data?.display_name;
          if (data?.status === 'active' && typeof name === 'string' && name.length > 0) nameById.set(doc.id, name);
        }
        for (const row of boardHumans) {
          const name = nameById.get(row.ownerId);
          if (name !== undefined) row.entry.displayName = name;
        }
      } catch (nameError) {
        console.warn('[network-stats] leaderboard human display-name join failed:', nameError);
      }
    }

    // Cache in Redis for 30 seconds, carrying the private rank context (the
    // window, the week, and the test wallets' counts — never a per-wallet map).
    const blob = { ...projection.statsData, _rank: projection.rankContext };
    await cache.setNetworkStats(blob, window);
    return blob as Record<string, unknown>;
    });

    // Per-request, so outside the shared flight.
    const userRankData = await resolveUserRank(req, computed._rank, computed.leaderboard);
    const { _rank: _omitted2, ...publicStats } = computed;

    return res.json({ ...publicStats, ...userRankData });

  } catch (error) {
    console.error('PVT network stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Resolve the caller's rank. Optional auth - returns empty object if not
 * authenticated.
 *
 * H2 close-out: the rank is a bounded `count()` of the wallets ranked
 * above the caller's own count (`resolveWalletRank`), minus the test wallets
 * above it — which the cached rank CONTEXT names — never a lookup in a map of
 * every wallet. The context is window- and filter-consistent with the board it
 * sits under (it came from the same `readNetworkStats` call, fresh or cached).
 * A test wallet's own caller gets userRank null — it has no rank on a
 * real-only board. Ties share a rank (competition ranking).
 */
async function resolveUserRank(
  req: Request,
  rankContextRaw: unknown,
  leaderboardRaw: unknown,
): Promise<Record<string, unknown>> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return {};

    const token = authHeader.substring(7);
    let userId: string | null = null;

    // Wallet auth: route through the canonical v2 verifier so this helper
    // applies the same request-binding checks (mth/pth/bh + jti replay) as
    // authenticate(). Optional-auth semantics are preserved by silently
    // returning {} on any verification failure.
    if (!userId) {
      const dotIndex = token.lastIndexOf('.');
      if (dotIndex !== -1) {
        const result = await verifyWalletAuthToken(token, req);
        if (result.ok) {
          userId = result.userId;
        }
      }
    }

    if (!userId) return {};

    const walletQuery = await db.collection('wallets')
      .where('user_id', '==', userId)
      .limit(1)
      .get();

    if (walletQuery.empty) return {};

    const walletData = walletQuery.docs[0].data() as WalletDocument;
    const userAddress = walletData.address;
    // On the board: the board's own rank (the all-time board ranks by live
    // own-record counts, which the stored-counter count() below cannot see).
    const boardRank = boardRankForAddress(leaderboardRaw, userAddress);
    if (boardRank !== null) {
      return { userRank: boardRank, userAddress };
    }
    const rankContext = parseRankContext(rankContextRaw);
    const rank = rankContext === null
      ? null
      : await resolveWalletRank(db, rankContext, { data: walletData as unknown as Record<string, unknown> });

    return { userRank: rank, userAddress };
  } catch {
    return {};
  }
}

// =============================================================================
// PARTICIPATION SUMMARY (Abundance Dashboard)
// =============================================================================

app.get('/v1/participation/summary', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Cache for 5 minutes per user
    const cacheKey = `participation:${userId}`;
    const cached = await cache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // PE METER: every figure is a running total — `actor_stats_v1` (lifetime count, the
    // per-day buckets, `promise_fulfilled`, first PE) and the 30 day counters the batch commit
    // keeps (agent actions, corroborated acts). A fixed 31 point reads, whatever the history;
    // never a count() over stored PEs (the relay keeps none). Fact-base fixes item 5: the
    // retired `goal_envelopes_completed` / `blocks_count` stay gone.
    const summary = await readParticipationSummary(db, userId, Date.now());

    await cache.set(cacheKey, summary, 300); // 5-minute cache
    res.json(summary);
  } catch (error) {
    console.error('[Participation] Summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// AGENT SELF-SIGNUP ROUTERS
// =============================================================================

const routerDeps = {
  db,
  cache,
  peBuffer,
  recordPEAccrual,
  keccak256,
  deriveAddressFromPublicKey,
  readBaseRegistrationHead: () => readAgreedBaseHead(),
  // `genesis_signup` qualifies on agent wallet CREATION (Phase 1), so the create route
  // owns the drain. Best-effort: the outbox row is the durable source of truth.
  processGenesisQualification: (qualificationId: string) =>
    processGenesisQualification(agentBankDeps, qualificationId),
};

app.use('/v1/agent/wallet', createAgentWalletRouter(routerDeps));
app.use('/v1', createAgentLeaderboardRouter(routerDeps));
app.use('/v1/agent/wallet', createAgentInviteRouter(routerDeps));
// Hosted `curl … | sh` agent bootstrap. PUBLIC + un-gated pre-flip (two-touch
// onboarding runs before the flip); never add /v1/bootstrap to the closed list.
app.use('/v1/bootstrap', createBootstrapRouter({ db, cache }));

// =============================================================================
// DEVICE REGISTRATION & PE SUBMISSION
// =============================================================================

const deviceDeps = {
  db, cache, peBuffer, recordPEAccrual,
  processGenesisQualification: (qualificationId: string) =>
    processGenesisQualification(agentBankDeps, qualificationId),
};

// Dual-auth for devices: agent wallets (pvn_live_ prefix) or human wallets
const authenticateAgent = createAgentAuthMiddleware(db);
const authenticateDeviceOwner: express.RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.includes('pvn_live_')) {
    // Agent wallet auth - sets req.agentWallet
    return authenticateAgent(req, res, next);
  }
  // Human wallet auth - sets req.user
  return authenticate(req, res, next);
};

// Device-authenticated self-lookup (DeviceKey auth). Must be mounted BEFORE
// the wallet-auth-gated /v1/devices router so express routes GET /me here
// instead of rejecting on missing wallet auth. See register-device overwrite
// guard for the consumer.
app.use('/v1/devices', createDeviceSelfRouter({ db, cache }));
// a bearer device registers the P-256 key it signs its outputs with (device auth).
app.use('/v1/devices', createDeviceOutputKeyRouter({ db }));
// POST /v1/devices/register is mounted FIRST under a DEDICATED auth middleware
// (createDeviceRegisterAuth) so the one-time `agent_device_registration` token is
// honoured on this single route ONLY. authenticateDeviceOwner (and thus the
// agent-device token) MUST stay OFF every other /v1/devices/* verb and
// /v1/agent-attribution. See routes/middleware/device-register-auth.ts (M1).
app.post(
  '/v1/devices/register',
  createDeviceRegisterAuth(db, authenticateDeviceOwner),
  createRegisterDeviceHandler(deviceDeps),
);

import { createReleaseManifestRouter } from './routes/release-manifest';
import { createMeterRouter } from './routes/meter';
import { ingestMeterBatch, type MeterLane } from './core/meter/meter-ingest';
import { admitMobileMeterBatch, isMobileMeterDeviceId } from './core/meter/mobile-meter-admission';
import { mobileActToAccrualParams, type MobileBatchLane } from './core/meter/mobile-act';
import { ackMailbox, listMailbox } from './core/meter/pe-mailbox';
import { listMeterProofs, selectedProofHashes } from './core/meter/meter-proofs';
import { readBatchProofsRequest } from './core/meter/batch-proofs';
import { METER_DEVICE_TIPS_COLLECTION, type MeterDeviceTip } from './core/meter/meter-store';
import { METER_GENESIS_PREV_HASH } from './core/meter/meter-wire';
import { resolveServedBundleSha256 } from './routes/served-bundle';
// The signed daemon-release manifest (self-update channel). PUBLIC and
// unauthenticated: it names the current bundle's version + hash (not a secret),
// signed out-of-band by the existing Ed25519 authority. The daemon downloads
// the actual bundle from /v1/bootstrap/
// agent.js and refuses to run bytes whose hash does not match this manifest.
// (1B): the manifest is served ONLY when its bundle sha256 equals the bundle
// THIS revision serves at /v1/bootstrap/agent.js (resolveServedBundleSha256 reads
// the SAME BOOTSTRAP_BUNDLE_PATH the bootstrap route serves), so a daemon can never
// fetch a manifest whose bundle is not already in place — publish is atomic from
// the daemon's view.
app.use('/v1/catalog/release', createReleaseManifestRouter({
  db,
  resolveServedBundleSha256: () => resolveServedBundleSha256(),
}));
app.use('/v1/devices', authenticateDeviceOwner, createDeviceRouter(deviceDeps));
app.use('/v1/github-identity', authenticateDeviceOwner, createGitHubIdentityRouter(db, cache));
app.use('/v1/agent-attribution', authenticateDeviceOwner, createAgentAttributionRouter({ db, cache }));
// PE METER : one signed daily batch per device (plus one before any presentation
// or payout, ); the relay prices, mints and
// keeps totals — never a PE. See core/meter/ and docs/wp-runs/PE_METER_DESIGN_2026-10-03.md.
app.use('/v1/meter', createMeterRouter({ db, cache }));

// Provisional wallets - zero-setup PE submission for agents
// Claim needs wallet auth; status is public. Apply authenticate to /claim only.
app.post('/v1/provisional/claim', authenticate);
app.use('/v1/provisional', createProvisionalRouter({
  db, cache, peBuffer, recordPEAccrual, deriveAddressFromPublicKey,
}));
app.use('/v1/enterprise', createEnterpriseRouter({
  db,
  cache,
}));
app.use('/v1/notify', createNotifyRouter({
  db,
  cache,
}));
// Public, un-gated (like /v1/notify): a marketing-email unsubscribe must work
// before launch and without login. Real suppression — see routes/unsubscribe.ts.
app.use('/v1/unsubscribe', createUnsubscribeRouter({
  db,
  cache,
}));

// Community-updates opt-in. Identity-free by construction (no auth middleware,
// no identity fields stored); the pre-launch surface gate covers /v1/community
// (anonymous 404 pre-flip, Bearer-presenting app/CLI passes, public post-flip).
// See routes/community.ts.
app.use('/v1/community', createCommunityRouter({
  db,
  cache,
}));

// =============================================================================
// MOBILE PE SUBMISSION (wallet auth - phone submits signed PEs; the relay
// assigns the evidence-derived tier, with software fallback)
// =============================================================================

type MobileTierOutcome =
  | {
    ok: true;
    tier: DeviceEconomicAttestationTier;
    deviceIdRecorded: string | null;
  }
  | {
    ok: false;
    error: 'invalid_device_ownership';
  };

/**
 * Resolve the PE attestation tier for /v1/pe/submit/mobile from server-trusted
 * sources (BLOCKER-1 fix, 2026-05-06).
 *
 * Walks: device record → ownership match → bound P-256 signature →
 * resolveAttestationTierFromSigning() (which also reads
 * wallets/{user_id}.attested_security_level for BLOCKER-2 fail-closed).
 *
 * Defaults to software when optional attestation evidence is absent or cannot
 * be verified. Invalid or contradictory ownership is an authentication
 * failure, not a downgrade. deviceIdRecorded is null when the caller's value
 * did not survive optional evidence verification.
 */
async function resolveMobilePEAttestationTier(input: {
  deviceId: string;
  userId: string;
  req: Request;
}): Promise<MobileTierOutcome> {
  const rawDevice = getAuthenticatedHumanMobileDevice(
    input.req,
    input.deviceId,
    input.userId,
  );
  if (!rawDevice) {
    console.warn(`[PESubmitMobile] device ${input.deviceId} lacks authenticated human ownership`);
    return { ok: false, error: 'invalid_device_ownership' };
  }
  const device = rawDevice as {
    owner_user_id?: string;
    owner_type: 'human' | 'agent';
    attestation_capability?: string;
    signing_method?: string;
    signing_public_key?: string;
    platform?: string;
    status?: string;
    attested_security_level?: 'hardware_full' | 'hardware_tpm';
  };
  // This is a human-wallet endpoint. A missing/malformed owner_type is not a
  // software downgrade, and a valid agent value is contradictory ownership.
  // Reject both before signature verification or attestation selection.
  if (
    device.owner_type !== 'human'
    || device.owner_user_id !== input.userId
  ) {
    console.warn(`[PESubmitMobile] device ${input.deviceId} has invalid or contradictory owner_type`);
    return { ok: false, error: 'invalid_device_ownership' };
  }
  if (
    device.status === 'revoked'
    || device.signing_method !== 'secure_enclave_p256'
    || typeof device.signing_public_key !== 'string'
  ) {
    console.warn(`[PESubmitMobile] device ${input.deviceId} mismatch or not provisioned for SE signing; defaulting to software`);
    return { ok: true, tier: 'software', deviceIdRecorded: null };
  }
  // [Body-hash fix 2026-06-10] rawBody (pre-parse capture) is the signed-byte
  // source of truth; '' when no body was sent. The old parsed-body fallback
  // hashed '{}' for a bodyless request (body-parser sets req.body = {}), which
  // never matches the client's literal-bytes signature. See wallet-auth.ts.
  const rawBody = typeof input.req.rawBody === 'string' ? input.req.rawBody : '';
  const fullPath = (input.req.originalUrl || input.req.url || input.req.path || '').split('?')[0];
  const sigCheck = await verifyBoundDeviceSignature({
    signatureHeader: input.req.headers['x-provian-signature'],
    rawBody,
    method: input.req.method,
    path: fullPath,
    signingPublicKeyHex: device.signing_public_key,
    deps: { db, cache },
  });
  if (!sigCheck.ok) {
    console.warn(`[PESubmitMobile] device_attestation_id present without valid bound signature (${sigCheck.code}); defaulting to software`);
    return { ok: true, tier: 'software', deviceIdRecorded: null };
  }
  let walletSecLevel: string | null = null;
  try {
    const walletQuery = await db.collection('wallets')
      .where('user_id', '==', input.userId)
      .limit(1)
      .get();
    if (!walletQuery.empty) {
      const walletData = walletQuery.docs[0].data() as { attested_security_level?: string; security_level?: string };
      walletSecLevel = walletData.attested_security_level || walletData.security_level || null;
    }
  } catch (err) {
    console.warn('[PESubmitMobile] wallet security level lookup failed', err);
  }
  const tierResult = resolveAttestationTierFromSigning({
    signingMethod: device.signing_method,
    ownerType: device.owner_type,
    platform: device.platform || '',
    claimedCapability: device.attestation_capability || 'software',
    walletSecurityLevel: walletSecLevel,
    attestedSecurityLevel: device.attested_security_level ?? null,
  });
  const tier = canonicalDeviceEconomicAttestationTier(tierResult.verifiedCapability);
  return { ok: true, tier, deviceIdRecorded: input.deviceId };
}

// PE METER — the phone's daily batch, under wallet auth (the v2 token binds
// the body hash, so the batch is body-bound). The batch's device is the token's device; its acts
// price exactly as `/v1/pe/submit/mobile` priced them (core/meter/mobile-act.ts).
app.post('/v1/meter/batch/mobile', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const tokenDeviceId = req.user?.device_id;
    if (!userId || !tokenDeviceId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    // Fix run 2026-10-24: the phone names its device in its OWN wallet token, so the device id is
    // a label the caller chose. The limiter keys on the authenticated wallet, and a chain belongs
    // to the wallet that opened it (`ownerBoundChain` below; tip and proofs reads likewise).
    const admission = await admitMobileMeterBatch(cache, userId, tokenDeviceId);
    if (!admission.ok) {
      res.status(admission.status).json(admission.body);
      return;
    }
    const secret=await cache.getUserAuthSecret(userId)??(await db.collection('auth_secrets').doc(userId).get()).data()?.secret;
    const transport=unwrapPrivateBatch(req.body,typeof secret==='string'?secret:undefined);
    const batchDeviceId = (transport.batch as { device_id?: unknown } | undefined)?.device_id;
    if (batchDeviceId !== tokenDeviceId) {
      res.status(403).json({ error: 'batch_device_mismatch', message: 'A phone batch names the device its wallet auth token was issued to.' });
      return;
    }
    let tier: DeviceEconomicAttestationTier = 'software';
    let deviceAttestationId: string | null = null;
    const ownership = await authenticateRequestHumanMobileDevice(db, req, tokenDeviceId);
    if (!ownership.ok && ownership.error === 'invalid_device_ownership') {
      res.status(401).json({ error: 'invalid_device_ownership' });
      return;
    }
    if (ownership.ok) {
      const tierOutcome = await resolveMobilePEAttestationTier({ deviceId: tokenDeviceId, userId, req });
      if (!tierOutcome.ok) {
        res.status(401).json({ error: tierOutcome.error });
        return;
      }
      tier = tierOutcome.tier;
      deviceAttestationId = tierOutcome.deviceIdRecorded;
    }
    let actorAddress: string = userId;
    let humanWalletDocId: string | null = null;
    const walletQuery = await db.collection('wallets').where('user_id', '==', userId).limit(1).get();
    if (!walletQuery.empty) {
      humanWalletDocId = walletQuery.docs[0].id;
      const wallet = walletQuery.docs[0].data() as WalletDocument;
      if (wallet.address) actorAddress = wallet.address.toLowerCase();
    }
    const receivedAtMs = Date.now();
    const mobileLane: MobileBatchLane = {
      db,
      userId,
      deviceId: tokenDeviceId,
      attestationTier: tier,
      deviceAttestationId,
      actorAddress,
      humanWalletDocId,
      receivedAtMs,
      privacyOpenings:transport.openings,
      appleAssertion: appleAssertionDepsFor(firestoreAppAttestKeyStore(db), userId, receivedAtMs),
      hooks: [],
      afterCommit: [],
    };
    const lane: MeterLane = {
      deviceId: tokenDeviceId,
      actorId: userId,
      // The phone files its own PEs; it seals nothing for anyone else.
      resolveSealedRecipient: () => null,
      mapAct: (act, relayPeId) => mobileActToAccrualParams(mobileLane, act, relayPeId),
      // : the phone's batches are hash-chained and sequenced like a device's.
      singleLaneCut: true,
      ownerBoundChain: true,
      extraWrites: () => [],
      txnHooks: () => mobileLane.hooks,
    };
    const result = await ingestMeterBatch(db, lane, transport.batch, receivedAtMs);
    if (result.status === 201) {
      for (const effect of mobileLane.afterCommit) {
        effect().catch((err) => console.warn('[meter-mobile] post-commit effect failed:', err));
      }
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[meter-mobile] batch ingest failed:', error);
    res.status(500).json({ error: 'batch_ingest_failed' });
  }
});

// PE METER — the phone's tip (resync) and its mailbox: PEs its linked agents and its other devices
// sealed to it, held until the phone acknowledges durable receipt, then deleted in the person's own cloud.
app.get('/v1/meter/mobile/tip', authenticate, async (req: Request, res: Response) => {
  const deviceId = req.user?.device_id;
  const userId = req.user?.id;
  if (!deviceId || !userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isMobileMeterDeviceId(deviceId)) {
    res.status(400).json({ error: 'batch_device_id_invalid' });
    return;
  }
  const snap = await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(deviceId).get();
  const tip = snap.exists ? (snap.data() as MeterDeviceTip) : null;
  if (tip !== null && tip.actor_id !== userId) {
    res.status(403).json({ error: 'batch_device_not_owned' });
    return;
  }
  res.json({
    device_id: deviceId,
    seq: tip?.seq ?? 0,
    batch_hash: tip?.batch_hash ?? METER_GENESIS_PREV_HASH,
    last_pe_hash: tip?.last_pe_hash ?? METER_GENESIS_PREV_HASH,
    accepted_at_ms: tip?.accepted_at_ms ?? null,
  });
});
app.get('/v1/meter/mobile/proofs', authenticate, async (req: Request, res: Response) => {
  const deviceId = req.user?.device_id;
  const userId = req.user?.id;
  if (!deviceId || !userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isMobileMeterDeviceId(deviceId)) {
    res.status(400).json({ error: 'batch_device_id_invalid' });
    return;
  }
  const tipSnap = await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(deviceId).get();
  if (tipSnap.exists && (tipSnap.data() as MeterDeviceTip).actor_id !== userId) {
    res.status(403).json({ error: 'batch_device_not_owned' });
    return;
  }
  const afterSeq = Number(req.query.after_seq ?? 0);
  let hashes: readonly string[] | undefined;
  try { hashes = selectedProofHashes(req.query.batch_hashes); } catch { res.status(400).json({ error: 'batch_hashes_invalid' }); return; }
  res.json(await listMeterProofs(db, deviceId, Number.isSafeInteger(afterSeq) ? afterSeq : 0, 200, hashes));
});
// PE export: the anchoring record of batches whose PEs were sealed to this person (their linked
// agents' and other devices' mailbox copies, relay-authored PEs), so the phone can build their
// inclusion proofs. Authorization model (core/meter/batch-proofs.ts): any authenticated wallet
// presenting a batch hash gets that batch's record — a batch hash is a sha256 over the whole batch,
// disclosed only to its device, to recipients of its sealed copies and inside presentations — and
// the record carries hashes and ids only (never a PE, pricing input, claim key or points). Read-only.
app.post('/v1/meter/mobile/batch-proofs', authenticate, async (req: Request, res: Response) => {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const result = await readBatchProofsRequest(db, req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.value);
  } catch (error) {
    console.error('[meter] mobile batch-proofs read failed:', error);
    res.status(500).json({ error: 'batch_proofs_failed' });
  }
});
app.get('/v1/meter/mobile/mailbox', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const limit = Number(req.query.limit ?? 100);
  const after = typeof req.query.after === 'string' ? req.query.after : null;
  res.json(await listMailbox(db, `human:${userId}`, { limit: Number.isFinite(limit) ? limit : 100, afterId: after }));
});
app.post('/v1/meter/mobile/mailbox/ack', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  res.json({ dropped: await ackMailbox(db, `human:${userId}`, ids) });
});

// =============================================================================
// AGENT BANK ROUTERS
// =============================================================================

const agentBankDeps = {
  db,
  cache,
  peBuffer,
  recordPEAccrual,
  // B8 : the three keeper gateways were never injected here, so the
  // mounted ESCROW_RELEASE_KEY / POOL_KEEPER_KEY / BOND_KEEPER_KEY loaded into
  // nothing and every scheduler tick took the keeper-unavailable branch — the
  // silent-no-op with the env present. Constructed at boot: an unset key
  // degrades to canSign()=false (warn only); a Gate-B identity collision
  // throws by design ("Refusing to start").
  escrowChain: createEscrowChainGateway(),
  poolKeeper: createPoolKeeperGateway(),
  bondKeeper: createBondKeeperGateway(),
};

// --- PVT public read surface (PVT9-era) ---
// ONE mount for the whole surface: estimate, milestones, weights,
// weights/overrides, attestation-tiers, balance/:address, allocation/:wallet_id.
// Every route inside carries its own `publicDiscoveryGate()` and 404s until
// PUBLIC_LAUNCH === 'true', and every one of them still has to pass
// `createPvt9RuntimeBoundary()` mounted far above. stats, tokenomics and
// mint-history are deliberately NOT here — see routes/pvt-public-reads.ts.
mountPvtPublicReads(app, agentBankDeps);

/**
 * POST /v1/wallet/external-address/challenge | /verify, GET /v1/wallet/external-addresses —
 * a PERSON proves a wallet they already hold (2026-10-01). Wallet auth
 * only; the proof pays nothing; only the address's activity from the proof forward counts, as
 * the person's own. Mounted above the `/v1/wallet` catch-all.
 */
app.use('/v1/wallet', createPersonExternalAddressRouter({ agentBankDeps, authenticate }));
/**
 * POST /v1/wallet/solana-address/challenge | /verify, GET /v1/wallet/solana-addresses — a PERSON
 * proves a Solana address (ed25519; follow-up). Same rules as the EVM proof above:
 * wallet auth only, the proof pays nothing, only activity after the proof's slot counts. Mounted
 * above the `/v1/wallet` catch-all.
 */
app.use('/v1/wallet', createPersonSolanaAddressRouter({ agentBankDeps, authenticate }));
/**
 * GET /v1/wallet/launch-state — the launch switch the app's Connect options and Devices note read
 * `PUBLIC_LAUNCH`, the same value that opens `/mcp`. Wallet auth; mounted
 * above the `/v1/wallet` catch-all.
 */
app.use('/v1/wallet/launch-state', createLaunchStateRouter({ authenticate }));

app.use('/v1/escrow', createAgentEscrowRouter(agentBankDeps));
app.use('/v1/promises', createAgentPromisesRouter(agentBankDeps));
// human P2P promises moved off the Firestore `promise_sync` side-channel
// to the relay under human wallet auth. Mounted BEHIND `authenticate` (Pattern A)
// so each handler reads `req.user!.id` and resolves the caller's own human wallet.
app.use('/v1/human-promises', authenticate, createHumanPromisesRouter({ db, cache }));
app.use('/v1/pools', createAgentPoolsRouter(agentBankDeps));
app.use('/v1/court', createAgentCourtRouter(agentBankDeps));
app.use('/v1/bonds', createAgentBondsRouter(agentBankDeps));

// --- Sovereign x402 reputation PE (audit Pass-2 #20 remainder) ---
// Session-less, agent-EOA-signed `x402_payment` PE submission: the unconnected
// standalone x402 agent records its reputation PE with its OWN sovereign key
// (no relay session). Type-scoped to x402_payment, signature+wallet-bound,
// replay-proof (single-use nonce), rate-limited. The `-sovereign` path segment
// does not collide with the `/v1/pe/submit` prefix mounted above. Mounted here
// (not under session auth) because x402 is governance-free by design.
import { createSovereignPERouter } from './routes/sovereign-pe';
app.use('/v1/pe/submit-sovereign', createSovereignPERouter(agentBankDeps));

// --- External-address proof-of-control (Unit 2: prove an external EVM address;
// its go-forward verified financial activity uses the standard mint path, while
// the proof act can qualify once for the time-limited Genesis signup grant) ---
import { createExternalAddressRouter } from './routes/external-address';
app.use('/v1/agent/external-address', createExternalAddressRouter(agentBankDeps));
// follow-up: an agent proves a SOLANA address (ed25519) — POST
// /v1/agent/solana-address/challenge | /verify, GET /v1/agent/solana-addresses. Agent API auth; the
// binding (`solana_proven_addresses`) is what lets the x402 facilitator lane seal a Solana
// settlement's acts on the owner's chain.
app.use('/v1/agent', createAgentSolanaAddressRouter(agentBankDeps));
// the LINKED HUMAN links a third-party wallet to their agent from the
// Agent Hub (wallet auth + linked_human_user_id === caller). Same challenge (bound to the
// agent's agent_id) and the same proveExternalAddress — fence, one-address-one-agent,
// EIP-191/EIP-1271 unchanged. The address holder's signature is what binds it.
import { createHumanExternalAddressRouter } from './routes/human-external-address';
app.use('/v1/agent/wallet', createHumanExternalAddressRouter(agentBankDeps));
// item 4 : the linked human sets how their agent answers Commons mail.
import { createAgentReplyPolicyRouter } from './routes/agent-reply-policy';
app.use('/v1/agent/wallet', createAgentReplyPolicyRouter(agentBankDeps));

// --- Witness 3: relay-witnessed external service events ---
// Inbound webhook receivers (GitHub App, GitLab project webhooks, Bitbucket repo
// webhooks). Routes are always mounted; when a connector's secret env var is
// unset the handler returns 503 - see core/witnesses/{github,gitlab,bitbucket}-webhook.ts
// for the full verify-before-parse + dedup + synthesize-or-drop + cross-witness
// corroboration flow. A commit witnessed both locally (observer coding_session)
// and via a forge webhook mints once: the first witness wins, later witnesses
// record as 'corroborated_duplicate' (see core/pvt/commit-mint-claim.ts) while
// still emitting their corroboration signal. All routers mount under
// /v1/witnesses; GitHub owns /github/*, GitLab owns /gitlab/*, Bitbucket owns
// /bitbucket/*, and the cross-provider wallet-auth installs router (B3 -
// phone list/revoke) owns /installs*.
app.use('/v1/witnesses', createWitnessesGitHubRouter(agentBankDeps));
app.use('/v1/gates/github', createGitHubPrGateRouter(db, cache));
app.use('/v1/witnesses', createWitnessesGitLabRouter(agentBankDeps));
app.use('/v1/witnesses', createWitnessesBitbucketRouter(agentBankDeps));
app.use('/v1/witnesses', createWitnessesInstallsRouter(agentBankDeps));

// --- Contract Registry ---
app.use('/v1/admin/contract-registry', createContractRegistryRouter(agentBankDeps));
app.use('/v1/contract-registry', createContractRegistryPublicRouter(agentBankDeps));

// --- Admin Weight Adjustment ---

// --- Legacy Genesis admin boundary: read/kill only; retired economic and pool
// configuration writes are rejected. Fresh PVT9 activation is a separate path. ---
import adminGenesisRouter from './routes/admin-genesis';
app.use('/v1/admin/pvt/genesis', adminGenesisRouter);

// --- Admin PVT action-policy queue ---
// Reads are available to the existing admin-secret holder. Prospective
// classification writes have a second, default-off post-Gate-1 activation flag
// inside the router so deploying this operator surface cannot activate economic
// policy by itself.
import { createAdminPVTPolicyRouter } from './routes/admin-pvt-policy';
import { reconcileLiveActionTypes, resolveQueueRowsLandedInSignedMatrix } from './core/pvt/policy/action-type-reconciler';
import { runActionTypeActivationNotify } from './core/pvt/policy/action-type-activation-notify';
import { dispatchTargetedEvent, dispatchWebhookEvent } from './core/agent-bank/webhooks';

app.use('/v1/admin/pvt/policy', createAdminPVTPolicyRouter({ db }));

// --- Security ---
app.use('/v1/security', createScamListRouter({ cache, db }));

// --- Device Registration Setup Tokens ---
app.use('/v1/setup', authenticate, createSetupRouter({ db, cache }));

// Public discovery endpoints - must mount BEFORE the catch-all
// `app.use('/v1', authenticate, ...)` below, otherwise they 401 even when
// PUBLIC_LAUNCH=true. (Each handler still gates itself on PUBLIC_LAUNCH and
// returns 404 in pre-launch.)
app.use('/v1/ecosystem', createEcosystemRouter(db));
// GET /v1/sdk/version — advisory SDK-version signal for agents. PUBLIC and
// deliberately NOT PUBLIC_LAUNCH-gated: agents connect pre-launch and must be
// able to learn staleness at any time. Fail-open — this never gates anything.
app.get('/v1/sdk/version', (_req, res) => {
  res.json(sdkVersionInfo());
});
mountOpenAPIRoutes(app);
// The relay origin's x402 discovery document (`GET /openapi.json`): the PE Archive's agent pay route,
// the one paid x402 operation, for indexers such as x402scan. Served once the site is open
// (PUBLIC_LAUNCH, read per request); before that the path answers as an unknown path does.
const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL || 'https://api.provian.ai';
app.use(createX402DiscoveryRouter({ publicBaseUrl: publicApiBaseUrl }));
// Legacy PVT estimates are explicitly rejected by the early runtime boundary boundary.
// GET /v1/reputation/address/:address — public chain-verified reputation read
// (bond lifecycle; PUBLIC_LAUNCH-gated inside the router).
app.use('/v1/reputation', createReputationRouter({ db, cache }));
// Remote MCP endpoint (streamable HTTP, stateless) — serves the shared tool
// core (canonical: provian-mcp/src/core; the local stdio server ships at
// public launch when @provian/mcp publishes). PUBLIC_LAUNCH-gated inside
// like the descriptor.
mountMCPRoutes(app);

// --- Wallet attestation upload (Wave 4 STEP 8) ---
// Wallet-auth gated; the route closes the Wave 3 BLOCKER-2 write-path gap by
// populating wallets/{user_id}.attested_security_level from platform
// attestation evidence.
// Mount path-scoped (not `/v1`) so the authenticate middleware doesn't
// fan out across every /v1/* route. The previous `/v1` mount silently
// broke Cloud Scheduler invocations of /v1/internal/scheduler/* between
// 2026-05-05 (commit 55d2bd6) and 2026-05-09 - OIDC Bearer tokens were
// parsed as v2 wallet auth and 400'd with malformed_token before
// reaching the scheduler endpoint's own authenticateScheduler call.
app.use('/v1/wallet/attestation', authenticate, createWalletAttestationRouter({ db, cache }));

// --- Agent Ecosystem Infrastructure ---
app.use('/v1/agents', createAgentDirectoryRouter(agentBankDeps));
app.use('/v1/jobs', createAgentJobsRouter(agentBankDeps));
// Commons dual auth (shared by /v1/commons, /v1/wants, /v1/threads): agent wallets
// (pvn_live_ prefix) set req.agentWallet; human wallets set req.user via authenticate (non-failing
// — route handlers decide with requireAuth); no auth header passes through for public reads.
const commonsDualAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();
  // QR session credentials are 48 random bytes. Every private Commons/threads/projection
  // handler verifies them through requireAuth before reading or mutating private data.
  if(/^Bearer [a-f0-9]{96}$/.test(authHeader))return next();
  if (authHeader.includes('pvn_live_')) {
    return authenticateAgent(req, res, next);
  }
  return authenticate(req, res, () => {
    next();
  });
};
// Wants board + want→fulfiller match (work package O7 — the demand loop): the lightweight,
// UNFUNDED demand layer that feeds the funded jobs/escrow path. posting a want is
// Commons SPEECH — behind the poster's live presentation window, sealed as a `want_posted` PE
// that mints at its class base (budget-bounded by the window's burn); featured placement on
// the board is its own burn auction. App-authed pre-flip; the reads open at the launch flip.
app.use('/v1/wants', commonsDualAuth, createWantsRouter(agentBankDeps));
// Threads : bilateral communication anchored to a job / want / escrow / dispute /
// profile. Every message is a `commons_thread_message` PE (content hash sealed, content E2E
// ciphertext the relay cannot read); presentations travel inside threads between any two
// wallets. Party-authenticated end to end.
app.use('/v1/threads', commonsDualAuth, createThreadsRouter(agentBankDeps));
app.use('/v1/names', createNamesRouter(agentBankDeps)); // work package O8 name registry public forward lookup (dark pre-flip)
app.use('/v1/standing', createStandingRouter(agentBankDeps)); // work package O9 burn-backed standing-export public verify (dark pre-flip)
app.use('/v1/pledges', createPledgesRouter(agentBankDeps)); // work package O5 burn-backed public pledge verify (dark pre-flip)
app.use('/v1/webhooks', createWebhookRouter(agentBankDeps));
app.use('/v1/pe', createPEProposalRouter(agentBankDeps));
// Earning-type proposal commons (work package O3): permissionless PUBLIC "propose that a
// kind of work should earn" surface. Reachable on the same footing as the
// PE-type catalog (opened /v1/pe/*). Mints nothing; the only mint-gating
// path stays the admin classify route in admin-pvt-policy.ts.
app.use('/v1/pe', createEarningProposalRouter(agentBankDeps));
app.use('/v1/pe/conformance', createConformanceRouter(cache));

// --- Provian Commons ---
// Optional dual auth: agent wallets (pvn_live_ prefix) set req.agentWallet;
// human wallets set req.walletAuth via authenticate. If no auth header,
// pass through - public Commons endpoints handle their own auth checks.
app.use('/v1/commons', commonsDualAuth, createCommonsRouter({
  ...agentBankDeps,
}));

// --- PE Public Projections (protocol layer) ---
// Mounted AFTER pe-proposals, conformance, and commons routers.
// Uses /projection/:peId and /consent/ prefixes to avoid wildcard collisions.
app.use('/v1/pe', commonsDualAuth, createPEProjectionsRouter(agentBankDeps));

// --- PE Verification (third-party trust-layer reads) — C-1 ---
// Mounted LAST of the /v1/pe routers: its `/:pe_id/proof` is parametric and
// would otherwise shadow `/submit`, `/conformance`, `/projection` and the
// proposal routes above.
//
// B10 (, the design requires ARM): `peAnchorContract` is now the READ-ONLY
// contract on the deployed PEAnchor (provider-only — no key material ever
// enters request-path deps; the signer lives solely in the scheduler handlers
// above via pe-anchor-runtime.ts). `POST /verify` answers real on-chain
// inclusion proofs; the runtime boundary boundary's independent block was opened in the
// same change (the C-1 concern — "it would answer about a chain nothing
// writes to" — dissolves now that the daily anchoring writes to it). An
// unconfigured env yields null and the route fails closed exactly as before.
app.use('/v1/pe', createPEVerifyRouter({
  ...agentBankDeps,
  peAnchorContract: buildPeAnchorReadContract(() => getChainProvider('base')),
}));

// --- Burn-to-present ---
// Public presentation VERIFICATION surface (burn-to-present). Reachable at launch
// with NO account and NO PUBLIC_LAUNCH flip (decided requirement): a presentation
// is handed to an external counterparty who has no Provian account, so its verify
// surface must be publicly reachable. NOT in CLOSED_PRE_LAUNCH_PREFIXES and carries
// no discovery gate — a purpose-built verification endpoint, not the broad
// network-discovery surface. The peAnchorContract is the same READ-ONLY contract
// pe-verify uses (provider-only, no key), used to optionally check pe_fact proofs
// on-chain as a convenience; the trustless path needs no server at all.
app.use('/v1/present', createPresentRouter({
  peAnchorContract: buildPeAnchorReadContract(() => getChainProvider('base')),
  cache,
  db,
}));
// GET /v1/schema/pe — the ONE versioned PE schema (§2.10), served LIVE from the
// relay's own types so it can never lag. Public + read-only (a builder has no
// account); the SDK ships a snapshot that the drift test (§2.12) keeps in step.
app.get('/v1/schema/pe', (_req: Request, res: Response): void => {
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.json(buildPeSchema());
});
// Human first-party burn + present (burn-to-present, human side). Wallet-auth
// applied at the mount so every route is `req.user`-authed; the exact parallel of
// the agent routes on the agent-wallet router, on the shared burn substrate +
// presentation primitive.
// a phone registers its PE-attestation key as its output signing key (wallet auth).
// Mounted per ROUTE before the /v1/wallet router so the single-use wallet token is checked once.
app.post('/v1/wallet/output-signing-key', authenticate, createWalletOutputKeyHandler({ db }));
app.use('/v1/wallet', authenticate, createWalletPresentationRouter({ db }));

// (mountOpenAPIRoutes was moved earlier so the catch-all auth doesn't 401
// /v1/openapi.json before the route handler can run.)

// --- Passkey Authentication (C-4: server-side challenge + verification) ---
// P4-13 (Pass-4 reachability audit): UNMOUNTED until the registration half
// exists. Only the challenge + verify halves were ever built; no code path
// writes the `passkey_credentials` collection, so /verify permanently 401s
// with "Credential not registered" and /challenge issues a challenge that can
// never be redeemed. Mounting + advertising an endpoint that cannot complete
// is a dead affordance. Re-enable this block (and the import above) once a
// passkey registration endpoint that writes passkey_credentials — and a client
// that calls it — land. See provian-backend/src/routes/passkey-auth.ts.
//
// app.use('/v1/auth/passkey', createPasskeyAuthRouter({
//   db,
//   cache,
//   sessionSecret: (() => {
//     if (!process.env.SESSION_SECRET) {
//       throw new Error('[FATAL] SESSION_SECRET is not set - passkey session HMAC signing requires a stable secret');
//     }
//     return process.env.SESSION_SECRET;
//   })(),
//   rpId: process.env.PASSKEY_RP_ID || 'provian.ai',
// }));

// Legacy PVT, governance, and on-chain PE-proof routers are intentionally not
// mounted. The early path boundary returns stable errors for their exact paths;
// PE proposal, projection, signature, hash-chain, and history routes stay live.

// --- : Provian's x402 facilitator ---
// The facilitator (its own Cloud Run service) reports each settlement it lands as a POINTER; the
// relay re-reads the transaction on chain and seals the buyer's x402_payment and the seller's
// receive (Provian identities only) under the unchanged pricing and mint-once rules. Shared-secret
// auth in the handler (FACILITATOR_RELAY_SECRET; unset → 503). Mounted on its own internal prefix,
// above no router-level gate (nothing earlier is mounted on /v1/internal/x402).
app.use('/v1/internal/x402', createFacilitatorSettlementRouter({
  laneDeps: () => buildFacilitatorLaneDeps(agentBankDeps, {
    activityMappingEnabled: async () => {
      const { isActivityMappingEnabled } = await import('./core/pvt/activity-mapping-config');
      return isActivityMappingEnabled(db);
    },
  }),
}));
// The public seller list (active sellers, public fields only). A public VIEW: closed pre-flip by
// `preLaunchSurfaceGate` (`/v1/x402`), like the agent directory it also appears in.
app.use('/v1/x402', createX402SellersRouter({ db, cache }));

// Phase 2: reconcile "building" rulings to live once their type is on the
// served, digest-matched matrix. Phase 4 extends this to fan out the submitter
// activation notice for each newly-live type.
app.post('/v1/internal/scheduler/action-type-reconcile', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await reconcileLiveActionTypes(db);
    // close the pending-policy queue row of every type that
    // landed on the signed matrix (the alert scan also closes a due one).
    const queue = await resolveQueueRowsLandedInSignedMatrix(db);
    // Phase 4: the reconciler's live transition triggers the submitter
    // activation notice. Best-effort here for prompt delivery; the dedicated
    // job below is the durable, idempotent retry.
    let notify: Awaited<ReturnType<typeof runActionTypeActivationNotify>> | { error: string } | undefined;
    if (result.newly_live.length > 0) {
      try {
        notify = await runActionTypeActivationNotify(db, {
          dispatchWebhook: (eventType, payload) => dispatchWebhookEvent(agentBankDeps, eventType, payload),
          dispatchTargetedWebhook: (args) => dispatchTargetedEvent(agentBankDeps, args),
        });
      } catch (e) {
        notify = { error: String(e).slice(0, 200) };
      }
    }
    let runtimeReadModelRefreshed = false;
    await publishRuntimeReadModel(db).then(() => { runtimeReadModelRefreshed = true; })
      .catch((error: unknown) => console.error('[runtime-read-model] refresh failed', error));
    res.json({ ...result, queue, notify, runtime_read_model_refreshed: runtimeReadModelRefreshed });
  } catch (error) {
    handleEndpointError(res, error, 'ActionTypeReconcile');
  }
});

// Phase 4: the durable, idempotent submitter activation-notice fan-out.
// Scans live rulings whose notice has not yet been dispatched (activation_fanout_at
// absent) and notifies each type's submitters — humans via push
// (data.type:'action_type_activated'), agents via the action_type_activated webhook.
app.post('/v1/internal/scheduler/action-type-activation-notify', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await runActionTypeActivationNotify(db, {
      dispatchWebhook: (eventType, payload) => dispatchWebhookEvent(agentBankDeps, eventType, payload),
      dispatchTargetedWebhook: (args) => dispatchTargetedEvent(agentBankDeps, args),
    });
    res.json(result);
  } catch (error) {
    handleEndpointError(res, error, 'ActionTypeActivationNotify');
  }
});

app.post('/v1/internal/scheduler/auto-release', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const count = await processAutoReleases(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] Auto-release error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/v1/internal/scheduler/defaults', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // addendum : agent-promise default has TWO paths.
    // `processDefaults` is the RELAY-OBSERVED sweep — it marks funded promises past
    // their deadline `defaulted` (relay_observed) so the borrower's reputation
    // reflects it immediately; the lender's on-chain `markDefault` (POST
    // /v1/promises/:id/default) later upgrades the same row to onchain_proven. This
    // hourly cron also purges expired human P2P promises (30-day TTL, the
    // server-side equivalent of the retired promise_sync Firestore TTL) — reusing
    // the existing job avoids a new cron and the scheduler-reconcile gate.
    const count = await processDefaults(agentBankDeps);
    const expiry = await processHumanPromiseExpiry(db);
    res.json({ processed: count, human_promise_expiry: expiry });
  } catch (error) {
    console.error('[Scheduler] Default detection error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Finding 14: drain the durable agent-bank event outbox — badge reconciliation
// and subscriber webhook delivery for events the route handlers recorded before
// responding, instead of the old fire-and-forget promise that Cloud Run dropped
// on instance shutdown. Idempotent + single-winner; safe to run frequently.
//
// the same 5-minute job is the GUARANTEE for burn finality — every burn accepted at
// one-block inclusion (`pvt_burn_records.finality == 'provisional'`) gets its 12-block finality
// check here, and a burn that fails it is revoked with every relay-held benefit it backs. The
// in-process finalizer usually lands first; this catches whatever it did not. Runs beside the
// outbox drain; a failure in one never skips the other.
app.use('/v1/internal/tasks/github', createGitHubTaskRouter(agentBankDeps));

app.post('/v1/internal/scheduler/agent-bank-events', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const [result, burnFinality] = await Promise.all([
      drainAgentBankEventOutbox(agentBankDeps),
      sweepBurnFinality({ db, log: (l) => console.warn(l) }).catch((err: unknown) => {
        console.error('[Scheduler] Burn finality sweep error:', err);
        return { error: 'burn_finality_sweep_failed' } as const;
      }),
    ]);
    // a burn not provably final past the deadline is STALLED — kept (benefits and all),
    // retried every pass, never revoked on an RPC failure. Page loudly; `system_status/burn_finality`
    // carries the same alarm to the operator email/push check.
    if ('alarm' in burnFinality && burnFinality.alarm) {
      console.error(`[Scheduler] BURN FINALITY ALARM — ${burnFinality.stalled} provisional burn(s) stalled: ${JSON.stringify(burnFinality)}`);
    }
    res.json({ ...result, burn_finality: burnFinality });
  } catch (error) {
    console.error('[Scheduler] Agent-bank event drain error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/v1/internal/scheduler/expired-pools', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const count = await processExpiredPools(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] Expired pools error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/v1/internal/scheduler/court-deadlines', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const count = await processCourtDeadlines(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] Court deadlines error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/v1/internal/scheduler/general-dispute-deadlines', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const { processGeneralDisputeDeadlines } = await import('./core/agent-bank/court');
    const count = await processGeneralDisputeDeadlines(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] General dispute deadlines error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cost gate for the genesis milestone crons: when the campaign is closed
// (killed/force-off, window over, or pool exhausted) each scan early-returns
// after one cheap config+state read instead of enumerating every wallet and
// hitting RPC. This is what makes the cron cost effectively stop when genesis ends.
async function genesisScanGate(res: Response): Promise<boolean> {
  const { loadGenesisCampaignConfig, getGenesisCampaignState, isGenesisScanActive } =
    await import('./core/pvt/genesis-campaign');
  const cfg = await loadGenesisCampaignConfig();
  const state = await getGenesisCampaignState(db, cfg);
  if (!isGenesisScanActive(cfg, state, Date.now())) {
    res.json({ skipped: 'genesis_inactive' });
    return false;
  }
  return true;
}

// Independent gate for the PERMANENT activity-mapping crons. Deliberately NOT the
// genesis gate: mapping is a standing capability that must keep running when the
// Genesis campaign is disarmed/empty. Halted only by its own kill switch
// (activity-mapping-config.ts). Returns false (and answers the request) when paused.
async function activityMappingGate(res: Response): Promise<boolean> {
  const { isActivityMappingEnabled } = await import('./core/pvt/activity-mapping-config');
  if (!(await isActivityMappingEnabled(db))) {
    res.json({ skipped: 'activity_mapping_disabled' });
    return false;
  }
  return true;
}

app.post('/v1/internal/scheduler/inbound-usdc', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // Permanent layer: gated on the activity-mapping kill switch, NOT Genesis.
    if (!(await activityMappingGate(res))) return;
    const { scanInboundUsdc, buildBaseInboundDeps } = await import('./core/pvt/inbound-usdc-watcher');
    const startBlock = typeof req.body?.start_block === 'number' ? req.body.start_block : undefined;
    const report = await scanInboundUsdc(buildBaseInboundDeps(agentBankDeps), { startBlock });
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Inbound USDC scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Permanent layer (outbound leg): map proven-external-address outbound USDC into
// standard Financial PEs (x402_payment / swap / stake / send) via on-chain Transfer
// LOGS. Closes the gasless-x402 gap the nonce scanner missed. Gated on the
// activity-mapping kill switch, NOT Genesis. Supersedes genesis-external-outbound.
/**
 * Stage 1b — the institution funding watcher.
 *
 * Observes EscrowFunded / PoolContribution / PromiseFunded on Base through the
 * quorum-2 log reader and emits one linked-evidence PE per canonical funding
 * event, independently of whatever an API caller told the relay.
 *
 * IT PAYS. The 1b(iii) `verified` stamp landed : the funding trio now
 * seals `eligible` per funding, but ONLY when `evaluateFundingVerdict` grants
 * the stamp against a finality witness RE-DERIVED at stamp time (safe-head depth
 * per). A refused verdict seals the same verdict-less `pending_evidence`
 * row 1b(i)/1b(ii) sealed and pays 0 ("Unknown = Block"). No caller can assert
 * `verified` directly — the watcher module is the mint switch (see its docblock).
 *
 * The population is legitimately SPARSE (one log across all three
 * institutions in 300k blocks). A cycle reporting nothing is expected.
 */
app.post('/v1/internal/scheduler/institution-funding', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // The SAME operational pause both USDC watchers carry (`inbound-usdc`,
    // `outbound-usdc`). Found missing by the 1b(ii) reviewer leg: without it an
    // operator halting chain-derived PE emission during an incident would stop
    // both siblings while this one kept emitting durable rows and advancing its
    // cursor over the incident window — and its emissions are irreversible (PE
    // + emission lock + a sealed snapshot that may never be repriced).
    const { isActivityMappingEnabled } = await import('./core/pvt/activity-mapping-config');
    const { runInstitutionWatcherScheduler } = await import('./core/pvt/institution-watcher-status');
    const { runInstitutionFundingWatcherCycle, buildBaseInstitutionWatcherDeps } =
      await import('./core/pvt/institution-funding-watcher');
    const { generatePE } = await import('./core/agent-bank/pe-utils');
    const outcome = await runInstitutionWatcherScheduler(db, 'funding', () => isActivityMappingEnabled(db), () => runInstitutionFundingWatcherCycle(
      buildBaseInstitutionWatcherDeps({
        db: agentBankDeps.db,
        generate: generatePE,
        peDeps: agentBankDeps,
      }),
      {
        maxBlocksPerCycle: typeof req.body?.max_blocks === 'number'
          ? req.body.max_blocks
          : undefined,
      },
    ));
    const report = outcome.report;
    // Ops observability (Part D): per-event-type watcher throughput. Bumped from the caller
    // (server.ts is NOT core/pvt) off the report's plain tally — the watcher never imports
    // ops-counters. Structure-only; the type name is a public action-type label.
    for (const [t, n] of Object.entries('emittedByType' in report ? report.emittedByType : {})) bumpOpsCounter(`watcher.${t}`, n);
    res.status(outcome.httpStatus).json(report);
  } catch (error) {
    console.error('[Scheduler] Institution funding watcher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Institution COMPLETION watcher — the sibling of the funding watcher for
 * lifecycle completions (EscrowReleased / EscrowResolved / PromiseSettled /
 * PoolExecuted). Emits one linked-evidence PE per canonical completion event,
 * attributed to the party the ON-CHAIN EVENT NAMES.
 *
 * IT PAYS. The 3b matrix reclassification LANDED in the four
 * completion types (escrow_completed / escrow_resolved / promise_settled /
 * pool_executed) are `verified_institution_lifecycle`, `session_lineage:
 * 'optional'`, `mint_disposition: 'eligible'` in the live matrix — the funding
 * trio's exact config — so this watcher's verified chain-finality emit MINTS,
 * and the cron has run every 15 min since that deploy. A refused finality
 * verdict seals the verdict-less row and pays 0. Same operational pause
 * (`activityMappingGate`). See the watcher docblock — it is the mint switch.
 */
app.post('/v1/internal/scheduler/institution-completion', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { isActivityMappingEnabled } = await import('./core/pvt/activity-mapping-config');
    const { runInstitutionWatcherScheduler } = await import('./core/pvt/institution-watcher-status');
    const { runInstitutionCompletionWatcherCycle, buildBaseInstitutionCompletionWatcherDeps } =
      await import('./core/pvt/institution-completion-watcher');
    const { generatePE } = await import('./core/agent-bank/pe-utils');
    const outcome = await runInstitutionWatcherScheduler(db, 'completion', () => isActivityMappingEnabled(db), () => runInstitutionCompletionWatcherCycle(
      buildBaseInstitutionCompletionWatcherDeps({
        db: agentBankDeps.db,
        generate: generatePE,
        peDeps: agentBankDeps,
      }),
      {
        maxBlocksPerCycle: typeof req.body?.max_blocks === 'number'
          ? req.body.max_blocks
          : undefined,
      },
    ));
    const report = outcome.report;
    // Ops observability (Part D): per-event-type watcher throughput (see the funding twin above).
    for (const [t, n] of Object.entries('emittedByType' in report ? report.emittedByType : {})) bumpOpsCounter(`watcher.${t}`, n);
    res.status(outcome.httpStatus).json(report);
  } catch (error) {
    console.error('[Scheduler] Institution completion watcher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trust Layer build §2.12 : institution STANDING watcher — BondPool / CourtV2 lifecycle
// events (adverse, neutral, positive) as chain-witnessed record_only rows Standing counts.
// `block_chunk` (≤ INSTITUTION_MAX_BLOCK_CHUNK) lets an operator backfill from a seeded
// checkpoint in bounded getLogs calls; the cron body is `{}`.
app.post('/v1/internal/scheduler/institution-standing', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    if (!(await activityMappingGate(res))) return;
    const { runInstitutionStandingWatcherCycle, buildBaseInstitutionStandingWatcherDeps } =
      await import('./core/pvt/institution-standing-watcher');
    const { generatePE } = await import('./core/agent-bank/pe-utils');
    const report = await runInstitutionStandingWatcherCycle(
      buildBaseInstitutionStandingWatcherDeps({
        db: agentBankDeps.db,
        generate: generatePE,
        peDeps: agentBankDeps,
      }),
      {
        maxBlocksPerCycle: typeof req.body?.max_blocks === 'number' ? req.body.max_blocks : undefined,
        blockChunk: typeof req.body?.block_chunk === 'number' ? req.body.block_chunk : undefined,
      },
    );
    for (const [t, n] of Object.entries(report.emittedByType ?? {})) bumpOpsCounter(`watcher.${t}`, n);
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Institution standing watcher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Standing reconcile — every sealed adverse row inside the window is counted in
// `actor_stats_v1` exactly once (the live bump is best-effort; this is what makes a lost bump
// unable to hide an adverse event). A repaired row is logged as an alarm; any failure answers 500.
app.post('/v1/internal/scheduler/standing-reconcile', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // the two relay-witnessed events are SEALED here when no request did it — a hire dispute
    // the chain resolved that nobody reported, and an upheld Commons challenge (a lapsed window is
    // settled, and the challenged party's row sealed). Each sweep is independent; a failure in one
    // is reported and never stops the count below.
    const { observeResolvedHireDisputes } = await import('./core/commons/job-disputes');
    const { sweepChallengeStanding } = await import('./core/commons/forum');
    const sweepFailed = (sweep: string) => (error: unknown) => {
      console.error(`[Scheduler] Standing sweep failed (${sweep}):`, error);
      return { failures: 1, sweep_error: true };
    };
    const hire_disputes = await observeResolvedHireDisputes(agentBankDeps).catch(sweepFailed('hire_disputes'));
    const challenges = await sweepChallengeStanding(agentBankDeps).catch(sweepFailed('challenges'));
    // A hire that was never funded and can no longer be is closed and the job reopened.
    const { closeUnfundedHires } = await import('./core/commons/human-jobs');
    const unfunded_hires = await closeUnfundedHires(agentBankDeps).catch(sweepFailed('unfunded_hires'));

    // PE METER: the adverse-row reconcile over `pe_history` is RETIRED — the meter's batch commit
    // counts every fresh act into `actor_stats_v1` in the same transaction as its act key, so there
    // is no lost bump to repair and no history to read (`actor-stats-backfill.ts`).
    const failed = hire_disputes.failures > 0 || challenges.failures > 0 || unfunded_hires.failures > 0;
    res.status(failed ? 500 : 200).json({
      standing_reconcile: 'retired_pe_meter_counts_in_commit',
      hire_disputes,
      challenges,
      unfunded_hires,
    });
  } catch (error) {
    console.error('[Scheduler] Standing reconcile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/v1/internal/scheduler/outbound-usdc', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    if (!(await activityMappingGate(res))) return;
    const { scanOutboundUsdc, buildBaseOutboundDeps } = await import('./core/pvt/outbound-usdc-watcher');
    const startBlock = typeof req.body?.start_block === 'number' ? req.body.start_block : undefined;
    const report = await scanOutboundUsdc(buildBaseOutboundDeps(agentBankDeps), { startBlock });
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Outbound USDC scan error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Independent discovery cannot be delayed by transaction verification or other chains.
app.post('/v1/internal/scheduler/chain-record-discovery', async (req, res) => {
  if (!await authenticateScheduler(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try {
    if (!(await activityMappingGate(res))) return;
    const { acquireChainRecordRunLease, releaseChainRecordRunLease, finishChainRecordRun, CHAIN_RECORD_RUN_LEASE_TTL_MS } = await import('./core/pvt/chain-record-run-lease');
    const workerId = crypto.randomUUID();
    if (!await acquireChainRecordRunLease(db, { workerId, nowMs: Date.now(), leaseTtlMs: CHAIN_RECORD_RUN_LEASE_TTL_MS, workload: 'discovery' })) {
      res.json({ skipped: 'chain_record_discovery_held' }); return;
    }
    const report = await finishChainRecordRun(async () => {
      const progress = (phase: string, details: Readonly<Record<string, string | number>> = {}): void => {
        const memory = process.memoryUsage();
        console.info('[chain-record-discovery]', { phase, ...details, rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed });
      };
      progress('reconcile_begin');
      // Queue token and native ETH transfers, internal ETH and watched signed
      // transactions. Verification runs independently on the drain job.
      const { runChainRecordInboundScan, buildChainRecordInboundScanDeps, setAsideUnwatchableSourceRow } = await import('./core/pvt/chain-record-inbound-scan');
      // the watch registry's daily reconcile (one bounded slice per run) and, for two
      // hours after each new revision, the check of recently created rows. Every watcher reads
      // the registry, so a source row missing from it is added and rescanned from its fence.
      let registryReconcile: unknown;
      try {
        const { runWatchRegistryReconcile } = await import('./core/pvt/watch-registry-reconcile');
        registryReconcile = await runWatchRegistryReconcile(db, Date.now(), {
          onMalformed: (row) => setAsideUnwatchableSourceRow(db, row, Date.now()),
        });
      } catch (reconcileError) {
        console.error('[Scheduler] Watch registry reconcile error:', reconcileError);
        registryReconcile = { error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError) };
      }
      progress('reconcile_complete');
      let inboundScan: unknown;
      try {
        const scan = buildChainRecordInboundScanDeps(db), compact = scan.getCompactWindow;
        if (!compact) throw new Error('chain_record_compact_discovery_missing');
        inboundScan = await runChainRecordInboundScan({ ...scan,
          getHead: async () => {
            progress('head_begin'); const head = await scan.getHead(); progress('head_ready', { head }); return head;
          },
          getCompactWindow: async args => {
            const range = { from_block: args.fromBlock, to_block: args.toBlock, watched_count: args.watched.size };
            progress('window_begin', range);
            const began = Date.now();
            const heartbeat = setInterval(() => progress('window_pending', { ...range, elapsed_ms: Date.now() - began }), 15_000);
            heartbeat.unref();
            try {
              const window = await compact(args);
              progress('window_ready', { ...range, mode: window.mode ?? 'unlabelled' });
              return window;
            } finally { clearInterval(heartbeat); }
          },
        });
      } catch (scanError) {
        console.error('[Scheduler] Chain-record inbound scan error:', scanError);
        inboundScan = { error: scanError instanceof Error ? scanError.message : String(scanError) };
      }
      progress('scan_complete');
      return { watch_registry: registryReconcile, inbound_scan: inboundScan };
    }, () => releaseChainRecordRunLease(db, { workerId, nowMs: Date.now(), workload: 'discovery' }));
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Chain-record discovery error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// the chain-record lane: chain-verified transfer/swap records mint again.
// same terms for humans (the app's send/swap records queue their tx) and
// non-USDC receives (the independent discovery job queues them).
// Drains the observations /transfer/record and /swap/record queue; each is
// re-read from the chain (two operator legs, confirmation floor + safe head)
// and mints one send/swap through the unchanged fences and ceilings.
app.post('/v1/internal/scheduler/chain-record', async (req, res) => {
  if (!await authenticateScheduler(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try {
    if (!(await activityMappingGate(res))) return;
    const { acquireChainRecordRunLease, releaseChainRecordRunLease, finishChainRecordRun, CHAIN_RECORD_RUN_LEASE_TTL_MS } = await import('./core/pvt/chain-record-run-lease');
    const workerId = crypto.randomUUID();
    if (!await acquireChainRecordRunLease(db, { workerId, nowMs: Date.now(), leaseTtlMs: CHAIN_RECORD_RUN_LEASE_TTL_MS, workload: 'drain' })) {
      res.json({ skipped: 'chain_record_run_in_progress' }); return;
    }
    const report = await finishChainRecordRun(async () => {
      const { runChainRecordWatcherCycle, buildChainRecordWatcherDeps, readChainRecordDrainCapacity } = await import('./core/pvt/chain-record-watcher');
      return runChainRecordWatcherCycle(buildChainRecordWatcherDeps(agentBankDeps), readChainRecordDrainCapacity());
    }, () => releaseChainRecordRunLease(db, { workerId, nowMs: Date.now(), workload: 'drain' }));
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Chain-record watcher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recovery and other chains have their own cadence and never occupy Base drain capacity.
app.post('/v1/internal/scheduler/chain-record-auxiliary', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    if (!(await activityMappingGate(res))) return;
    // One verification/fallback run at a time; Base discovery has its own lease.
    const { acquireChainRecordRunLease, releaseChainRecordRunLease, finishChainRecordRun, CHAIN_RECORD_RUN_LEASE_TTL_MS } = await import('./core/pvt/chain-record-run-lease');
    const leaseWorker = crypto.randomUUID();
    if (!(await acquireChainRecordRunLease(db, { workerId: leaseWorker, nowMs: Date.now(), leaseTtlMs: CHAIN_RECORD_RUN_LEASE_TTL_MS, workload: 'auxiliary' }))) {
      res.json({ skipped: 'chain_record_auxiliary_held' });
      return;
    }
    const response = await finishChainRecordRun(async () => {
      // 2026-10-01: proven external addresses (a person's or an agent's) — every
      // transaction the proven EOA signed, found from its nonce, queued the same way.
      const { runChainRecordProvenOutboundScan, buildChainRecordProvenOutboundScanDeps } = await import('./core/pvt/chain-record-proven-outbound-scan');
      let provenOutboundScan: unknown;
      try {
        provenOutboundScan = await runChainRecordProvenOutboundScan(buildChainRecordProvenOutboundScanDeps(db));
      } catch (scanError) {
        console.error('[Scheduler] Chain-record proven outbound scan error:', scanError);
        provenOutboundScan = { error: scanError instanceof Error ? scanError.message : String(scanError) };
      }
      // Arbitrum One and OP Mainnet: transfers into and out of every watched address,
      // queued for the next drain (each address at most hourly per chain). Independent of the
      // Base drain, so it never delays it.
      let multichainScan: unknown;
      try {
        const { runChainRecordMultichainScan, buildChainRecordMultichainScanDeps } = await import('./core/pvt/chain-record-multichain-scan');
        multichainScan = await runChainRecordMultichainScan(buildChainRecordMultichainScanDeps(db));
      } catch (scanError) {
        console.error('[Scheduler] Chain-record multichain scan error:', scanError);
        multichainScan = { error: scanError instanceof Error ? scanError.message : String(scanError) };
      }
      // : retry x402 facilitator settlement pointers whose transaction was not yet
      // final when the facilitator reported it. A sweep failure is reported, never fatal.
      let facilitatorSweep: unknown;
      try {
        const { runFacilitatorSettlementSweep, buildFacilitatorLaneDeps: buildLane } = await import('./core/pvt/x402-facilitator-lane');
        facilitatorSweep = await runFacilitatorSettlementSweep(buildLane(agentBankDeps));
      } catch (sweepError) {
        console.error('[Scheduler] x402 facilitator sweep error:', sweepError);
        facilitatorSweep = { error: sweepError instanceof Error ? sweepError.message : String(sweepError) };
      }
      // Solana: discovery over the Solana proven-address registry, then the drain. Never fatal to the Base lane.
      let solanaChainRecord: unknown;
      try {
        const { runSolanaChainRecordCycle, buildSolanaChainRecordDeps } = await import('./core/pvt/solana-chain-record-lane');
        solanaChainRecord = await runSolanaChainRecordCycle(buildSolanaChainRecordDeps(agentBankDeps));
      } catch (solanaError) {
        console.error('[Scheduler] Solana chain-record lane error:', solanaError);
        solanaChainRecord = { error: solanaError instanceof Error ? solanaError.message : String(solanaError) };
      }
      return { proven_outbound_scan: provenOutboundScan, multichain_scan: multichainScan, x402_facilitator_sweep: facilitatorSweep, solana_chain_record: solanaChainRecord };
    }, () => releaseChainRecordRunLease(db, { workerId: leaseWorker, nowMs: Date.now(), workload: 'auxiliary' }));
    res.json(response);
  } catch (error) {
    console.error('[Scheduler] Chain-record watcher error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// F-A1-1 (/ class fix — anything meant to be continuous is scheduled):
// the Genesis recovery DRAIN. The two paying legs advance a grant fire-and-forget
// (`void processGenesisQualification(...)` at routes/agent-wallet.ts and
// routes/devices.ts); on Cloud Run an instance reclaimed after res.send strands
// the grant at an intermediate state (pending_reservation → reserved → emitting →
// pe_recorded → complete). The settlement inlet selects only status=='complete',
// so a stranded grant mints 0 forever. This scheduled drain re-drives every
// stranded row to complete so it mints. Lease-guarded and resumable → idempotent;
// a Cloud Scheduler retry cannot double-grant.
app.post('/v1/internal/scheduler/genesis-drain', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    const results = await drainGenesisQualifications(agentBankDeps, { limit });
    // addendum: a row that fails recovery is reported per row in the response only, so a
    // grant stranded by a failing check retried every 30 minutes behind a 200 for days. Log it.
    const stranded = results.filter((r) => r.status !== 'complete');
    if (stranded.length > 0) {
      const reasons: Record<string, number> = {};
      for (const r of stranded) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      console.error(`[Scheduler] Genesis drain: ${stranded.length} of ${results.length} not completed ${JSON.stringify(reasons)}`);
    }
    res.json({ drained: results.length, results });
  } catch (error) {
    console.error('[Scheduler] Genesis drain error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// F-A1-2: the Genesis retention → outbox PROMOTION. An in-window act whose
// activation read TRANSIENTLY failed (shouldPersistGenesisQualification saw a
// null activation) routes to the retention collection, not the mint-readable
// outbox, and stays there unsettleable until promoted. This scheduled backfill
// re-runs the FULL persist gate against the CURRENT activation (using the original
// qualifying timestamp for the window check) and promotes every now-admissible
// retained row into the outbox, where the next settlement cycle mints it.
app.post('/v1/internal/scheduler/genesis-retention-backfill', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    const report = await backfillRetainedGenesisQualifications({ db }, { limit });
    res.json(report);
  } catch (error) {
    console.error('[Scheduler] Genesis retention backfill error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// RETIRED (2026-07 decoupling): the Genesis first-transaction and sustained-activity
// milestone scanners are removed. Ongoing activity uses the standard mint
// path. PVT9 Genesis has three fixed-grant types (armed and admitting through
// December 31, 2026,); these legacy cron routes stay no-op so any stale schedule is harmless. The
// historical scan functions remain unit-tested but unwired. Native `wallet_created`
// semantics are unchanged.
app.post('/v1/internal/scheduler/genesis-first-tx', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ skipped: 'retired_activity_uses_standard_mint_eligibility' });
});

app.post('/v1/internal/scheduler/genesis-sustained', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ skipped: 'retired_activity_uses_standard_mint_eligibility' });
});

// RETIRED (2026-07): the nonce-delta external-outbound genesis milestone scanner
// is superseded by the outbound-usdc LOG watcher (/v1/internal/scheduler/outbound-usdc),
// which maps the same activity into standard Financial PEs AND catches the gasless
// x402 payments the nonce delta missed. Kept as a no-op so a still-scheduled cron
// is harmless and can never double-reward external activity (log path + nonce path).
// Point the Cloud Scheduler job at /outbound-usdc; this endpoint pays nothing.
app.post('/v1/internal/scheduler/genesis-external-outbound', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ skipped: 'retired_superseded_by_outbound_usdc' });
});

// Part E: genesis economic-progress feedback (next-milestone hook). Read-only
// dual-auth (human wallet auth OR agent api-key) + ownership gate, extracted to
// routes/genesis-status.ts so the security logic is unit-tested. Mounted at both
// the legacy /v1/agent/ path and a neutral /v1/ path (genesis serves humans too).
const genesisStatusRouter = createGenesisStatusRouter({
  db,
  verifyWalletAuthToken,
  authenticateAgent: authenticateAgent as unknown as GenesisStatusRouterDeps['authenticateAgent'],
  getGenesisWalletStatus: async (database, walletId) => {
    const { getGenesisWalletStatus } = await import('./core/pvt/genesis-milestones');
    return getGenesisWalletStatus(database, walletId);
  },
});
app.use('/v1/agent/genesis/status', genesisStatusRouter);
app.use('/v1/genesis/status', genesisStatusRouter);

// --- PVT9 operations: the epoch keeper and the settlement run (both scheduled,) ---
// Mounted here, alongside the other internal scheduler endpoints, and NOT under `/v1/pvt`
// (which the runtime boundary boundary blocks wholesale). Neither route builds a signer or reads a key;
// both delegate to `core/pvt/wp4/operator-runtime.ts`, the one module that does. The
// settlement run fires daily with a per-payee interval via Cloud Scheduler `provian-pvt9-settlement` (`0 12 * * *`,
// epoch-aligned, ; the Genesis lane also settles daily via
// `provian-pvt9-genesis-settlement`) and remains operator-invokable by hand.
app.use(createPvt9OperationsRouter({ db, authenticateScheduler }));
// (2026-10-04): on-demand payout — any payee settles its earnings now for a flat
// $1 USDC service fee (x402 for agents, the app wallet for people); standard earnings otherwise
// settle on a schedule Provian sets, currently every 30 days and free. Outside `/v1/pvt` (that namespace stays the read-only runtime window).
let payoutDepsMemo: PayoutDeps | null | undefined;
const lazyPayoutDeps = (): PayoutDeps | null => {
  if (payoutDepsMemo === undefined) {
    payoutDepsMemo = createPayoutDeps({
      db,
      env: process.env,
      readEthPrice: async () => {
        const feed = await walletPriceFeed.read();
        const eth = feed.prices.ETH;
        return eth === undefined ? null : { usd: eth.usd, as_of_ms: eth.as_of_ms };
      },
    });
  }
  return payoutDepsMemo;
};
app.use(createPayoutRouter({
  db,
  authenticateAgent: authenticateAgent as unknown as express.RequestHandler,
  authenticateWallet: authenticateWalletRecorder as unknown as express.RequestHandler,
  authenticateScheduler,
  publicBaseUrl: process.env.PUBLIC_API_BASE_URL || 'https://api.provian.ai',
  payoutDeps: lazyPayoutDeps,
}));
// App-store purchases: the App Store and Google Play builds sell the PE Archive GB and Settle now
// as consumable in-app purchases. The relay verifies each with its store and grants exactly what
// the USDC payment grants; an unconfirmed purchase is refused.
let storeDepsMemo: StorePurchaseDeps | undefined;
app.use(createStorePurchaseRouter({
  db,
  authenticateWallet: authenticate as unknown as express.RequestHandler,
  storeDeps: () => {
    if (storeDepsMemo === undefined) {
      storeDepsMemo = createStorePurchaseDeps({
        db,
        env: process.env,
        payout: lazyPayoutDeps,
      });
    }
    return storeDepsMemo;
  },
}));
// (2026-10-04): the paid PE Archive — opt-in per wallet, $5 USDC per GB (x402 for
// agents, the app wallet for people), one encrypted object per uploaded part in Archive-class
// storage, each written once (2026-10-07). The relay holds ciphertext and a small index only; it deletes nothing.
let archiveDepsMemo: ArchiveDeps | null | undefined;
app.use(createArchiveRouter({
  db,
  cache,
  authenticateAgent: authenticateAgent as unknown as express.RequestHandler,
  authenticateWallet: authenticate as unknown as express.RequestHandler,
  authenticateScheduler,
  publicBaseUrl: publicApiBaseUrl,
  archiveDeps: () => {
    if (archiveDepsMemo === undefined) {
      archiveDepsMemo = createArchiveDeps({
        db,
        env: process.env,
        readEthPrice: async () => {
          const feed = await walletPriceFeed.read();
          const eth = feed.prices.ETH;
          return eth === undefined ? null : { usd: eth.usd, as_of_ms: eth.as_of_ms };
        },
      });
    }
    return archiveDepsMemo;
  },
}));
app.use(createBurnFloorOperationsRouter({ db }));

// The WEEKLY export of the DURABLE collections to Archive-class storage (kept one year by bucket
// lifecycle; , : weekly, durable collections only), read at ONE PITR
// snapshot time so the export is a consistent view. PITR (7 days) covers the
// database itself; no full scheduled backups.
app.post('/v1/internal/scheduler/firestore-export', async (req: Request, res: Response) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const topLevel = (await db.listCollections()).map((c) => c.id);
    const collectionIds = durableCollectionIds(topLevel);
    const result = await startDurableExport({
      rest: createGcpRest(), projectId: resolveGcpProjectId(), databaseId: relayDatabaseId(), nowMs: Date.now(), collectionIds,
      persistManifest: async (uri, manifest) => {
        const { getStorage } = await import('firebase-admin/storage');
        const path = uri.slice(`gs://${RELAY_EXPORT_BUCKET}/`.length);
        const info = manifest as {parts?: readonly unknown[]; ok?: boolean};
        await getStorage().bucket(RELAY_EXPORT_BUCKET).file(path).save(JSON.stringify(manifest), {
          contentType: 'application/json', resumable:false, preconditionOpts:{ifGenerationMatch:0},
          ...(path.endsWith('/manifest.json') ? {metadata:{metadata:{export_parts:String(info.parts?.length ?? 0),export_accepted:String(info.ok === true)}}} : {}),
        });
      },
    });
    if (!result.ok) console.error(`[firestore-export] ALARM — export not started: ${JSON.stringify(result)}`);
    else console.log(`[firestore-export] started ${result.parts.length} operations, manifest ${result.manifestUri} -> ${result.outputUriPrefix} at snapshot ${result.snapshotTime} (${collectionIds.length} durable collection groups of ${topLevel.length} top-level)`);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    console.error('[firestore-export] ALARM — FAILED', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'firestore_export_failed' });
  }
});

app.post('/v1/internal/scheduler/pvt-mint', (_req, res) => {
  // Defense in depth behind createPvt9RuntimeBoundary: this handler carries no
  // auth, database, provider, signer, environment, or deployment authority.
  res.status(503).json({
    error: 'PVT9_UNCONFIGURED',
    code: 'PVT9_UNCONFIGURED',
    message: 'This legacy scheduler path is retired and carries no runtime; PVT9 settlement runs through the pvt9-operations path — daily with a per-payee interval via the Cloud Scheduler cron provian-pvt9-settlement (POST /v1/internal/settlement/pvt9-run, 12:00 UTC), with Genesis grants also settled daily, and operator-invokable by hand.',
  });
});

// Retained only as a stable fail-closed response for a stale scheduler target.
app.post('/v1/internal/scheduler/advance-epoch', (_req, res) => {
  res.status(503).json({
    error: 'PVT9_UNCONFIGURED',
    code: 'PVT9_UNCONFIGURED',
    message: 'This legacy scheduler path is retired; PVT9 epoch operations run only through the pvt9-operations path and the epoch keeper.',
  });
});

// POST /v1/internal/scheduler/ordinary-accrual-replay —.
//
// Finishes any mainline-path accrual whose fire-and-forget call was lost
// (process death between the chain-tip commit and the derived history write)
// from the intake row co-committed with that commit. It is the second half of
// the durable outbox: without it the row is a record nobody reads.
//
// It cannot mint, settle, reprice a sealed PE, or make an act eligible — it
// re-runs `recordPEAccrual` on the STORED payload, and every idempotency it
// relies on (create-if-absent seal, per-PE effect state machine) already ships.
app.post('/v1/internal/scheduler/ordinary-accrual-replay', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // PE METER: the legacy intake replay is retired — it re-ran `recordPEAccrual` into
    // `pe_history`, which the relay no longer keeps, and no path creates an intake any more (the
    // last unsealed one is exhausted). What remains is the meter's own half: a relay-authored act
    // whose emitter died between the tip commit and pricing left its intake staged; price it now
    // (idempotent on the act key). Bounded per run.
    const relayActs = await replayStuckRelayActs(db, { nowMs: Date.now() });
    res.json({ legacy_intake_replay: 'retired', relay_acts: relayActs });
  } catch (error) {
    console.error('[Scheduler] Ordinary accrual replay error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/pending-evidence-resolve —.
//
// Walks the PEs held at `pending_evidence` and runs the verification that
// ACTUALLY exists for each row's sealed evidence class. It can promote exactly
// one class — `base_final_chain_receipt`, verified against Base through the
// live tx-verifier with the 12-confirmation economic-finality floor — and every
// other class either records the arrival of relay-verified linked evidence or
// refuses by a named reason and leaves the row held.
//
// It cannot mint, settle, or reprice a sealed PE: the `economic_snapshot` is
// re-bound by hash before the row is touched and never rewritten, and the only
// mutation on a promotion is `mint_status` plus the projection recorded beside
// the seal. A dark runtime resolves to a refusal, never to `eligible`.
app.post('/v1/internal/scheduler/pending-evidence-resolve', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const result = await sweepPendingEvidence(
      {
        db,
        verifyChainReceipt: async ({ chainId, txHash, expectedFrom }) =>
          verifyEvmTxFrom({ chainId, txHash, expectedFrom }),
        resolveActorAddress: async (economicActorId: string) =>
          resolveMintRecipientAddress(db, economicActorId),
        // B11 : the resolver's leg of the cross-source
        // exactly-once invariant — a held row whose canonical event already
        // minted through the financial-settlement claim refuses BY NAME.
        // Claims are keyed by the LOG-GRANULAR `chainId:txHash:logIndex`
        // identity (or a bare tx), while a held pe_history row carries only a
        // `tx_hash` — so this is a QUERY over the address's claims filtered by
        // tx containment, not a doc-id get. Read-only; an address's claims are
        // few, and any match means the transaction already minted at least one
        // event through another seal.
        lookupFinancialSettlementClaimOwner: async (settlingAddress, txHash) => {
          const tx = txHash.trim().toLowerCase();
          const snap = await db.collection('financial_settlement_mint_claims')
            .where('subject_id', '==', settlingAddress.trim().toLowerCase())
            .limit(50)
            .get();
          for (const doc of snap.docs) {
            const row = doc.data() as { event_id?: unknown; owner_pe_id?: unknown };
            const eventId = typeof row.event_id === 'string' ? row.event_id : '';
            if ((eventId === tx || eventId.includes(`:${tx}:`))
              && typeof row.owner_pe_id === 'string') {
              return row.owner_pe_id;
            }
          }
          return null;
        },
      },
      { nowMs: Date.now() },
    );
    res.json(result);
  } catch (error) {
    console.error('[Scheduler] Pending-evidence resolve error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/registry-hold-resolve - registry-hold resolution.
// Re-verifies beneficiary linkage for rows the tip_pe_missing defect held at pending_review
// (linkageState 'unverifiable' + a 'registry' gate) and releases them: unlinked verbatim,
// beneficiary_linked re-priced to 2.0x + routing. Reports every row it leaves pending.
app.post('/v1/internal/scheduler/registry-hold-resolve', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { recoverComplianceHolds } = await import('./core/pvt/compliance-hold-recovery');
    const { purgeExpiredWalletLocations } = await import('./core/jurisdiction/location-retention');
    const locationExpiry = await purgeExpiredWalletLocations(db);
    const complianceHeld = await recoverComplianceHolds(db);
    const result = await sweepRegistryHolds({ db, cache }, { nowMs: Date.now() });
    // PE METER — the payee recoveries for metered held acts, beside the registry re-verification:
    // acts held `beneficiary_pending` whose committed route now resolves (the rule the retired
    // PVTv8 minting engine applied),
    // then acts held `payee_<reason>` (eligible, payee unresolved) re-resolved with a no-op patch.
    // Bounded pages from durable cursors. Pre-meter `pe_history` rows are untouched here.
    const { recoverBeneficiaryPendingHeldActs, retryHeldActPayees } = await import('./core/pvt/held-act-recovery');
    const beneficiaryPendingHeld = await recoverBeneficiaryPendingHeldActs(db, { nowMs: Date.now() });
    const payeeRetry = await retryHeldActPayees(db, { nowMs: Date.now() });
    res.json({ ...result, location_expiry: locationExpiry, compliance_held_acts: complianceHeld, beneficiary_pending_held_acts: beneficiaryPendingHeld, payee_retry: payeeRetry });
  } catch (error) {
    console.error('[Scheduler] Registry-hold resolve error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Read-only operator probe of the same resolver and policy used by accrual.
app.post('/v1/internal/scheduler/jurisdiction-check', async (req, res) => {
  if (!await authenticateScheduler(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
  const ips = [undefined, '127.0.0.1', '8.8.8.8', '175.45.176.1', '5.34.192.1', '114.114.114.114', '5.3.41.0', '5.105.215.0', '45.10.32.0'];
  const cases = await Promise.all(ips.map(async ip => {
    const location = countryFromIp(ip);
    return { input: ip ?? 'missing', ...location, policy: await getJurisdictionPolicy(location.country, location.region, db) };
  }));
  const actorId = typeof req.body?.actor_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(req.body.actor_id)
    ? req.body.actor_id : null;
  let actor: Awaited<ReturnType<typeof evaluateMintCompliance>> | null = null;
  if (actorId !== null) actor = await evaluateMintCompliance(actorId, null, db);
  res.json({ request_location: countryFromIp(req.ip), cases, actor,
    unknown_actor: await evaluateMintCompliance('jurisdiction_probe_missing_actor', null, db) });
});

// Scheduled refresh; never fetched during act submission or mint approval.
app.post('/v1/internal/scheduler/github-pr-gates', async (req, res) => {
  if (!await authenticateScheduler(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
  if (process.env.GITHUB_PR_GATE_ENABLED !== 'true') { res.status(503).json({ error: 'pr_gate_unavailable' }); return; }
  try {
    const { sweepPrGates } = await import('./core/witnesses/github-pr-gate');
    const { GitHubPrApi } = await import('./core/witnesses/github-pr-api');
    const redispatched = await redispatchGitHubWebhookInbox(agentBankDeps);
    res.json({ ...await sweepPrGates({ db, api: new GitHubPrApi() }), redispatched });
  } catch { res.status(503).json({ error: 'pr_gate_sync_pending' }); }
});

// Scheduled refresh; never fetched during act submission or mint approval.
app.post('/v1/internal/scheduler/jurisdiction-sdn-refresh', async (req, res) => {
  if (!await authenticateScheduler(req)) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try { res.json(await refreshSdn(db)); }
  catch { res.status(503).json({ error: 'sdn_refresh_failed' }); }
});

// POST /v1/internal/scheduler/deferred-release - Process deferred PE releases
// Called by Cloud Scheduler. Checks for active release configs and processes batches.
app.post('/v1/internal/scheduler/deferred-release', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // Load active release configs
    const configSnapshot = await db.collection('deferred_release_configs')
      .where('active', '==', true)
      .get();

    if (configSnapshot.empty) {
      res.json({ message: 'No active deferred release configs', total: 0 });
      return;
    }

    // Get trailing daily mint average for ceiling calculation
    const recentBatches = await db.collection('pvt_mint_batches')
      .orderBy('created_at', 'desc')
      .limit(100)
      .get();

    let trailingDailyMintAvg = 0;
    if (!recentBatches.empty) {
      const totalPEs = recentBatches.docs.reduce((sum, doc) => {
        return sum + (doc.data().pe_count || 0);
      }, 0);
      const oldestBatch = recentBatches.docs[recentBatches.docs.length - 1].data();
      const daySpan = Math.max(1, (Date.now() - oldestBatch.created_at) / (24 * 60 * 60 * 1000));
      trailingDailyMintAvg = totalPEs / daySpan;
    }

    const { processDeferredReleaseBatch } = await import('./core/pvt/deferred-release');

    let totalReleased = 0;
    for (const configDoc of configSnapshot.docs) {
      const config = configDoc.data() as {
        jurisdiction: string;
        daily_ceiling_percent: number;
        re_attestation_required: boolean;
        activated_at: number;
        active: boolean;
      };
      const released = await processDeferredReleaseBatch(config, trailingDailyMintAvg);
      totalReleased += released;
    }

    res.json({ message: `Released ${totalReleased} deferred PEs`, total: totalReleased });
  } catch (error) {
    console.error('[Scheduler] Deferred release error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/bond-renewals - Process expired bond renewals (daily)
app.post('/v1/internal/scheduler/bond-renewals', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { processBondRenewals } = await import('./core/agent-bank/scheduler');
    const count = await processBondRenewals(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] Bond renewals error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/abandoned-bonds - Process abandoned bonds (weekly)
app.post('/v1/internal/scheduler/abandoned-bonds', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { processAbandonedBonds } = await import('./core/agent-bank/scheduler');
    const count = await processAbandonedBonds(agentBankDeps);
    res.json({ processed: count });
  } catch (error) {
    console.error('[Scheduler] Abandoned bonds error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/expired-claims - Expire stale bond claims (Pass-3 #3, daily)
// For any bond claim still 'filed' past CLAIM_RESOLUTION_TIMEOUT (60d) with no Court
// panel/verdict, drive the permissionless on-chain expireStaleClaim() and mirror the
// pendingClaims decrement off the ClaimExpired log, unblocking the respondent's bond.
app.post('/v1/internal/scheduler/expired-claims', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { processStaleClaims, processFiledClaimCourtSettlements } = await import('./core/agent-bank/scheduler');
    // agent directory: FIRST mirror any on-chain Court settlements (BondSlashed /
    // ClaimDismissed recovered at Base finality) so a panel-resolved claim is
    // never mislabeled by the expiry pass, THEN expire genuinely stale claims.
    const settled = await processFiledClaimCourtSettlements(agentBankDeps);
    const count = await processStaleClaims(agentBankDeps);
    res.json({ processed: count, court_settlements_mirrored: settled });
  } catch (error) {
    console.error('[Scheduler] Stale claims error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/pending-cache-backfill - H-6 (audit 2026-05-11)
// Reclassify pe_history docs that landed in mint_status='pending_cache'
// because Redis was unavailable when they were submitted. Without this
// scheduler, an Upstash blip during launch traffic would leave a
// silent backlog of unmintable PEs forever.
app.post('/v1/internal/scheduler/pending-cache-backfill', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { backfillPendingCachePEs } = await import('./core/pvt/pending-cache-backfill');
    const result = await backfillPendingCachePEs(cache);
    res.json(result);
  } catch (error) {
    console.error('[Scheduler] pending-cache-backfill error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/pe-aggregate-drift — RETIRED by the PE meter (see the handler).
// It WAS the periodic reconciliation of the accrual-time economic aggregates (M5): walked `pe_economic_aggregates`
// from a durable cursor, `sample` identities per call (default 25, max 200),
// compares each to the paged reference fold, logs every mismatch at ERROR and
// repairs it under a version CAS (pass `repair=false` to report only). Every
// identity is reconciled on a fixed cadence whether or not anyone reads its
// dashboard; the read path additionally sanity-checks itself on every uncached
// call. Scheduler auth, like every other internal sweep.
app.post('/v1/internal/scheduler/pe-aggregate-drift', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  // PE METER (2026-10-03): RETIRED. The sweep re-folded each identity's whole `pe_history`; the
  // meter applies every act's aggregate delta once, in its batch commit, and keeps no history to
  // fold. Answers 200 so a still-enabled cron reads as a clean no-op, never as a failing job.
  res.json({
    retired: true,
    code: 'pe_aggregate_drift_retired',
    reason: 'PE meter: aggregates are applied once per fresh act in the batch commit; there is no PE history to reconcile against.',
  });
});

// POST /v1/internal/scheduler/purge-transients - delete aged transient docs so
// ephemeral collections stay bounded. Deletes relay_requests older than 30 days
// (their decisions are already sealed as PEs) plus expired connection/setup
// tokens, consumed nonces, and rate-limit windows past a 2-day grace. Prevents
// the unbounded accumulation that left 342k stale relay_requests (~1.7 GiB incl.
// auto-indexes) in Firestore. Called daily by Cloud Scheduler.
app.post('/v1/internal/scheduler/purge-transients', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { purgeTransientCollections, purgeOrphanedApiKeyIndex } = await import('./core/maintenance/purge-transients');
    const result = await purgeTransientCollections(db);
    const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
    // Referential-integrity sweep: delete api_key_index entries whose wallet_id
    // has no live agent_wallets doc (dead auth-index entries). Aborts itself if
    // the live set can't be read or is empty, so it can never nuke real keys.
    const orphans = await purgeOrphanedApiKeyIndex(db);
    console.log(
      `[Scheduler] purge-transients deleted ${total}`,
      result.deleted,
      result.capped.length ? `CAPPED: ${result.capped.join(',')}` : '',
      `| api_key_index orphans: ${orphans.aborted ? `ABORTED(${orphans.reason})` : orphans.deleted}`,
    );
    res.json({ deleted: result.deleted, total, capped: result.capped, api_key_index_orphans: orphans });
  } catch (error) {
    console.error('[Scheduler] purge-transients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// B10 (, the design requires ARM): the anchor runtime is RESTORED — these two
// handlers replaced the 503 PVT9_UNCONFIGURED stubs that stood while the
// runtime was quarantined. Anchoring runs against the DEPLOYED PEAnchor
// `0x889A59A8…` per (operational-only roles; admin stays the Foundation
// Safe; no redeploy). Signer construction is confined to
// `core/pvt/pe-anchor-runtime.ts` (declared in SANCTIONED_MINT_SIGNER_FILES).
// Unconfigured env degrades to the pre-B10 fail-closed answer.
//
// POST /v1/internal/scheduler/daily-pe-anchor — PE METER: anchors each closed day's ACCEPTED
// BATCHES (`meter-anchor.ts`, its own `meter` batch id per day). The legacy per-PE day anchor
// over pe_history is retired (the relay stores no PE history); the response says so. Idempotent
// (probes batches(batchId) on-chain before sending). Cron:
// provian-daily-pe-anchor (every five minutes; only closed days are processed).
app.post('/v1/internal/scheduler/daily-pe-anchor', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { buildPeAnchorSignerContract } = await import('./core/pvt/pe-anchor-runtime');
    const anchorContract = buildPeAnchorSignerContract(() => getChainProvider('base'));
    if (!anchorContract) {
      res.status(503).json({
        error: 'PVT9_UNCONFIGURED',
        code: 'PVT9_UNCONFIGURED',
        message: 'No current PVT anchor runtime is configured.',
      });
      return;
    }
    // PE METER : the relay stores no PE history, so the legacy per-PE day
    // anchor is RETIRED (`daily-pe-anchor.ts`). The daily run anchors every accepted batch (its own
    // `meter` batch id per day) and hands each batch its inclusion proof.
    const { LEGACY_DAILY_PE_ANCHOR_RETIRED } = await import('./core/pvt/daily-pe-anchor');
    const { runDailyMeterAnchor } = await import('./core/meter/meter-anchor');
    const meter = await runDailyMeterAnchor({ db, peAnchorContract: anchorContract });
    res.status(meter.complete ? 200 : 503).json({ legacy_pe_anchor: LEGACY_DAILY_PE_ANCHOR_RETIRED, meter });
  } catch (error) {
    console.error('[Scheduler] daily-pe-anchor error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/meter-anchor-now — anchor the OPEN day's accepted-but-unanchored batches
// NOW as the day's next SEGMENT (: a PE sealed today must be presentable today).
// Operator-run through a one-off Cloud Scheduler job under scheduler auth; never on a schedule.
// Each batch's proof carries `segment: n`; the day's close anchors only what no segment took.
app.post('/v1/internal/scheduler/meter-anchor-now', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { buildPeAnchorSignerContract } = await import('./core/pvt/pe-anchor-runtime');
    const anchorContract = buildPeAnchorSignerContract(() => getChainProvider('base'));
    if (!anchorContract) {
      res.status(503).json({ error: 'PVT9_UNCONFIGURED', code: 'PVT9_UNCONFIGURED', message: 'No current PVT anchor runtime is configured.' });
      return;
    }
    const { anchorMeterSegment } = await import('./core/meter/meter-anchor');
    res.json({ segment: await anchorMeterSegment({ db, peAnchorContract: anchorContract }) });
  } catch (error) {
    console.error('[Scheduler] meter-anchor-now error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/scheduler/pe-anchor-backfill — RETIRED by the PE meter: it WAS the bootstrap batch over every
// still-unanchored PE created through body.through_day (default: yesterday
// UTC), then hands the watermark to /daily-pe-anchor. Idempotent. Behind
// scheduler auth; used by provian-anchor-recovery-schedule and one-shot runs.
app.post('/v1/internal/scheduler/pe-anchor-backfill', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    // PE METER (2026-10-03): RETIRED with the per-PE anchor — there is no unanchored PE history
    // left to backfill (the relay stores none). Answers 200 so a still-enabled cron is a clean no-op.
    const { LEGACY_DAILY_PE_ANCHOR_RETIRED } = await import('./core/pvt/daily-pe-anchor');
    res.json({ retired: true, ...LEGACY_DAILY_PE_ANCHOR_RETIRED });
  } catch (error) {
    console.error('[Scheduler] pe-anchor-backfill error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/internal/daily-spending-digest - send spending summaries to opted-in users
// Called by Cloud Scheduler at 02:00 UTC daily (covers most users' evening)
app.post('/v1/internal/daily-spending-digest', async (req, res) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const now = Date.now();
    // UTC calendar-day key (e.g. "2026-06-26"). Used to send at most one digest
    // per user per day even if this endpoint fires more than once the same day
    // (Cloud Scheduler retry, manual re-run, or overlapping invocations).
    const todayKey = new Date(now).toISOString().slice(0, 10);

    // Query users who had PE activity in the last 24 hours
    const spendingSnap = await db.collection('pvt_accrual')
      .where('lastPETimestamp', '>', now - 86_400_000)
      .limit(500)
      .get();

    let notified = 0;
    let skipped_already_sent = 0;
    for (const doc of spendingSnap.docs) {
      const userId = doc.id;

      // Check if user has digest opted in (stored in user preferences)
      const prefDoc = await db.collection('user_preferences').doc(userId).get();
      if (!prefDoc.exists) continue;
      const prefs = prefDoc.data();
      if (!prefs?.notifications?.dailySpendingDigest) continue;

      // Get push tokens from user doc
      const userDoc = await db.collection('users').doc(userId).get();
      if (!userDoc.exists) continue;
      const user = userDoc.data() as User;
      const tokens = user.fcm_tokens?.filter(Boolean) || [];
      if (tokens.length === 0) continue;

      // Idempotency claim: transactionally record that today's digest was sent
      // to this user, and only send if THIS run won the claim. Makes the digest
      // at-most-once per user per UTC day, so a re-run or overlapping invocation
      // can't double-send. Checked after the opt-in/token gates so a user who
      // opts in later the same day still gets that day's digest.
      const markerRef = db.collection('daily_digest_sends').doc(userId);
      let claimed = false;
      await db.runTransaction(async (tx) => {
        const marker = await tx.get(markerRef);
        if (marker.exists && marker.data()?.last_sent_date === todayKey) return;
        tx.set(markerRef, { last_sent_date: todayKey, last_sent_at: now }, { merge: true });
        claimed = true;
      });
      if (!claimed) {
        skipped_already_sent++;
        continue;
      }

      try {
        const result = await sendPush(tokens, {
          tokenLanguages: userDoc.data()?.push_languages,
          title: 'Agent Activity Today',
          body: 'Tap to see what your agent did today.',
          data: {
            type: 'daily_spending_digest',
            userId,
          },
        });
        await pruneUserTokens(db, userId, result.invalidTokens);
        notified++;
      } catch (pushErr) {
        console.error('[DailyDigest] Push error for user:', userId, pushErr);
      }
    }

    res.json({ notified, skipped_already_sent });
  } catch (error) {
    console.error('[DailyDigest] error:', error);
    res.status(500).json({ error: 'Failed to send digests' });
  }
});

/**
 * POST /v1/internal/admin/test-push
 * Dev/admin-only smoke test: dispatch a real push to a wallet's registered
 * tokens so we can verify relay -> phone delivery (Expo AND native FCM) on a
 * physical device before the C4/#1 device gates run.
 *
 * Auth: scheduler auth (Cloud Scheduler OIDC service account OR the
 * `x-scheduler-secret` shared secret) - same gate as the internal scheduler
 * endpoints; not reachable by wallet or agent-session auth.
 *
 * Body: { target_user_id?, wallet_address?, title?, body? } - one of
 * target_user_id / wallet_address is required. NOTE the field is
 * `target_user_id`, NOT `user_id`: the global anti-spoofing middleware strips
 * `user_id`/`wallet_id`/`actor_address` from every request body, so a `user_id`
 * field would silently arrive undefined. The response NEVER contains full
 * tokens: only a short prefix + derived type per token, plus routing counts.
 */
app.post('/v1/internal/admin/test-push', async (req: Request, res: Response) => {
  if (!await authenticateScheduler(req)) {
    res.status(403).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const { target_user_id, wallet_address, title, body } = req.body || {};

    // Resolve the target user by target_user_id, else by (lowercased) wallet_address.
    let userId: string | undefined = (typeof target_user_id === 'string' && target_user_id) ? target_user_id : undefined;
    if (!userId && typeof wallet_address === 'string' && wallet_address) {
      const snap = await db.collection('users')
        .where('wallet_address', '==', wallet_address.toLowerCase())
        .limit(1).get();
      if (!snap.empty) userId = snap.docs[0].id;
    }
    if (!userId) {
      return res.status(400).json({ error: 'target_user_id or wallet_address required (no matching user found)' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const tokens = ((userDoc.data() as User).fcm_tokens || []).filter(Boolean);
    if (tokens.length === 0) {
      return res.status(200).json({ user_id: userId, tokens: [], routed: { expo: 0, fcm: 0 }, message: 'User has no registered push tokens' });
    }

    const result = await sendPush(tokens, {
      tokenLanguages: userDoc.data()?.push_languages,
      title: (typeof title === 'string' && title) ? title : 'Provian test push',
      body: (typeof body === 'string' && body) ? body : 'If you can read this, relay → phone push works.',
      data: { type: 'test_push', sent_at: String(Date.now()) },
      priority: 'high',
    });
    await pruneUserTokens(db, userId, result.invalidTokens);

    res.json({
      user_id: userId,
      routed: { expo: result.expoCount, fcm: result.fcmCount },
      success: result.successCount,
      failure: result.failureCount,
      pruned: result.invalidTokens.length,
      // prefix + type only - never leak a full push token
      tokens: tokens.map((t) => ({ prefix: tokenPrefix(t), type: classifyToken(t) })),
    });
  } catch (error) {
    console.error('[test-push] error:', error);
    res.status(500).json({ error: 'Failed to send test push' });
  }
});

// =============================================================================
// CHAT - REST ENDPOINTS
// =============================================================================


// =============================================================================
// HEALTH CHECK
// =============================================================================

// Public health endpoint: minimal payload so traffic shape and cache state
// are not exposed to unauthenticated callers (L-3). Detailed state is on
// /v1/admin/health behind x-admin-secret.
app.get('/v1/admin/health', (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  // Product health accepts the configured primary admin credential.
  if (!safeSecretCompare(adminSecret, process.env.ADMIN_API_KEY || process.env.AGENT_BANK_ADMIN_SECRET)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    cache: {
      enabled: cache.isEnabled(),
      stats: cache.getStats(),
    },
    pe_buffer: peBuffer.getStats(),
    email: { disabled: EMAIL_DISABLED },
    pvt_policy: {
      classification_writes_enabled:
        process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED === 'true'
        || process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED === '1',
    },
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const PORT = process.env.PORT || 8080;

// =============================================================================
// STARTUP VALIDATION: Env vars that cause silent failures if missing
// =============================================================================

function validateRequiredEnv(): void {
  const REQUIRED_SECRETS: Record<string, string> = {
    TOKEN_SIGNING_SECRET: 'HMAC token signing - random fallback would wipe sessions on every cold start',
    SCHEDULER_SECRET: 'Scheduler endpoint auth - cron jobs silently fail without it',
    SESSION_SECRET: 'Passkey session HMAC signing - insecure default exposes passkey session tokens',
    // B-3 (audit 2026-05-11): conformance badge HMAC signing key.
    // Previously fell back to a hardcoded literal in conformance.ts,
    // making badges forgeable.
    RELAY_SIGNING_KEY: 'Conformance badge HMAC signing - hardcoded fallback would make badges forgeable',
    // Audit 2026-08-05 (finding 8): AgentBank admin auth secret. Without it every
    // x-admin-secret route (escrow dispute-resolve, /v1/admin/health, court panel-assign)
    // is silently 401-dead. Fail closed at boot so a deploy that forgets it is loud, not silent.
    AGENT_BANK_ADMIN_SECRET: 'AgentBank admin auth - missing value leaves dispute-resolve and admin/health permanently 401',
    // H-2 (audit 2026-05-11): iOS App Attest verification env vars.
    // node-app-attest accepts attestations from any iOS team or bundle
    // when these are undefined, weakening the hardware tier gate.
    IOS_BUNDLE_ID: 'iOS App Attest bundle binding - missing value lets any iOS bundle claim hardware tier',
    IOS_TEAM_IDENTIFIER: 'iOS App Attest team binding - missing value lets any iOS team claim hardware tier',
    // H-3 (audit 2026-05-11): chain RPC primary endpoints.
    // Previously fell back to public RPCs silently when env unset; on a
    // misconfigured deploy that meant rate-limited public RPCs serving
    // chain verification and non-PVT wallet queries with no signal.
    BASE_RPC_URL: 'Base RPC primary - public-only fallback silently throttles chain verification and non-PVT wallet queries',
    ARBITRUM_RPC_URL: 'Arbitrum RPC primary - same hazard as BASE_RPC_URL on Arb',
    OPTIMISM_RPC_URL: 'Optimism RPC primary - same hazard as BASE_RPC_URL on Op',
  };

  const missing: string[] = [];
  for (const [envVar, reason] of Object.entries(REQUIRED_SECRETS)) {
    if (!process.env[envVar]) {
      missing.push(`  - ${envVar}: ${reason}`);
    }
  }

  if (missing.length === 0) {
    try {
      validateVerifierProviderIdentities();
    } catch (error) {
      missing.push(
        `  - RPC operator binding: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // finding (a): refuse to boot a relay that would route live value to an
  // exposed key. Reports `vacuous` distinctly — a check that evaluated zero
  // recipients has proven nothing and must not read as a pass.
  try {
    const audit = assertNoExposedKeyAsLiveValueRecipient(process.env);
    if (audit.status === 'vacuous') {
      console.error(
        '[live-value-recipients] VACUOUS: no live-value recipient var is set ' +
        `(checked ${LIVE_VALUE_RECIPIENT_VARS.join(', ')}). The guard proved nothing. ` +
        'Agent swap quoting is closed until SWAP_FEE_RECIPIENT is configured.',
      );
    } else {
      console.log(
        `[live-value-recipients] ok — ${audit.evaluated} recipient(s) checked, none forbidden.`,
      );
    }
  } catch (error) {
    missing.push(`  - live-value recipient: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (missing.length > 0) {
    console.error(
      `\n[FATAL] Missing required env vars (${missing.length}):\n${missing.join('\n')}\n` +
      `\nSet these in Cloud Run environment variables. Refusing to start.\n`
    );
    process.exit(1);
  }
}

// PROVIAN_BOOT_CHECK skips env validation (incl. the RPC-operator and live-value
// guards): the boot check proves module eval + mount wiring, not env completeness.
if (process.env.PROVIAN_BOOT_CHECK !== '1') validateRequiredEnv();
validateEmailConfig();

// L-6: Email is non-critical; absence of RESEND_API_KEY does not crash the
// server but emails silently fail. Surface the state at startup as ERROR
// (not warn) so it shows up in alerts, and expose via /v1/admin/health.
const EMAIL_DISABLED = !process.env.RESEND_API_KEY;
if (EMAIL_DISABLED) {
  console.error('[Startup] ERROR: RESEND_API_KEY not set. Email sending is disabled.');
}

// Redis configuration warning. General API rate limits fall open under a
// Redis outage; security-critical limits (recover, bond claims, bond posts)
// fail closed via cache.checkRateLimitStrict and return 503 when Redis is
// unconfigured or unreachable.
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn(
    '[Startup] WARNING: Redis not configured. Security-critical rate limits ' +
    'will fail closed; general rate limits will fail open.',
  );
}

// runtime boundary startup truth: neither PVT principal nor its dependent institutions can
// be activated by an environment flag. The imported compatibility seam is
// canonical and always disabled until a later approved PVT9 work package.
import {
  loadPvtPrincipalConfig,
  logEnabledCurrenciesPerChain,
} from './core/agent-bank/pvt-principal-config';
logEnabledCurrenciesPerChain(loadPvtPrincipalConfig());

// BOOT CHECK (CI guardrail). A module-eval crash — e.g. the interleaved-import
// temporal-dead-zone that boot-crashed the harness-catalog mount (bc298908c) — is
// invisible to `tsc --noEmit` and to unit tests (which import routers directly). It
// surfaces ONLY by evaluating this module: every `app.use(factory(...))` above has
// now run, so any TDZ has already thrown. Under PROVIAN_BOOT_CHECK we exit 0 right
// here — proving the module fully evaluates — WITHOUT binding the port or running
// the async startup guards below (which need Firestore/credentials). The nightly CI
// runs `PROVIAN_BOOT_CHECK=1 node dist/server.js` and asserts exit 0.
if (process.env.PROVIAN_BOOT_CHECK === '1') {
  console.log('[boot-check] module evaluation completed without error');
  process.exit(0);
}

const probeServer = probeApp.listen(9091);
const server = app.listen(PORT, () => {
  console.log(`Provian API running on port ${PORT}`);
  void finishStartup();
});
server.headersTimeout = 30_000;
server.requestTimeout = BODY_DEADLINE_MS;

// The HTTP startup probe keeps startup CPU available until network work has
// finished. Serving a TCP-ready port first used to strand this work under idle
// CPU throttling for minutes. No startup network task outlives startup success.
async function finishStartup(): Promise<void> {
  try {
  await publishRuntimeReadModel(db).catch((error: unknown) => console.error('[runtime-read-model] startup failed', error));

  // H4: refuse to serve a public launch that would shred in-window Genesis grants.
  // Blocks (exits) if PUBLIC_LAUNCH is open while the Genesis window is armed but
  // grant persistence is not live (activation doc absent/invalid/killed). No-op
  // when PUBLIC_LAUNCH=false. Fail-closed: any error under PUBLIC_LAUNCH=true exits.
  await enforceGenesisLaunchSequenceAtStartup(db, PUBLIC_LAUNCH).catch((err) => {
    console.error(
      '[startup] FATAL: Genesis launch-sequence guard blocked startup:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });

  // The Genesis persistence dependency, alarmed. Runs on EVERY boot regardless
  // of PUBLIC_LAUNCH — the guard above returns immediately when launch is
  // closed, which is exactly the state production is in, so until now nothing
  // checked whether the armed window still had a working approval env behind
  // it. Alarms rather than refusing boot (a missing Genesis key must not take
  // the whole relay down), and writes system_status/genesis_persistence so the
  // live state is readable without log-diving. Never throws.
  await import('./core/pvt/genesis-persistence-alarm')
    .then(({ reportGenesisPersistenceAtStartup }) => import('./core/pvt/genesis-award-state-machine')
      .then(({ isGenesisGrantPersistenceLive }) => reportGenesisPersistenceAtStartup(
        db,
        () => isGenesisGrantPersistenceLive(db),
      )))
    .catch((err) => {
      console.error('[genesis-persistence] alarm reporter failed to run:', err);
    });

  // The MONETARY activation document, alarmed on the same terms.
  //
  // could prove the deployed IMAGE contains the rail and that the rail
  // admits the live document, but not that the relay PROCESS performs the read:
  // before the 2026-08-03 floor the only production trigger (a PE record)
  // returns record-only whether the document is valid or absent, so "armed" and
  // "silently disarmed" look identical from outside. This line is that missing
  // observation — only a running relay that actually read Firestore and ran the
  // real validator can emit it. It also names the exact failure that killed the
  // signed Genesis document for ~22 hours: an action-policy row moving the
  // template digest out from under a pinned, signed activation. Never throws.
  await import('./core/pvt/policy/monetary-activation-status')
    .then(({ reportMonetaryActivationAtStartup }) => reportMonetaryActivationAtStartup(db))
    .catch((err) => {
      console.error('[monetary-activation] status reporter failed to run:', err);
    });

  // Seed the PE type catalog with first-party ActionType values (permissionless PE
  // creation). Idempotent: skips types already seeded. Complete before ready.
  await seedCatalog().then(({ seeded, skipped }) => {
    console.log(`[PETypeCatalog] Seed complete: ${seeded} new, ${skipped} existing`);
  }).catch((err) => {
    console.error('[PETypeCatalog] Seed failed:', err);
  });

  // Start the periodic flush timer for batched observation counts.
  startCatalogFlushTimer();
  if (!await instanceHealth.check()) throw new Error('firestore_startup_unavailable');
  instanceHealth.started = true;
  console.log('[startup] network initialization complete');
  } catch (error) {
    console.error('[startup] initialization failed', error);
    process.exit(1);
  }
}

// Attach WebSocket server for V1 secure text chat


// Graceful shutdown: flush buffered PEs before exit
async function gracefulShutdown(signal: string): Promise<void> {
  probeServer.close();
  console.log(`[${signal}] Graceful shutdown - draining PE buffer...`);
  try {
    const flushed = await drainPEBatchWriter();
    console.log(`[${signal}] Drained ${flushed} buffered PEs`);
  } catch (err) {
    console.error(`[${signal}] Drain error:`, err);
  }
  server.close(() => {
    console.log(`[${signal}] Server closed`);
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// F1/F62: last-line-of-defense against an unhandled promise rejection taking the
// whole Cloud Run instance down. Node's default (`--unhandled-rejections=throw`)
// EXITS on an uncaught rejection; `node dist/server.js` runs with no override, so
// a single async handler that rejects (e.g. a synchronous Firestore `.doc()`
// throw on a caller-supplied '/', or any un-awaited promise that later rejects)
// would drop every in-flight request on that instance — including a settlement
// cycle. The extracted auth middlewares and safeSecretCompare are individually
// hardened to never reject on caller input; this handler catches anything they
// miss so a header can never crash the process. Log + keep serving (do NOT
// exit): a rejection is a bug to fix, not a reason to drop live traffic. An
// uncaughtException (a synchronous throw with no handler) is genuinely unsafe to
// continue past, so that one is left to Node's default fatal behaviour.
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection] Kept the instance alive; investigate:', reason);
});

export default app;
