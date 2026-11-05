# PVT Monetary Accounting Specification

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

PVT9 is deployed on Base at `0x8811441914381143b9408c5C32247367F86F173A`.
Genesis admits qualifying acts from 2026-08-03 through December 31, 2026;
its admission window closes at 2027-01-01T00:00:00Z. The agent Genesis leg
qualifies on agent-wallet creation. Settlement runs against sealed economics.

- Unit: unsigned integer atomic PVT units; 1 PVT = 10^18 atomic units.
- Scope: record-time accrual, dashboard projection, settlement, Genesis
  reservation, and policy-review behavior.
- The rejected-manifest ledger in
  `provian-backend/src/core/pvt/policy/rejected-approval-manifests.ts` names
  hashes every runtime consumer refuses and which must never be signed.

## 1. Safety properties

1. Every valid PE remains provenance.
2. Every act of work mints once at its best-supported value; its PE mints the base and supported multipliers add on top.
3. A never-seen action type records at zero (`record_only`, weight 0) whatever its witness class. A non-actor witness class enters review; the type earns prospectively only from its signed named row. See §7.
4. Provian witnesses agent acts after the fact and never authorizes or blocks the agent’s own actions. Unverifiable evidence is refused at intake; this is a proof boundary, not an execution approval.
5. An eligible sealed PE has a non-null exact `economic_snapshot` and matching
   SHA-256 commitment.
6. No mint path may reconstruct or guess economics from legacy floating-point
   fields.
7. Dashboard and minting consume the same committed snapshot.
8. A PE that accrued zero cannot display or settle positive PVT.
9. Policy changes are prospective; a sealed record retains its record-time
   vintage.
10. Attestation/corroboration can improve value only when authoritatively
    observed within the enhancement window from the PE's record time: 30 days
    for records at or after 2026-09-09T00:00:00Z, 72 hours for earlier records.
    An in-window observation received after settlement pays an additive top-up;
    the sealed record is never rewritten. See §5.
11. Chain evidence at the economic finalization and recovery
    boundaries requires at least 12 Base confirmations and matching results
    from providers bound to two distinct configured operator identities.
    Different hostnames alone do not establish operator independence. This
    applies to inbound/outbound watcher discovery/accrual, exact-block
    economic-state admission, mint and mint-anchor finalization/recovery,
    epoch advancement, on-chain corroboration, and external-wallet
    proof/EIP-1271 fencing.
12. Operators agree latest head `H`; every permissive economic field is read
    from canonical `H−11`, giving 12 confirmations inclusive. Exact economic
    calls are EIP-1898-bound to that finalized block hash. The snapshot commits
    `H`, `H−11`, both hashes, confirmation depth, both operator identities, and
    canonicality evidence. Finality also rechecks the canonical block at the receipt height
    after reading the agreed head; an orphan receipt is never counted merely
    because both providers can still retrieve its hash.
13. Every shallow `BatchMinted` for a different batch denies/defer new mint
    authority until that event is finalized and every composition-dependent
    field is reread. Classification is per log: an exact requested batch cannot
    conceal any unrelated batch in either order, at any epoch/amount/composition,
    even when both operators return identical mixed evidence. Shallow gross
    totals never expand or transfer finalized authority. Exact-only requested
    evidence enters receipt/finality recovery and is never resubmitted.
14. Unverifiable evidence fails closed. Economic-state and watcher-checkpoint
    readers reject unknown, missing, malformed, and contradictory fields rather
    than hashing or defaulting around them.
15. A best-effort caller without a deterministic durable replay source is
    provenance-only: it consumes no novelty, activity-cap, mint-once, or
    settlement authority and is sealed `record_only`. Only acknowledged durable
    intake may retain a nonterminal mint disposition. The per-actor daily mint ceilings are `send` 25, `receive` 50, `swap` 25 and `x402_payment` 50 per UTC day. `send` and `x402_payment` require verified counterparties. There are no per-counterparty caps or `stake` ceiling.
16. `badge_earned` and `pvt_badge_projection_completed` are durable record-only
    events and mint zero PVT. Badges have no bond discount, pricing or governance authority; the Genesis Agent badge uses the campaign window’s closing timestamp.

