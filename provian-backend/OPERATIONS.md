# Provian Backend Operations

Operational notes for the Cloud Run service (provian-api).

## Explorer API keys

The Etherscan-family explorer keys (ETHERSCAN_API_KEY, BASESCAN_API_KEY,
ARBISCAN_API_KEY, OPTIMISM_ETHERSCAN_API_KEY) should be rotated
independently per chain. Reusing one key across all four chains means a
single compromise rate-limits explorer integrations on every supported
network simultaneously. Issue a separate key per chain in the relevant
explorer dashboards (etherscan.io, basescan.org, arbiscan.io,
optimistic.etherscan.io) and set each env var to its own value.

Owner: Provian Technologies, LLC. No code change required.

## Redis configuration

UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are technically optional
but the relay logs an explicit warning at startup when they are missing.
Without Redis:

  - Security-critical rate limits (recover, bond claims, bond posts) fail
    closed via cache.checkRateLimitStrict and return 503
    recovery_temporarily_unavailable / rate_limit_unavailable.
  - General API rate limits (per-user, per-agent, global) fail open via
    cache.checkRateLimit so the API stays available.
  - jti replay buffer for v2 wallet auth falls back to the consumed_nonces
    Firestore collection.

Set both variables to fail-secure-and-functional in production.

## Email

RESEND_API_KEY enables transactional email (agent invites, beneficiary
invites). Absence does not crash the server; the relay logs an ERROR-level
line at startup and `/v1/admin/health` returns `{ email: { disabled: true } }`.

Pending-policy first-sight and retry notifications run in the separate private
`LongevityManiac/provian-ops` service. The relay durably records the queue and
retains all classification and monetary authority. Operator email, incident
channels and notification schedules are configured in that private repo.

## PVT pending-policy operator queue

The queue is readable with the existing admin secret. List responses include
`total` and an opaque `next_cursor`; pass it back as `cursor` until null:

```text
GET /v1/admin/pvt/policy/pending?state=pending_policy&limit=100&cursor=...
GET /v1/admin/pvt/policy/pending/:actionType
```

Classification and rejection are prospective, audited writes. They return 503
unless `PVT_POLICY_CLASSIFICATION_WRITES_ENABLED=true`. The flag is `true` on the
serving revision and stays on, so the queue always has a
resolve path. The admin API is still never the path to a mintable row: classify
writes `record_only` only. A type that lands as a named row on the signed
matrix closes its own queue row (`resolved_signed_matrix`), and a live-proof probe
row is purged, never rejected (`scripts/purge-pending-policy-probe.ts`):

```text
POST /v1/admin/pvt/policy/pending/:actionType/classify
POST /v1/admin/pvt/policy/pending/:actionType/reject
```

**classify is a ONE-WAY DECLINE.** The classify route can only write
`record_only` (declining a type, with a reason). A mintable disposition
(`eligible`, `pending_evidence`, `pending_review`) — and the compliance-terminal
`ineligible_terminal` — are refused at the route with `403`
(`pvt_policy_classify_disposition_forbidden`), even if the write flag is on. The
ONLY path to an eligible action-policy row is the signed matrix path: an emitter,
an independent verifier, a matrix row in `proposed-action-policy.ts`, the
maintainer's SSHSIG over the activation template, and a gated deploy. There is no
admin secret + Firestore write that produces an eligible row.

A record-only classification still requires a future `effective_at`, a new
`effective_policy_version`, explicit reason/category/zero base weight, evidence
requirement `none`, the record-only field set, a non-Genesis fixed-grant source,
and an `x-ops-basic-user` audit identity. Generic classification cannot arm a
Genesis bounty. It never updates PEs sealed while the action was unknown.
Rejection likewise requires a future `effective_at` and version; PEs recorded
on/after that boundary remain record-only with
`policy_review_state=rejected` and do not re-enter the pending queue.

Queue observation is atomic with the product record. The private operator
service watches committed queue updates and owns notification retries. Queue
recovery and notification never change PE economics.

## Health

  - `GET /health` returns `{ status: 'ok' }` for unauthenticated callers
    (Cloud Run probes, uptime checks).
  - `GET /v1/admin/health` returns full diagnostic state (cache stats,
    PE buffer stats, email status and the
    classification-write gate) and requires the `x-admin-secret`
    header (ADMIN_API_KEY; AGENT_BANK_ADMIN_SECRET only when ADMIN_API_KEY is unset).
