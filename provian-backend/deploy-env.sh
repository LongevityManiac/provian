#!/bin/bash
# =============================================================================
# deploy-env.sh - Deploy provian-api to Cloud Run
#
# Reads deploy-time config from .env.deploy, validates required non-secret vars,
# preserves managed secrets as Cloud Run Secret Manager references, and deploys
# from source.
#
# Usage:
#   1. cp .env.deploy.example .env.deploy
#   2. Fill in your values
#   3. bash deploy-env.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.deploy"
SERVICE="provian-api"
REGION="us-central1"
PROJECT="provian-ai"

echo ""
echo "=== Provian API - Cloud Run Deploy ==="
echo ""

# --- Deploy-stamp guard  — HARD stop, BEFORE any gcloud call ---
# This script builds + deploys from source but does NOT stamp the tree; a direct run
# therefore ships a NULL-stamped image, which the standard-lane reconciliation gate refuses
# as `runtime_tree_unstamped` and the lane then HOLDS its backlog SILENTLY until the next
# daily settlement pages it (the OP-1 incident of 2026-09-15). The sanctioned path is
# `scripts/deploy-api-gated.ts`, which stamps + re-publishes the reconciliation report at the
# deployed commit before calling this script (so this guard admits on that path). Fail fast
# here, before touching Cloud Run, instead of holding for hours. Decision lives in TS
# (`deploy-gate-ordering.ts::judgeDeployStampReady`), tested with RED controls.
echo "Verifying deploy tree stamp..."
if ! npx tsx "$SCRIPT_DIR/scripts/require-tree-stamp.ts"; then
    echo ""
    echo "DEPLOY BLOCKED: this image would ship without a matching tree stamp (see above)."
    echo "  Deploy via the gated flow:  npx ts-node scripts/deploy-api-gated.ts --execute"
    echo "  Override deliberately with:  PROVIAN_ALLOW_UNSTAMPED_DEPLOY=1 bash deploy-env.sh"
    exit 1
fi

# --- Secret Manager managed vars ---
# These must never be supplied as plaintext values in .env.deploy. 1Password is
# the human-controlled source of truth; GCP Secret Manager is the runtime source.
MANAGED_SECRET_KEYS=(
    GITHUB_APP_PRIVATE_KEY
    SCHEDULER_SECRET
    BASE_RPC_URL_SECONDARY
    BASE_TRACE_RPC_URL_SECONDARY
    PVT_MINTER_KEY
    PVT9_SETTLEMENT_MINTER_KEY
    PVT9_SETTLEMENT_APPROVER_KEY
    TOKEN_SIGNING_SECRET
    SESSION_SECRET
    ADMIN_API_KEY
    # Audit 2026-08-05 (finding 8): the AgentBank admin auth secret. Without it every
    # x-admin-secret route (dispute-resolve, /v1/admin/health, court panel-assign) is
    # permanently 401. Provision in Secret Manager as `agent-bank-admin-secret`.
    AGENT_BANK_ADMIN_SECRET
    # Audit 2026-08-05 (finding 17): HMAC key for one-click unsubscribe tokens. Mounted so the
    # marketing invites can carry a working unsubscribe link. NOT boot-required — the server boots
    # without it, but fail-closed: while unset, invite emails are skipped (no invite before a working
    # unsubscribe). Provision in Secret Manager as `unsubscribe-token-secret`.
    UNSUBSCRIBE_TOKEN_SECRET
    RELAY_SIGNING_KEY
    RESEND_API_KEY
    UPSTASH_REDIS_REST_TOKEN
    ESCROW_RELEASE_KEY
    POOL_KEEPER_KEY
    BOND_KEEPER_KEY
    COINBASE_CDP_API_PRIVATE_KEY
    ETHERSCAN_API_KEY
    BASESCAN_API_KEY
    ARBISCAN_API_KEY
    OPTIMISM_ETHERSCAN_API_KEY
    SOLSCAN_API_KEY
    # 2026-09-25 swap-fee run: LI.FI partner API key for the relay-built cross-chain quote
    # (integrator `provian`, 25 bps). Provisioned in Secret Manager as `lifi-api-key` from
    # the operator’s 1Password item "li.fi API Key". While unset the LI.FI proxy fails closed (503).
    LIFI_API_KEY
    # (2026-10-04): the on-demand payout's Base gas key (EOA 0x35F96e1A…4351). It pays
    # gas for USDC transferWithAuthorization (payer → revenue wallet) and nothing else; it holds no
    # USDC and can move only its own ETH. Its own EOA so it never races the minter or the
    # facilitator service for a nonce. Generated straight into Secret Manager, never printed.
    PAYOUT_BASE_GAS_KEY
    # (2026-10-04): the shared secret Provian's x402 facilitator presents on
    # POST /v1/internal/x402/facilitator-settlement. While unset the route answers 503 (fail closed).
    FACILITATOR_RELAY_SECRET
    # The store receipt verifiers' private keys: the App Store Connect API key (.p8 PEM text) and
    # the Google Play service account's JSON key. A secret whose value is not a readable key leaves
    # that store unconfigured, and every purchase from it is refused (fail closed). The key and
    # issuer IDs are plain config in .env.deploy (APP_STORE_CONNECT_KEY_ID / _ISSUER_ID).
    APP_STORE_CONNECT_PRIVATE_KEY
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
)