## 2. Policy artifacts

The current policy is defined by:

- `policy/proposed-action-policy.ts` and the generated 267-row action matrix;
- `policy/proposed-monetary-policy.ts`, the signed monetary template;
- `policy/proposed-genesis-policy.ts`, the fixed-grant campaign;
- `policy/approved-pvt-cost-catalog.ts`, together with the deployed institutions’ existing literals and prospective schedules.

Paths above are under `provian-backend/src/core/pvt/`. The matrix source is
`docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json`.

`policy/runtime-monetary-policy.ts` validates the activation’s policy version,
monetary-template and embedded approval-manifest commitments, prospective effective boundary
and Ed25519 SSHSIG against its configured public key. Consumers refuse missing, inconsistent,
rejected or unverifiable authority. Runtime policy is the signed monetary template;
a plain-English proposal or an operator classification does not grant mint authority.
The action matrix contains 73 minting and 194 record-only rows.

## 3. Record-time snapshot

The authoritative `RecordEconomicSnapshot` contains:

- schema and policy version;
- PE ID, economic actor, action type, and recording time;
- exact disposition and machine-readable reason;
- exact record points in atomic units;
- base points;
- base action weight and any approved policy override; a never-seen type seals weight 0 until its signed row activates, and every snapshot seals its relay-assigned `witnessClass`;
- the occurrence count used to derive novelty, and the separate daily
  diminishing-return term;
- novelty and duplicate state;
- record-time attestation tier and multiplier;
- record-time linkage state and multiplier;
- beneficiary share basis points;
- evidence state and canonical event commitment;
- beneficial-ownership and session-lineage decisions;
- fixed Genesis reservation source/amount when applicable;
- the only settlement-time adjustments the record policy allows.

Snapshot creation and PE history persistence are one durable flow. If the
result is `eligible`, snapshot absence or hash mismatch is an error, not a
warning.

Current ordinary-work snapshots use exact integer arithmetic:

```
numerator =
  base_points_atomic
  × action_weight_bps
  × novelty_multiplier_bps
  × daily_multiplier_bps
  × linkage_multiplier_bps
  × attestation_multiplier_bps
  × (10000 + 5000 × independent_origin_count)

record_points_atomic = floor(numerator / 10000^6)
```

The occurrence count determines novelty; multiplying by it again would price
repetition twice. `pe:` consumption edges add zero to independent-origin count,
and token counts never affect a current price. Genesis grants have no such
multipliers.

Sealed schemas remain exact compatibility contracts. A `v1` seal uses the first
six factors above and denominator `10000^5`. A `v2` seal also includes the
independence factor and token factor `(100000 + observed_tokens)`, with
denominator `10000^6 × 100000`. Current `v3` seals use the formula above. Each
schema validates under its own formula, so no sealed price is recomputed under
a different schema. Code: `monetary-accounting.ts`, `computeRecordSnapshot`
and `validateSnapshot`.

The implementation records the exact numerator/denominator/remainder needed to
audit flooring. A policy override replaces only the explicitly declared action
weight; it cannot bypass terminal disposition, evidence, duplication,
ownership, or lineage checks.

## 4. Settlement

Settlement verifies the record snapshot hash before doing anything else. It
then applies only adjustments the snapshot authorized.

For ordinary acts of work, operation order is part of the protocol. The
attestation result is floored into the exact contract input first; the contract
rate is then applied to that integer:

```
contract_input_points_atomic = floor(
  record_points_atomic
  × attestation_adjustment_numerator
  / attestation_adjustment_denominator
)

final_pvt_atomic = floor(
  contract_input_points_atomic
  × effective_mint_rate_atomic
  / 10^18
)
```

Parity minting: `effective_mint_rate` is the epoch's armed mint rate and the
only settlement factor. No supply-indexed or lifetime-indexed scaler exists
in this path. The
backend discloses the mint-rate vintage for audit/display. No JavaScript
floating-point quantity is an authority.

