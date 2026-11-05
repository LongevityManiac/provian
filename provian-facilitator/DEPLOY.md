# provian-x402-facilitator — deploy

Provian's x402 facilitator (verify + settle) on Base and Solana, built on x402's open-source code
(`@x402/core`, `@x402/evm`, `@x402/svm` 2.28.0, Apache-2.0). Its own Cloud Run service, so a relay
outage never stops a seller's payment (witness reports wait for `/internal/witness-retry`).

Nothing here is run by the build. Every step below is for the deploying session. Never `set -x`
while a key or secret is in a shell variable, and never echo one.

## What it is

| | Base (`eip155:8453`) | Solana (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) |
|---|---|---|
| Who pays whom | buyer → seller directly (EIP-3009 USDC, or PVT through x402's Permit2 proxy) | buyer → seller directly (SPL `transferChecked`, USDC) |
| Fee | actual gas (gas limit × max fee per gas + OP-stack L1 data fee, at Chainlink ETH/USD, rounded up) + $0.0003 | the transaction's own gas (5,000 lamports × signatures + compute-unit limit × price, at Pyth SOL/USD, rounded up) + $0.0003 |
| Fee paid by | the SELLER, pulled by `ProvianX402FeeSettler` from the seller's own one-time USDC approval, in the same transaction as the payment | the BUYER, as one extra `transferChecked` in the buyer's own transaction (`extra.provianFee`) |
| Never submitted when | seller allowance/balance short, simulation of the exact call fails, fee > $0.05 cap, fee ≥ payment, stale price, gas wallet low | fee transfer missing/short/misaddressed, fee < gas + $0.0003, simulation fails, stale price, gas wallet low |
| Gas wallet | `0xA37fC594E98e951571C771C9e77CDC73f67d3efB` (settler operator AND fee recipient) | `DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2` (fee payer AND fee recipient) |
| Revenue sweep → | `0x086e0f377af1245b8888540f39e99a42a7daf1da` | `5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco` |

Third-party Solana buyers must include the fee transfer themselves (Provian's SDK
`x402-signer-svm.ts` does it, and only to the pinned fee wallet).

## 0. Variables

```bash
export PROJECT=provian-ai REGION=us-central1 SERVICE=provian-x402-facilitator
export SA="$SERVICE@$PROJECT.iam.gserviceaccount.com"
export BASE_GAS_EOA=0xA37fC594E98e951571C771C9e77CDC73f67d3efB
export SOL_GAS_WALLET=DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export PVT=0x8811441914381143b9408c5C32247367F86F173A
export X402_PERMIT2_PROXY=0x402085c248EeA27D92E8b30b2C58ed07f9E20001
# The same Base / Solana RPC endpoints the relay uses (read them from the live relay; they may embed a key):
gcloud run services describe provian-api --region $REGION --project $PROJECT --format=json \
  | jq -r '.spec.template.spec.containers[0].env[] | select(.name|test("BASE_RPC_URL|SOLANA_RPC|ZEROX_API_KEY|ALCHEMY")) | .name + " " + ((.value // "") | .[0:24]) + " " + ((.valueFrom.secretKeyRef.name // ""))'
```

Funding (the operator, inline): $10 of ETH to `$BASE_GAS_EOA` on Base and $10 of SOL to `$SOL_GAS_WALLET`.

## 1. Secrets and service account

`facilitator-base-gas-key` (hex) and `facilitator-solana-gas-key` (64-byte JSON array) already exist.

```bash
# The shared secret the facilitator uses to report settlements to the relay (also /internal/* auth
# and the Solana fee-quote HMAC key). Generated straight into Secret Manager, never printed.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create facilitator-relay-secret --data-file=- --project $PROJECT

# 0x API key for the Base gas refill. If the relay's ZEROX_API_KEY is a plain env value, copy it into
# a secret without printing it:
gcloud run services describe provian-api --region $REGION --project $PROJECT --format=json \
  | jq -j '.spec.template.spec.containers[0].env[] | select(.name=="ZEROX_API_KEY") | .value' \
  | gcloud secrets create zerox-api-key --data-file=- --project $PROJECT
#   (if it is already a Secret Manager reference, use that secret name below instead)

gcloud iam service-accounts create $SERVICE --project $PROJECT --display-name "Provian x402 facilitator"
gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$SA" --role roles/datastore.user
for s in facilitator-base-gas-key facilitator-solana-gas-key facilitator-relay-secret zerox-api-key; do
  gcloud secrets add-iam-policy-binding $s --project $PROJECT --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done
# The relay reads the same relay secret:
RELAY_SA=$(gcloud run services describe provian-api --region $REGION --project $PROJECT --format='value(spec.template.spec.serviceAccountName)')
gcloud secrets add-iam-policy-binding facilitator-relay-secret --project $PROJECT --member "serviceAccount:$RELAY_SA" --role roles/secretmanager.secretAccessor
```

## 2. Deploy `ProvianX402FeeSettler` on Base (from the Base gas key)

Immutables only — no owner, no setters, no proxy. Constructor: `(usdc, operator, feeRecipient,
permit2Proxy, pvt)`; operator and fee recipient are BOTH the gas EOA.

```bash
cd contracts
forge build --contracts src/ProvianX402FeeSettler.sol
FACILITATOR_BASE_GAS_KEY="$(gcloud secrets versions access latest --secret=facilitator-base-gas-key --project $PROJECT)"
forge create src/ProvianX402FeeSettler.sol:ProvianX402FeeSettler \
  --rpc-url "$BASE_RPC_URL" --broadcast \
  --private-key "$FACILITATOR_BASE_GAS_KEY" \
  --constructor-args $USDC $BASE_GAS_EOA $BASE_GAS_EOA $X402_PERMIT2_PROXY $PVT
unset FACILITATOR_BASE_GAS_KEY
cd ..
export SETTLER=0x...   # "Deployed to:" above
# Verify the immutables on chain (the service refuses to enable Base unless they match exactly):
for f in 'usdc(address)' 'operator(address)' 'feeRecipient(address)' 'permit2Proxy(address)' 'pvt(address)' 'MAX_FEE(uint256)'; do
  cast call $SETTLER "$f" --rpc-url "$BASE_RPC_URL"; done
```

Record it in `contracts/deployments/base-x402-fee-settler.json` (address, tx, block, constructor
args) and commit.

## 3. Deploy the service (one instance: the Base operator's nonce is serialized in-process)

```bash
gcloud run deploy $SERVICE --source provian-facilitator --region $REGION --project $PROJECT \
  --service-account $SA --allow-unauthenticated \
  --min-instances 0 --max-instances 1 --concurrency 40 --cpu 1 --memory 512Mi --timeout 180 \
  --set-env-vars "BASE_RPC_URL=$BASE_RPC_URL,SOLANA_RPC_URL=$SOLANA_RPC_URL,FACILITATOR_SETTLER_ADDRESS=$SETTLER,PROVIAN_RELAY_URL=https://api.provian.ai,GOOGLE_CLOUD_PROJECT=$PROJECT" \
  --set-secrets "FACILITATOR_BASE_GAS_KEY=facilitator-base-gas-key:latest,FACILITATOR_SOLANA_GAS_KEY=facilitator-solana-gas-key:latest,FACILITATOR_RELAY_SECRET=facilitator-relay-secret:latest,ZEROX_API_KEY=zerox-api-key:latest"
# The relay runs on the `relay` database (A4): add FIRESTORE_DATABASE_ID=relay to --set-env-vars.
# RPC URLs can carry a key: pass them with --env-vars-file (a 0600 file, deleted after), not on the command line.
export FAC_URL=$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format='value(status.url)')
curl -s $FAC_URL/health      # both chains "enabled"
curl -s $FAC_URL/supported
curl -s "$FAC_URL/fee-quote?network=base"; curl -s "$FAC_URL/fee-quote?network=solana"
```

`--max-instances 1` is deliberate: a second instance would race the Base gas EOA's nonce.

Firestore TTL policies (optional housekeeping) on `x402_seller_nonces_v1.expires_at` and
`x402_presentations_used_v1.expires_at`:

```bash
for c in x402_seller_nonces_v1 x402_presentations_used_v1; do
  gcloud firestore fields ttls update expires_at --collection-group=$c --enable-ttl --project $PROJECT; done
```

Composite index for the witness-retry query is single-field (`witness_status ==`), automatic.

## 4. One-time Solana setup: the gas wallet's USDC account (where the fee lands)

```bash
SECRET="$(gcloud secrets versions access latest --secret=facilitator-relay-secret --project $PROJECT)"
curl -s -X POST $FAC_URL/internal/setup -H "authorization: Bearer $SECRET"   # {"solana_fee_account":{"created":true,...}} once, then created:false
```

(costs the Solana gas wallet one token-account rent deposit, ~0.002 SOL, once.)

## 5. Cloud Scheduler (refill every 15 min, witness retry every 10 min)

The jobs authenticate with Cloud Scheduler OIDC, never with the shared secret in a header: a header
is readable by anyone with `cloudscheduler.jobs.get`, and the relay's scheduler reconciler refuses
any job that carries one (F43). The service accepts a Google-signed token whose audience is in
`FACILITATOR_OIDC_AUDIENCES` and whose email is `provian-scheduler@provian-ai.iam.gserviceaccount.com`
(`src/scheduler-auth.ts`); the Bearer secret still works for manual calls such as step 4.

```bash
gcloud run services update $SERVICE --region $REGION --project $PROJECT --update-env-vars "FACILITATOR_OIDC_AUDIENCES=$FAC_URL"
for j in "provian-x402-refill|*/15 * * * *|/internal/refill|170s" "provian-x402-witness-retry|*/10 * * * *|/internal/witness-retry|60s"; do
  IFS='|' read jname jsched jroute jdl <<<"$j"     # never name a variable `path` in zsh (it is $PATH)
  gcloud scheduler jobs create http $jname --location $REGION --project $PROJECT \
    --schedule "$jsched" --uri "$FAC_URL$jroute" --http-method POST --attempt-deadline $jdl \
    --oidc-service-account-email provian-scheduler@$PROJECT.iam.gserviceaccount.com --oidc-token-audience "$FAC_URL"
done
```

Both jobs are listed under `nonHttpJobs` in `provian-backend/scheduler-jobs.json` (they target this
service, not the relay), so the relay's scheduler reconciler recognizes them.

Refill policy (env-overridable): Base refills below `FACILITATOR_BASE_GAS_FLOOR_WEI`
(default 0.0015 ETH) by swapping at most `FACILITATOR_BASE_REFILL_MAX_USDC` (default $5) of fee
income through 0x (exact approval of the pinned AllowanceHolder; route must return ≥ 95% of
Chainlink fair value); Solana below `FACILITATOR_SOLANA_GAS_FLOOR_LAMPORTS` (default 0.02 SOL)
through Jupiter (top-level programs allowlisted; ≥ 95% of Pyth fair value). Never a swap under $1.
Only once gas is at/above the floor, USDC above the buffer (`FACILITATOR_*_USDC_BUFFER`, default $2)
sweeps to the revenue wallet; the sweep never takes the balance below the buffer.

## 6. Relay (provian-api) env for the witness lane, the runway and the directory

Add to `provian-backend/.env.deploy` and redeploy through the gated flow:

```
FACILITATOR_SETTLER_ADDRESS=<$SETTLER>
FACILITATOR_BASE_GAS_ADDRESS=0xA37fC594E98e951571C771C9e77CDC73f67d3efB
FACILITATOR_SOLANA_GAS_ADDRESS=DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2
FACILITATOR_SOLANA_FEE_WALLET=DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2
# FACILITATOR_SOLANA_RPC_URL=<optional; default Alchemy via ALCHEMY_API_KEY>
```

and the managed secret `FACILITATOR_RELAY_SECRET` → `facilitator-relay-secret` (already in
`MANAGED_SECRET_KEYS` / `managed_secret_name` in `provian-backend/deploy-env.sh`, so a relay deploy
refuses until the secret exists; a value under 32 characters is treated as unset).

Relay behaviour to expect: a fresh Base report answers 202 (pending until 12 confirmations + the
safe head; the relay retries it inside the 5-minute chain-record cron for up to 7 days); 400/409/422
are final and the facilitator marks them `refused`. `GET /v1/x402/sellers` is a public read, like
the agent directory. **Solana settlements seal a PE for each party that has
proven its Solana address**: an agent (`POST /v1/agent/solana-address/{challenge,verify}`, agent
API auth) or a person (`POST /v1/wallet/solana-address/{challenge,verify}`, wallet auth) signs a
one-time "Provian Solana proof of control" message with the address's ed25519 key, which binds it
in `solana_proven_addresses` (one address, one owner) at the current slot. A settlement in a later
slot is the buyer's `x402_payment` / the seller's `receive` on that owner's chain; an unproven
Solana address seals nothing (`not_a_provian_identity`), and a settlement at or before the proof's
slot seals nothing for that party (`before_identity_fence`). A Solana report answers 202 until the
transaction is `finalized`.

## 7. Service env reference

| Variable | Required | Meaning |
|---|---|---|
| `BASE_RPC_URL` | Base | Base mainnet RPC |
| `FACILITATOR_BASE_GAS_KEY` | Base | secret `facilitator-base-gas-key`; must derive `0xA37f…3efB` or Base stays disabled |
| `FACILITATOR_SETTLER_ADDRESS` | Base | the deployed settler; its immutables are checked on boot |
| `SOLANA_RPC_URL` | Solana | Solana mainnet RPC (also the SOL/USD source: Pyth's on-chain push feed account) |
| `FACILITATOR_SOLANA_GAS_KEY` | Solana | secret `facilitator-solana-gas-key`; must derive `DPB8…t2` or Solana stays disabled |
| `FACILITATOR_RELAY_SECRET` | yes | secret `facilitator-relay-secret` (witness reports, `/internal/*`, Solana quote HMAC) |
| `PROVIAN_RELAY_URL` | no | default `https://api.provian.ai` (witness reports + `/v1/present/verify`) |
| `GOOGLE_CLOUD_PROJECT` | no | default `provian-ai` |
| `FIRESTORE_DATABASE_ID` | yes (prod) | the relay's database, `relay` (unset = `(default)`) |
| `FACILITATOR_OIDC_AUDIENCES` | scheduled jobs | this service's run.app URL(s), comma-separated; unset = /internal/* accepts only the Bearer secret |
| `ZEROX_API_KEY` | refill | 0x key for the Base refill swap |
| `JUPITER_API_KEY` | no | Jupiter paid tier (else `lite-api.jup.ag`) |
| `FACILITATOR_ETH_PRICE_MAX_AGE_SECONDS` | no | default 3600 |
| `FACILITATOR_SOL_PRICE_MAX_AGE_SECONDS` | no | default 120 |
| `FACILITATOR_BASE_GAS_FLOOR_WEI` / `_USDC_BUFFER` / `_REFILL_MAX_USDC` | no | refill policy, Base |
| `FACILITATOR_SOLANA_GAS_FLOOR_LAMPORTS` / `_USDC_BUFFER` / `_REFILL_MAX_USDC` | no | refill policy, Solana |

## 8. Live proofs (the deploying session)

1. Seller registers: sign the canonical message (`src/sellers.ts` `registrationMessage`) with the
   seller wallet, `POST $FAC_URL/sellers/register`; it appears at `GET /sellers/base/<addr>`, the
   relay's `GET /v1/x402/sellers`, and the agent directory.
2. Base seller approves the settler for a small USDC fee allowance (e.g. $1): `approve($SETTLER, 1000000)`
   from the seller's own wallet (its own gas — no sponsored approvals).
3. A buyer (e.g. Atlas through the SDK's `wrapFetchWithX402`) pays the seller's 402 whose facilitator
   is `$FAC_URL`; the seller calls `/verify` then `/settle`. Check on BaseScan: one transaction to the
   settler with a buyer→seller USDC `Transfer` and a seller→gas-EOA USDC `Transfer` (the fee) and
   `FeeSettled`. Check the relay recorded `x402_payment` (buyer) and `receive` (seller).
4. Never submitted: repeat with the seller's allowance set to 0 → `/settle` answers
   `fee_uncollectable`; the gas EOA's nonce and ETH are unchanged.
5. Solana: `GET $FAC_URL/fee-quote?network=solana`, put its `extra` into the 402; the SDK buyer adds
   the fee transfer; settle; check the transaction on Solscan (payment + fee transfer, fee payer
   `DPB8…t2`).
6. Refill: once fee income has accumulated, lower the floor for one run (or wait for the alarm floor),
   `POST /internal/refill`; the report names the swap tx; the runway dashboard shows the new balance.

## 9. Signed receipts (: every output carries its signature)

A successful `POST /settle` response carries `Provian-Output-Signature` — the Base gas EOA's EIP-191
signature over `provian-output:v1:<sha256 of the exact response body>` (`src/output-signature.ts`,
held to the relay's pinned vectors by `src/output-signature.test.ts`). No new secret: the key is the
`FACILITATOR_BASE_GAS_KEY` the service already holds; when Base is disabled, receipts go out unsigned. A failed
settlement is not signed.

What this does and does not do, stated plainly: the facilitator never sees a seller's response
(x402 settles before the seller serves), so it cannot sign a seller's output; a seller signs its own
with the SDK (`signResponse` / `outputSignatureHeaders`). The receipt's signer is the gas EOA, which is
not a Provian agent wallet or a proven address, so a citation of a receipt resolves to no owner and
counts zero toward anyone's consumption until that address is bound to an identity.