managed_secret_name() {
    case "$1" in
        GITHUB_APP_PRIVATE_KEY) echo "github-app-private-key" ;;
        SCHEDULER_SECRET) echo "scheduler-secret" ;;
        BASE_RPC_URL_SECONDARY|BASE_TRACE_RPC_URL_SECONDARY) echo "base-rpc-url-secondary" ;;
        AGENT_BANK_ADMIN_SECRET) echo "agent-bank-admin-secret" ;;
        UNSUBSCRIBE_TOKEN_SECRET) echo "unsubscribe-token-secret" ;;
        PVT_MINTER_KEY) echo "pvt-minter-key" ;;
        # M7: the settlement path's two signers. The MINTER is the SAME secret as
        # PVT_MINTER_KEY — one EOA, appointed on-chain as `operationalMinter` — carried
        # under a distinct env name so `mint-capability-guard`'s sweep and the containment
        # posture stay legible: `PVT_MINTER_KEY` is still signer-free everywhere it appears.
        PVT9_SETTLEMENT_MINTER_KEY) echo "pvt-minter-key" ;;
        PVT9_SETTLEMENT_APPROVER_KEY) echo "pvt9-batch-approver-key" ;;
        TOKEN_SIGNING_SECRET) echo "token-signing-secret" ;;
        SESSION_SECRET) echo "session-secret" ;;
        ADMIN_API_KEY) echo "admin-api-key" ;;
        RELAY_SIGNING_KEY) echo "relay-signing-key" ;;
        RESEND_API_KEY) echo "resend-api-key" ;;
        UPSTASH_REDIS_REST_TOKEN) echo "upstash-redis-rest-token" ;;
        ESCROW_RELEASE_KEY) echo "escrow-release-key" ;;
        POOL_KEEPER_KEY) echo "pool-keeper-key" ;;
        BOND_KEEPER_KEY) echo "bond-keeper-key" ;;
        COINBASE_CDP_API_PRIVATE_KEY) echo "coinbase-cdp-api-private-key" ;;
        ETHERSCAN_API_KEY) echo "etherscan-api-key" ;;
        BASESCAN_API_KEY) echo "basescan-api-key" ;;
        ARBISCAN_API_KEY) echo "arbiscan-api-key" ;;
        OPTIMISM_ETHERSCAN_API_KEY) echo "optimism-etherscan-api-key" ;;
        SOLSCAN_API_KEY) echo "solscan-api-key" ;;
        LIFI_API_KEY) echo "lifi-api-key" ;;
        PAYOUT_BASE_GAS_KEY) echo "payout-base-gas-key" ;;
        FACILITATOR_RELAY_SECRET) echo "facilitator-relay-secret" ;;
        APP_STORE_CONNECT_PRIVATE_KEY) echo "app-store-connect-private-key" ;;
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) echo "google-play-service-account-json" ;;
        *) return 1 ;;
    esac
}

is_managed_secret_key() {
    managed_secret_name "$1" >/dev/null 2>&1
}

# --- Load .env.deploy ---
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found."
    echo "Copy .env.deploy.example to .env.deploy and fill in deploy config."
    exit 1
fi

# Refuse plaintext values for managed secrets before sourcing the file.
PLAINTEXT_MANAGED=()
while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    key="${key//[[:space:]]/}"

    if is_managed_secret_key "$key" && [ -n "$value" ]; then
        PLAINTEXT_MANAGED+=("  - $key")
    fi
done < "$ENV_FILE"