The current kernel aggregates contract inputs per contributor and floors
contributor/Foundation shares per contributor and the Provian share at batch
scope. Preflight mirrors that order. Reconciliation consumes exact atomic
amounts from finalized `BatchMinted` events; a projection mismatch retries
internally without erasing a valid PE's value. Action weight is already sealed
in record points and cannot be applied a second time at settlement.

Terminal and mint-once witness snapshots settle zero. An operational hold may
defer settlement of already priced work, but it cannot turn a duplicate-count
guard, draft witness, or terminal denial into another mint.

Standard linked-agent routing defaults to 2,000 agent-share basis points
(20/80), prospectively configurable in exact integer basis points from 500
through 5,000. This is a bounded default, not an immutable universal ratio.
Every sealed snapshot keeps its exact beneficiary-share basis points; later
configuration changes never reprice it. Genesis bypasses this contributor-layer
routing but still applies the immutable treasury split to the fixed gross input.

### 4.1 PVT9 contract settlement

The live PVT9 kernel consumes the following settlement inputs. Legacy token
contracts supply no authority to this ABI.

For the standard-PE lane, claims are grouped by a strictly ordered contributor
list. The contract consumes every claim's exact positive sealed
`recordPointsAtomic`, aggregates those points per contributor, and computes:

```
contributor_gross_atomic = floor(
  contributor_record_points_atomic × epoch_mint_rate_atomic / 10^18
)
```

The multiplication uses full-precision 512-bit intermediate arithmetic and
fails atomically if the quotient is outside the `uint256` domain. There is no
PVT9 settlement-time PE weight, second weight multiplier, ZeroHash bypass,
supply scaler, effective-rate composition, automatic baseline, velocity rule,
or emergency-rate path.

For each human-resolving contributor, and for an autonomous agent while the
agent Foundation rate remains at its 50-BPS default:

```
contributor_atomic = floor(contributor_gross_atomic × 9900 / 10000)
foundation_atomic  = floor(contributor_gross_atomic ×   50 / 10000)
```

When a differential agent rate `agent_foundation_bps` is active, a known
autonomous agent instead receives:

```
contributor_atomic = floor(
  contributor_gross_atomic × (10000 - 50 - agent_foundation_bps) / 10000
)
foundation_atomic = floor(
  contributor_gross_atomic × agent_foundation_bps / 10000
)
```

Known human-resolving contributors retain the 50-BPS Foundation treatment.
The agent rate defaults to 50 BPS, may be changed prospectively by the operator, may
never be below 50 BPS, and is structurally restricted only to at most 9,950
BPS so the contributor residual cannot underflow. The 9,950 endpoint is a
technical domain boundary, not an economic target or permanent economic
ceiling. At the identical 50-BPS default, autonomous-agent settlement neither
requires a human link nor a configured beneficiary verifier. Once treatment
differs, unknown classification and unavailable, malformed, or false verifier
answers fail before minting.

After contributor-level floors, the Provian amount is floored once at batch
scope:

```
provian_atomic = floor(sum(contributor_gross_atomic) × 50 / 10000)
actual_issued_atomic =
  sum(contributor_atomic) + sum(foundation_atomic) + provian_atomic
```

The Genesis-PE lane bypasses the mint rate. Each typed claim supplies its exact
positive reserved gross amount, capped by the immutable 75/75/25-PVT grant
maximum, one-time typed anchor, and 500-PVT gross wallet lifetime ceiling.
Reserved gross is aggregated per recipient; contributor and Foundation floors
are applied per recipient at 9,900 and 50 BPS, then the Provian 50-BPS floor is
applied once to batch gross. There is no depletable Genesis pool.

Both lanes count `actual_issued_atomic` against cumulative on-chain epoch
counters. Genesis also counts against the Genesis sub-cap. A transaction that
would exceed either the complete snapshotted Genesis cap or combined cap
reverts before any mint, claim, anchor, wallet counter, cursor, or batch state
persists. Epochs are seven days. The live kernel runs Fixed cap policy:
7.5M Genesis PVT and 10M combined PVT per epoch from epoch 1. No epoch uses
Automatic mode. Later policy changes are prospective and evented; the kernel's
trailing-average calculation does not engage under this Fixed policy.

Every batch binds chain ID, contract address, lane, unique batch ID, exact
active epoch and complete policy hash, contiguous finalized cursor range,
claims hash, and settlement digest. The policy hash commits the mint rate,
both caps, both treasury destinations, effective agent rate, beneficiary and
eligibility verifier address/configuration/version, Genesis dates, and
immutable kernel-rule hash. Claims and typed Genesis anchors are mint-once. An attestation top-up is its own standard-lane claim: kind `attestation_topup`, ID from `deriveTopupClaimId`, and ledger key `pe#leg#attestation_topup`. There is at most one top-up per PE leg, mint-once on that ID.
The contract's verifier calls bind and fail-close the supplied settlement
digest; they do not independently prove off-chain work, evidence quality,
provider quorum, or Base finality. Those orchestration/evidence duties remain
the settlement runtime’s duties.

## 5. Attestation enhancement

The record stores its original tier and the tiers/multipliers available under
that policy vintage. At settlement:

- the requested verified tier cannot be worse than the record tier;
- a better tier must have been allowed by the record-time action policy;
- its observation time must be at or before
  `recorded_at + attestation_enhancement_window` (30 days for records at or
  after the 2026-09-09 horizon cut line; the legacy 72 hours before it);
- exactly at the boundary is allowed;
- one millisecond late leaves the record value unchanged;
- the late signal remains provenance.

An in-window observation received after the act minted pays an additive top-up
of `lifted − base`, split over the act's ledger rows in their frozen proportions
(`wp4/attestation-topup-inlet-source.ts`, `topupDeltasFor`). The sealed row,
snapshot and `mint_status` never change. The 72-hour cross-witness takeover
window remains separate from the enhancement horizon.

## 6. Dashboard truth

The personal PVT endpoint uses
`provian-backend/src/core/pvt/policy/economic-projection.ts`.
For each row it:

1. requires a valid snapshot and matching hash;
2. projects only a presently eligible state;
3. applies exact beneficiary basis points;
4. exposes sealed record points separately from any current settlement
   projection;
5. labels a current projection `non-final` and includes the on-chain factor
   vintage and as-of reference;
6. exposes a fixed Genesis reservation separately as exact reserved gross;
7. reports atomic values and derives display values from those integers;
8. returns zero on integrity failure.

The dashboard does not trust `estimatedPVT` floating-point history and never
labels record points as final or estimated minted PVT. A current per-PE
projection is intentionally non-final because contributor aggregation,
settlement factors, and treasury floors are resolved at batch settlement. The
mint worker follows the same input preparation path and then applies the exact
PVT9 batch order.

### 6.1 Operational holds

A hold is a processing state. It changes neither the sealed PE nor its economic commitment.
Recovery resumes from the durable claim and authoritative chain evidence; uncertainty never
creates mint authority. Final settlement requires the kernel receipt and finality checks.

## 7. Unknown action policy

A never-seen type with an admitted witness class records an exact zero snapshot
(`record_only`, weight 0; reason `witness_class_admitted`, review state
`class_admitted`). A non-actor class co-writes the durable pending-policy queue,
operator email and structured ERROR log suitable for Cloud Monitoring. The
queue survives notification failure, supports retries and overdue escalation,
and cannot be activated by a classifier or automation. Actor-declared work has
no intake path to a PE; a class gate cannot turn the actor's assertion into an
independent witness.

Verified Cloud Monitoring alert configuration is required. A type earns only
from its signed named row's effective time, and nothing sealed earlier is
repriced. The signed template declares `unknownActionAdmission` with admission
`record_only_until_signed_row`. An operator classification without a signed row
can only decline a type (`record_only` or `ineligible_terminal`); a minting
pointer in `pvt_action_policies` resolves `pending_policy`. Named rejection wins,
and read failure never admits. Code: `policy/runtime-monetary-policy.ts`,
`policy/action-policy-gate.ts`, `policy/evidence-class.ts`.

## 8. Genesis accounting

### 8.1 Exact reward legs