if [ ${#PLAINTEXT_MANAGED[@]} -gt 0 ]; then
    echo "ERROR: .env.deploy contains plaintext values for Secret Manager managed vars:"
    printf '%s\n' "${PLAINTEXT_MANAGED[@]}"
    echo ""
    echo "Remove these values from .env.deploy. Cloud Run will receive them via --update-secrets."
    exit 1
fi

set -a
source "$ENV_FILE"
set +a

# --- Validate hard-required non-secret/config vars ---
HARD_REQUIRED=(
    IOS_BUNDLE_ID
    IOS_TEAM_IDENTIFIER
    BASE_RPC_URL
    ARBITRUM_RPC_URL
    OPTIMISM_RPC_URL
)

MISSING=()
for var in "${HARD_REQUIRED[@]}"; do
    if [ -z "${!var:-}" ]; then
        MISSING+=("  - $var")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ERROR: Missing required vars in .env.deploy:"
    printf '%s\n' "${MISSING[@]}"
    echo ""
    echo "The server will refuse to start without these non-secret config values. See .env.deploy.example."
    exit 1
fi

# --- Validate Secret Manager runtime dependencies exist ---
MISSING_SECRETS=()
for key in "${MANAGED_SECRET_KEYS[@]}"; do
    secret_name="$(managed_secret_name "$key")"
    if ! gcloud secrets describe "$secret_name" --project="$PROJECT" >/dev/null 2>&1; then
        MISSING_SECRETS+=("  - $key -> $secret_name")
    fi
done

if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
    echo "ERROR: Missing GCP Secret Manager secrets:"
    printf '%s\n' "${MISSING_SECRETS[@]}"
    exit 1
fi

# --- Build env var string from all non-empty non-managed vars in .env.deploy ---
# gcloud's default --update-env-vars parser splits key=value pairs on commas, so
# any value that itself contains a comma (e.g. CLOUD_RUN_SERVICE_URL holds a
# comma-separated URL list) would be mis-parsed and abort the deploy. We use
# gcloud's custom-delimiter escaping (`^DELIM^pair DELIM pair ...`) so pairs are
# split on a char that never appears in our values, leaving commas intact inside
# values. See `gcloud topic escaping`. We keep --update-env-vars (additive merge)
# rather than --env-vars-file (which would replace the whole env var set and drop
# any var not present in .env.deploy).
ENV_DELIM='|'
ENV_PAIRS=""
while IFS= read -r line; do
    # Skip comments and blank lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    key="${key//[[:space:]]/}"
    is_managed_secret_key "$key" && continue

    # Use the shell value loaded from .env.deploy.
    value="${!key:-}"
    [ -z "$value" ] && continue

    # The custom delimiter must not appear in any value, or gcloud would split a
    # value mid-string. Fail loudly so the delimiter can be changed deliberately.
    if [[ "$value" == *"$ENV_DELIM"* ]]; then
        echo "ERROR: value of $key contains the env-var delimiter '$ENV_DELIM'."
        echo " Change ENV_DELIM in deploy-env.sh to a character absent from all values."
        exit 1
    fi

    [ -n "$ENV_PAIRS" ] && ENV_PAIRS="${ENV_PAIRS}${ENV_DELIM}"
    ENV_PAIRS="${ENV_PAIRS}${key}=${value}"
done < "$ENV_FILE"

# --- Build Secret Manager mapping for managed vars ---
SECRET_PAIRS=""
for key in "${MANAGED_SECRET_KEYS[@]}"; do
    secret_name="$(managed_secret_name "$key")"
    [ -n "$SECRET_PAIRS" ] && SECRET_PAIRS="$SECRET_PAIRS,"
    SECRET_PAIRS="${SECRET_PAIRS}${key}=${secret_name}:latest"
done

# --- Set env vars and secret refs on Cloud Run ---
echo "Setting environment variables and Secret Manager refs on $SERVICE..."
UPDATE_ARGS=(
    run services update "$SERVICE"
    --region="$REGION"
    --project="$PROJECT"
    --update-secrets="$SECRET_PAIRS"
    --quiet
)

if [ -n "$ENV_PAIRS" ]; then
    # ^DELIM^ prefix tells gcloud to split pairs on ENV_DELIM, not commas, so
    # comma-bearing values (e.g. CLOUD_RUN_SERVICE_URL) survive intact.
    UPDATE_ARGS+=(--update-env-vars="^${ENV_DELIM}^${ENV_PAIRS}")
fi

gcloud "${UPDATE_ARGS[@]}"

# --- Scheduler reconcile gate — HARD stop ---
# The class fix for //a scheduler endpoint that shipped without
# its Cloud Scheduler job (or a job left pointing at a retired endpoint) froze
# silently while looking healthy. `scheduler-jobs.json` is the source of truth;
# this reconciles it against source AND live gcloud state and BLOCKS the deploy on
# a mismatch. Runs before the (slower) index sync + code deploy so it fails fast.
echo ""
echo "Reconciling Cloud Scheduler jobs against scheduler-jobs.json..."
if ! npx tsx "$SCRIPT_DIR/scripts/reconcile-scheduler.ts"; then
    echo ""
    echo "DEPLOY BLOCKED: scheduler reconcile failed (see above)."
    echo " Create/enable the missing job (mirror the USDC/institution siblings), pause a job"
    echo " on a retired endpoint, or update scheduler-jobs.json if the change is intended."
    exit 1
fi

# --- Sync Firestore composite indexes (source of truth = firestore.indexes.json) ---
# Runs BEFORE the code deploy so any new query's index is already building when
# the new revision goes live. Idempotent + additive (never deletes); a no-op
# when live already matches the file. Uses the gcloud auth already established
# above (firebase CLI is not required). A failure here is a loud warning, not a
# hard stop - a missing index degrades a feature, but we never block a code
# deploy on it (a transient gcloud hiccup must not wedge a deploy). This is the
# guard against the index drift that 503'd /v1/pvt/accrual ("Couldn't load your
# record"). NOTE : this sync only reconciles DECLARED -> LIVE; it does NOT
# verify that the index a QUERY needs is declared, or in the right DIRECTION (the
# / escrow/promise/bond 500s passed this sync while 500ing in prod). The
# code->declared enforcement is a separate HARD gate run before flip:
# `npm run verify-launch-indexes` (FLIP_RUNBOOK Step 2.6), which EXECUTES each
# launch-path query shape against live Firestore. Keep this step soft; block there.
echo ""
echo "Syncing Firestore indexes..."
if ! node "$SCRIPT_DIR/deploy-firestore-indexes.js"; then
    echo ""
    echo "WARNING: Firestore index sync reported a problem (continuing with code deploy)."
    echo "         Check output above; some queries may 503 until their index is created."
    echo ""
fi

echo ""
echo "Deploying from source (this takes 2-3 minutes)..."
echo ""

# --- Deploy from source ---
cd "$SCRIPT_DIR"
gcloud run deploy "$SERVICE" \
    --source . \
    --region="$REGION" \
    --project="$PROJECT" \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=50 \
    --cpu=1 \
    --cpu-throttling \
    --no-session-affinity \
    --memory=2Gi \
    --concurrency=40 \
    --startup-probe='httpGet.path=/startup,httpGet.port=9091,periodSeconds=5,timeoutSeconds=4,failureThreshold=48' \
    --liveness-probe='httpGet.path=/health,httpGet.port=9091,periodSeconds=30,timeoutSeconds=5,failureThreshold=3' \
    --timeout=1260
# Complete block/trace reads need response-buffer headroom beside the bounded
# Node heap. The production image pins old-space to 512 MiB; native and temporary
# JSON buffers use the remaining memory. Min instances 0 keeps idle capacity at zero.
# The application exits ordinary requests at 180s and scheduled handlers at
# 1200s, before the platform's 1260s disconnect-only timeout. This covers recent
# scheduled work (observed maximum 872s), rather than the settlement runner's larger theoretical
# phase budgets. A crash resumes from existing durable outboxes and nonce records.
# Health probes do bounded reads; they neither require always-allocated CPU nor
# keep an instance alive. Min instances remains zero. No idle keepalive calls.


# --- Post-deploy verification : the deploy is not done because
# gcloud said a word. Two revisions can share one image digest, and a revision
# that fails its startup probe leaves traffic on the PREVIOUS image while the
# command above still prints a service URL. So read the service back and refuse
# to call it complete unless the revision serving traffic IS the newest ready
# revision AND the newest created one. Prints the digest so the operator can
# compare it to the previous deploy rather than trusting a revision name.
echo ""
echo "Verifying the deploy actually took..."
read -r SERVING READY CREATED <<< "$(gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT" \
    --format='value(status.traffic[0].revisionName,status.latestReadyRevisionName,status.latestCreatedRevisionName)')"
DIGEST="$(gcloud run revisions describe "$SERVING" --region="$REGION" --project="$PROJECT" \
    --format='value(status.imageDigest)' 2>/dev/null || echo 'unknown')"
echo "  serving        : $SERVING"
echo "  latest ready   : $READY"
echo "  latest created : $CREATED"
echo "  image digest   : $DIGEST"
if [ "$SERVING" != "$READY" ] || [ "$READY" != "$CREATED" ]; then
    echo ""
    echo "DEPLOY DID NOT TAKE: traffic is NOT on the revision this run created."
    echo "  The newest revision most likely failed its startup probe, which leaves"
    echo "  production on the OLD image. Read its logs before retrying:"
    echo "    gcloud run revisions logs read $CREATED --region=$REGION --project=$PROJECT --limit=50"
    exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Verify:"
echo "  curl -s https://api.provian.ai/health"
echo "  gcloud run services logs read $SERVICE --region=$REGION --project=$PROJECT --limit=10"
echo ""