| Action | Gross contract input atomic | One-time anchor |
|---|---:|---|
| `genesis_human_signup` | 75000000000000000000 | human wallet ID |
| `genesis_signup` | 75000000000000000000 | agent ID |
| `genesis_device_link` | 25000000000000000000 | registered device ID |

The standard `wallet_created` policy remains a separate 20-record-point (10.0× row weight × 2.0× human linkage, at novelty 1.0)
birth certificate and stacks with `genesis_human_signup`.

No other Genesis grant legs exist.

### 8.2 Admission

Genesis admits qualifying acts through December 31, 2026, closing at 2027-01-01T00:00:00Z. The signed policy and activation are enforced by the reservation state machine. Admission uses:

- the separately approved campaign window;
- authoritative qualifying-act evidence;
- authoritative wallet creation time;
- an immutable one-time anchor;
- atomic flooring;
- a 500 PVT gross per-wallet lifetime ceiling.

The activation has an evented admission-close operation.
Closing atomically records the cutoff and event, turns new grants off, and
preserves valid pre-cutoff backlog. An act after that cutoff is denied; an
act at or before it whose deterministic outbox was durably co-written remains
reservable even when processed later. Admission close does not strand the backlog.

It does not use a total pool, participant count, per-action aggregate cap,
funding source cap, KYC rule, IP limit, funding minimum, compute gate, or new
device-attestation requirement.

Genesis grants have no time-based reduction. The exact fixed grant is
independent of wallet age:

```
multiplier_bps = 10000            (constant, independent of elapsed time)

desired_atomic =
  fixed_grant_atomic

reserved_atomic =
  min(desired_atomic, wallet_lifetime_remaining_atomic)
```

A grant reserves exactly 75/75/25 PVT gross, capped only by the 500-PVT
wallet lifetime ceiling.

### 8.3 Crash-safe qualification and fixed-grant settlement

The qualifying act and deterministic outbox are co-written. The reservation state machine uses `pending_reservation → reserved → emitting → pe_recorded → complete`, with transactional anchor deduplication, wallet gross ledger and exact snapshot commitments. Durable identities and idempotency markers make retries refer to the same act rather than creating another grant.

The completed reservation enters the PVT9 Genesis inlet. `settleGenesisPEBatch` accepts the exact fixed gross input, independent of ordinary attestation, linkage and standard mint rate. Standard beneficiary routing does not apply; the 99/0.5/0.5 treasury split does. A 75-PVT gross grant therefore gives the contributor 74.25 PVT, before any atomic flooring across the grouped batch.

Registration clients durably prepare their identity and credentials before networking. Agent creation proves its key locally; same-key recovery replaces lost API credentials without repeating the wallet, first proof, watcher, linkage or Genesis effects. Device retries reuse the exact registration ID, `device_key` and `device_secret`. The relay receives no plaintext wallet key. Key rotation uses the separately authenticated atomic old-key/new-key proof path; it is not a new signup or grant.

Sources: `core/pvt/genesis-award-state-machine.ts`, `core/pvt/wp4/genesis-inlet-source.ts`, `routes/devices.ts`, `routes/agent-wallet.ts`, and `contracts/src/ProvianPVT9.sol`.

### 8.4 Capacity, pacing and finality

Admission and settlement capacity are separate. The live kernel uses Fixed caps of 7,500,000 Genesis and 10,000,000 combined PVT per seven-day epoch. A selected recipient must fit whole within both applicable headrooms; there is no 95% factor and no scaling down a recipient. Claims that do not fit remain durable for a later epoch. Standard work settles on a schedule Provian sets, currently every 30 days per payee (`0 12 * * *`), Genesis daily (`0 0 * * *`), and a payee may request ready earnings sooner for a flat $1 USDC service fee.

The PVT9 cycle runner owns the durable cycle cursor, lease, fencing, claim registration, exact input preparation, transaction nonce, replacement handling and same-cycle continuation. It paginates the backlog instead of letting one full page starve later claims. The kernel checks the exact active epoch and policy, claim and batch identity, contiguous finalized cursor and actual issued totals atomically. Its contract checks are the final no-double-mint boundary.

Before broadcast, the runtime persists the signed transaction and derived hash and verifies its target, selector, calldata, nonce and zero native value. Finalization and recovery require matching canonical evidence from two distinct configured RPC operator identities and at least 12 Base confirmations. An already observed transaction is recovered by its exact bytes and receipt, rather than submitted as a new economic act. Unknown or contradictory evidence remains restrictive. Operational holds never reprice a sealed act.

A prospective cap change uses the kernel’s existing epoch-indexed setter. It cannot edit a closed epoch or a sealed earning snapshot. Genesis admission ends at its campaign cutoff; valid pre-cutoff reservations remain payable while the protocol is operated, subject to the Terms’ final-settlement discontinuation clause.

Sources: `core/pvt/wp4/settlement-cycle-runner.ts`, `core/pvt/wp4/operator-runtime.ts`, `core/meter/meter-settlement.ts`, and `contracts/src/ProvianPVT9.sol`.

## 9. PVT-native institution costs

The deployed institution contracts and their prospective schedules establish the costs in force. `policy/approved-pvt-cost-catalog.ts` describes approved cost categories; a proposal artifact alone authorizes no fee or transfer. Fees use the same asset as their principal: PVT protocol fees burn, while USDC protocol fees go to the fee wallet. Arbitrator compensation pays arbitrators. Bond posting burns 2% and renewal burns 1%; separate deposit and renewal fees are zero under the checked-in deployed schedule. Exact base values, bounds, recipients, refunds and forfeitures are in the contracts and the Manual’s institution tables.

A cost PE is bookkeeping and never circularly mints its own cost back. No USD quote, exchange rate, oracle, external-asset value or market price converts into a PVT-native cost. Fees derive from PVT principal or specified PVT literals under the contract; external value never prices work.

## 10. Settlement admission boundary

A sealed economic snapshot and its exact commitment determine the claim. A free-form amount, display estimate or unrelated on-chain deployment never grants settlement authority. The live kernel’s claim and batch checks preserve mint-once.

## 11. Approval and authority

The append-only rejected-manifest ledger in
`provian-backend/src/core/pvt/policy/rejected-approval-manifests.ts` drives every
runtime and generated approval consumer. Every listed digest must be refused
and must never be signed.

Approval verification binds the configured Ed25519 SSHSIG key and namespace to
exact UTF-8 manifest bytes, all stated economics and every reviewed-artifact
hash. A reference string, wrong key, wrong namespace or altered byte fails.
The kernel's sole direct bootstrap administrator and economic-policy setter is
the immutable bootstrap EOA. The operational minter has only bounded batch
submission authority. There is no governance, executor, Safe, proposal, voting,
timelock, admin-transfer, recovery, renunciation or handoff path. The
beneficiary-verifier and agent-Foundation-rate powers stay coupled: a separately
authorized successor architecture must keep them with the same controller.
An accounting-policy signature alone cannot confer any of those powers.

## 12. Operational safeguards

- One batch owns its lease, fencing token, conditional claims and exact combined
  and Genesis capacity. Floors, contributor aggregation and finalized event
  reconciliation follow the same integer operation order.
- Dashboard record points, non-final projections and exact reserved Genesis
  gross are distinct. Unverifiable proof is refused; Provian does not impose execution approvals on an agent.
- Every shallow `BatchMinted` composition change is restrictive. Receipt/finality
  recovery never resubmits a transaction already observed on chain.
- Registration durably binds wallet identity, native watcher admission and
  membership-generation invalidation. Creator retries recover their canonical
  identity; unknown-wallet credential replacement and unsafe key rotation fail.
- Watcher membership checkpoints, Firestore-native opaque-ID recovery ordering,
  replay/accrual, malformed-claim quarantine and pagination all retain exact
  state and conservative evidence validation.
- SDK registration uses the guarded networking boundary. Challenge-to-create
  reload, complete event/Foundation accounting and exact activity, lineage and
  mint-once state are preserved through retries.
- Best-effort record-only accrual consumes no physical-device limiter,
  rate-limit capacity or novelty ordinal. Malformed inputs are refused before proof admission.
- Legacy state is excluded at the settlement cut line. Sanitized historical
  samples grant no migration, owner-classification or mint authority.
