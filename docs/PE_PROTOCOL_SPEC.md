<!-- SPDX-License-Identifier: MIT; see PE_PROTOCOL_SPEC.LICENSE -->

# Provian PE Protocol Specification

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

**Envelope wire:** `provian.pe.v2` · **Live schema:** 2.3.2 · **Export:** `provian.pe-export.v1`
**Status:** Stable
**Location in repo:** `docs/PE_PROTOCOL_SPEC.md`

---

## Constitutional Status

This specification is the authoritative definition of a valid Provenance Envelope under Article I of the [Provian Network Constitution](../NETWORK_CONSTITUTION.md). It has the stability guarantees of a protocol standard:

- **Versioned.** Changes to this spec follow semantic versioning. Breaking changes increment the major version.
- **Stable.** The PE structural spec (hash chain, signature format, required fields) is versioned and backward-compatible. Breaking changes require a 30-day notice period.
- **Witnessed, never declared.** PEs prove provenance: a PE exists only when something other than the actor vouches for it — the device observing the work, a counterparty, a forge, or the chain. An actor's own claim about its work is never a PE, at any tier. The type of work is never the gate; a witness is. Any type records on a witness lane with no proposal, vote, or approval; a type the network has never seen records with no mint and earns from the day its policy row is signed. Economic classification is a separate, prospective policy step. See Section 3a below.
- **Universal.** The Provian relay accepts PEs from any agent building any ecosystem. It evaluates whether the PE is structurally valid, hash-chain-consistent, and properly signed. It does not evaluate what the ecosystem does, what the action means, or whether the agent should have taken it.

Any implementation - wallet, agent, device, sensor, compute cluster - that produces valid PEs according to this spec can participate in the Provian network. Work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value under the separately versioned monetary policy. There is no approval process or partnership requirement for membership or recording.

Use `GET /v1/schema/pe` for the current PE and pricing-input schema. The conformance endpoint validates its own declared envelope shape; it is not a replacement for the PE v2 batch-wire checks described below.

---

The Provenance Envelope (PE) is the atomic unit of the Provian trust network - cryptographically signed, hash-chained proof that something real happened, owned by its contributor.

Think of PEs as SMTP: the Provian wallet is one mail client, but the protocol runs on any device that can observe compute work, sign an envelope, and submit it to the relay.

---

## 1. Design Principles

**Evidence and its limits.** A PE binds an actor and a submitted record to evidence that the relay can verify. Witness class and attestation grade describe the evidence, not guaranteed correctness, usefulness, or computational expenditure. Hardware witnesses require a non-actor signature checked to the scheme’s pinned public root. A body-bound registered-device report is accepted at its device tier; an operator-controlled daemon can fabricate reported origins and token counts. This report-authenticity residual is accepted. No provider catalog, independent token meter, or volume cap is implied.

**Chain integrity.** Every PE references the hash of the previous PE from the same actor. The chain cannot be retroactively altered without invalidating all subsequent signatures. Hidden or suppressed PEs leave detectable gaps.

**Extensibility.** Valid flat identifiers and `namespace:action_name` identifiers are discovered in the catalog as they are sealed. An unknown type on a witness lane records with no mint and enters the public review queue; it earns once a signed policy row names it, from that row's effective time forward. Purely `actor_declared` work is refused (`403 actor_declared_work_is_not_a_pe`). Named matrix rows retain their dispositions, including record-only exceptions. A rejection wins, and a policy read failure never admits work. The catalog at `GET /v1/pe/earning-proposals` is discovery, not a separate monetary authority.

**Fail-safe defaults.** Every act of work mints once at its best-supported value. Named policy, the verified witness class, mint-once checks, novelty, and jurisdiction determine eligibility and value. Missing or unverifiable required evidence does not trigger a permissive category fallback. Later qualifying corroboration may support an additive top-up under policy; it does not rewrite a sealed PE.

**Open participation.** Any compute device can generate PEs. The device does not need to run the Provian wallet. It needs: (1) the ability to observe real compute work, (2) a registered signing key, (3) the ability to reach the Provian relay.

---

## 1a. Universal Validity

A Provenance Envelope is signed proof of an action and its evidence that its contributor owns. Protocol validity is jurisdiction-independent; PVT issuance is a separate policy decision. This technical separation does not determine the legal treatment of an activity in every country.

The PE protocol is jurisdiction-agnostic by design. A PE generated in any country, by any actor, on any device, is structurally identical to every other PE. The relay evaluates whether the PE is valid - not where it was created or who created it.

**Jurisdiction policy gates settlement.** Whether a valid PE triggers PVT minting depends on the jurisdiction policy maintained by the relay. In jurisdictions where token generation is currently permitted, eligible valid PEs enter the minting pipeline immediately. In jurisdictions where token generation is not currently permitted, valid PEs are accepted, validated, and hash-chained normally - they accumulate minting eligibility that activates if and when local law permits.

This separation is constitutional. Article I of the Network Constitution guarantees that any valid PE is accepted by the relay regardless of jurisdiction. Article II governs how accepted PEs flow through the minting pipeline, including jurisdiction-aware eligibility.

**No PE is ever rejected based on the jurisdiction of its creator.** Jurisdiction policy affects only the `mint_status` field - whether the PE enters the minting pipeline immediately or is deferred. All other PE functions - hash chaining, attestation tier assignment, reputation scoring, provenance history, conformance validation, PE Public Projections - operate identically regardless of jurisdiction.

**Beneficiary chain and Foundation rate determination.** When a PE enters a settlement batch, the kernel applies one of two Foundation rates to the contributor's share: the immutable human Foundation rate (`HUMAN_FOUNDATION_BPS` = 50 BPS) for a contributor classified as human-resolving (a beneficiary chain that terminates at a verified human), or the current prospectively scheduled agent Foundation rate for an autonomous-agent contributor. While the two rates are equal the classification is moot; once they differ, the configured beneficiary verifier must attest each batch's classifications and an unknown classification fails closed. The chain resolution is opaque to the PE protocol. This is a mint-layer concern, not a PE-validity concern: the rate decision does not modify the PE or change its acceptance.

---

## 2. Envelope Structure

Every PE is a JSON object built, hashed and kept by its owner’s device. The current wire type is `PeV2`, defined in `provian-backend/src/core/meter/meter-wire.ts` and mirrored in the SDK:

```typescript
interface PeV2 {
  readonly schema: string;       // "provian.pe.v2"
  readonly pe_id: string;
  readonly device_id: string;
  readonly prev_hash: string;
  readonly timestamp: number;    // UTC Unix milliseconds
  readonly action_type: string;
  readonly pe_hash?: string;
  readonly signature?: string;
  readonly description?: string;
  readonly [field: string]: unknown;
}
```

The wire type is extensible; it does not require financial fields on a compute act or an agent policy decision on work. `pe_hash` is computed over the complete canonical PE excluding `pe_hash` and `signature`. The corresponding batch act always carries that hash. An original PE signature is retained when present; SDK-built PEs do not universally carry a device P-256 signature. Authenticated batch binding and admitted evidence establish the witness.

Action-specific metadata, compute telemetry, `input_origins`, `output_digests`, replication evidence and `hardware_witness` belong in the complete PE and its permitted pricing projection. Owner descriptions, intent and content stay local or owner-encrypted, outside the ordinary relay pricing projection. The live schema defines their current field shapes; the sections below explain the evidence semantics. No submitter-controlled field grants mint authority.

### 2.1 Relay economic projection (not part of the signed envelope)

Economic workflow state is derived from the sealed PE and is deliberately not
inside its signed/hash-chained body. The relay computes this projection when it
prices the act in memory; the owner keeps its receipt. Output-bearing acts retain a small trust row for the 30-day corroboration window and any unpaid claims; new keys expire at least 30 days after payment. The public batch receipt (Section 7) returns a summary: disposition, reason, sealed points and mint status, not this full internal projection. It must never be represented as
submitter-controlled or mutate the sealed PE.

```typescript
interface PEEconomicProjection {
  mint_disposition:        'eligible' | 'pending_evidence' | 'pending_review' |
                           'record_only' | 'ineligible_terminal' | 'pending_cache' |
                           'beneficiary_pending' | 'jurisdiction_deferred';
  disposition_reason_code: string;   // stable versioned monetary-policy reason
  policy_review_state:     'not_required' | 'pending_policy' |
                           'classified_prospective' | 'class_admitted' | 'rejected';
  policy_review_reason_code: string; // stable versioned review-workflow reason
  economic_policy_version: string;   // selected at PE record time
}
```

Classification changes this projection only for PEs recorded under the new
effective policy. A PE recorded while its type was unknown keeps the
disposition it was sealed with even after the queue item is classified: on a
witness lane it is admitted for recording at `record_only` with no mint
(`class_admitted`, Section 3a) and stays a record after the type's row is
signed; a type whose policy could not be read seals `record_only` under
`pending_policy`.

### 2.2 Signed outputs and consumption

**Consumption** ("who built on your work") counts citations that carry the producer's
signature over the output's hash. There is no per-output hash index; small retained act
trust rows support verification, and a signed citation is verified when the citing act
arrives and folded into the per-pair count (`meter_pair_counts_v1`).

**The signature.** Every output an agent (or a person's device) hands out may carry:

```typescript
interface OutputSignature {
  hash:   string;                                        // "sha256:<64 hex>" of the exact output bytes
  signer: { kind: 'wallet' | 'device' | 'app'; id: string };
  scheme: 'eip191_secp256k1' | 'p256_sha256';
  sig:    string;
}
// message signed by every kind: "provian-output:v1:" + <64 hex of the hash>
// wallet → EIP-191 personal_sign by the wallet key; id = lowercase 0x address; sig = 0x + 130 hex
// device → P-256 over sha256(message) by the device's registered key; id = device_id; sig = r‖s (128 hex)
// app    → P-256 over sha256(message) by the phone's PE attestation (device) key; id = "aok_" + 32 hex
```

It travels with the output as the HTTP header `Provian-Output-Signature` (base64url of the
canonical JSON object) or as the JSON field `provian_output_signature` (an MCP tool result, a JSON
body). The one definition is `core/meter/output-signature.ts`, byte-identical in the relay, the SDK
and the app (`check:meter-wire`), with pinned vectors in `docs/audit/output-signature-vectors.json`.

**Who signs.** An agent signs with its own wallet key (SDK `signOutputWithWalletKey`, MCP
`sign_output`, CLI `provian sign-output`). A device that does not hold the wallet key signs with its
registered device key: a Secure Enclave device with its signing key (already on its device record);
a bearer (HMAC-only) device with a P-256 output key it creates once and registers with
`PUT /v1/devices/me/output-signing-key` (proof of possession over
`provian-output-key:v1:device:<device_id>:<public key>`); a phone with its PE attestation key, registered
under wallet auth with `POST /v1/wallet/output-signing-key` (proof over
`provian-output-key:v1:app:<user_id>:<public key>`). The wallet key never signs on a device that does
not hold it. The x402 facilitator signs its settlement receipt with its gas EOA; it never sees a
seller's response, so a seller signs its own output with the SDK (`signResponse`).

**A person's Commons outputs.** The phone registers its output key automatically at wallet setup,
at restore and on later opens (never a prompt; idempotent; per wallet). Every Commons write whose
content others can build on carries the phone's signature over exactly the text whose hash the
write's PE seals: a forum post or reply (its trimmed content), a want (its normalized outcome,
capabilities and chains), a hiring-board job post (its trimmed title and description, now sealed as
the post's output digest), and a job deliverable (its body, else its URI) — `forumPostOutputText`,
`wantOutputText`, `jobPostOutputText`, `deliverableOutputText`. The relay accepts the signature only
when it verifies against a registered key AND names the writer (otherwise the write is refused before
anything is stored), keeps it with the record as `provian_output_signature` and serves it with the
record (a deliverable only to its two parties). A thread message is E2E ciphertext, so its signature
rides inside the sealed plaintext as a trailing `Provian-Output-Signature:` line over the text before
it. When the app opens someone else's signed post, deliverable, job post or thread message, it queues
the citation through the same hash-checked capture rule (once per output), and the phone's next PE
carries it; there is no declared-citation path.

**Citing.** A citation is an `input_origins` entry
`{ hash, origin_identifier: "out:<kind>:<id>", witnessed, witness, signature }`. It is captured, never
declared: the SDK's fetch wrappers (`wrapFetchWithOutputCitations`, `wrapFetchWithX402`) and the
observer daemon's transcript lane (a tool result carrying the header or the JSON field) queue a
signed output the device RECEIVED — only after checking the signature names the exact bytes received —
and the device's next observed PE carries it, witnessed by that device. The phone does the same on its
next PE.

**Counting at intake** (every lane that prices an act — the device and phone batches and the relay's
own acts):

1. The signature is verified against the signer's registered key, and the producer is resolved
   through the identity registries only: a wallet address through the native wallet index, then the
   agent and person proven-address registries; a device through the devices collection (owner user,
   or owner agent wallet → agent id); a phone key through `app_output_keys_v1`.
2. The citing act must itself be witnessed under the existing rule (the submission carries a verified
   witness and the entry says `witnessed: true`). The producer's signature only names who MADE the
   output; it never witnesses the citing act. A citation on an unwitnessed act counts zero
   (`pe_unwitnessed`).
3. The same-party fence and the ring filter apply unchanged: a citation of the actor's own output, or
   of its linked agent's / linked human's output, counts zero (`same_party`); a citation inside a ring
   is recorded and excluded (`closed_loop`).
4. Unsigned citations count zero: a `pe:` origin, a bare hash, a bad signature or an unknown signer
   (`unresolvable_owner`).

A counted citation increments the producer's per-pair count once per citing PE; the vocabulary's
`consumption.independent_parties`, `consumption.edges` and `consumption.ring_excluded` read those
counts, and a presenter can answer a predicate such as `consumption.edges gte 1` in a burn-backed
reputation presentation. Citations pay nothing to anyone and add nothing to the citer's multiplier.

---

## 3. Action Types

The `action_type` field classifies what kind of work the PE records. There are three identifier classes:

- **Approved launch identifiers:** Explicitly present in the versioned action-policy manifest (including seeded first-party names and known launch aliases).
- **Namespaced identifiers:** Format `namespace:action_name` (e.g. `myapp:user_signup`, `langchain:agent_run`), validated by regex `^[a-z][a-z0-9]*:[a-z][a-z0-9_]*$`.
- **Other permissionless identifiers:** Any other valid identifier (alphanumeric + underscores, starting with a letter).

Identifier syntax never selects an earning tier. An identifier absent from every effective approved policy is unknown for monetary purposes even if discovery has already auto-registered it.

The canonical list of seed types is in `src/core/provenance/types.ts`. The tables below are maintained by hand from that source and the relay's action-policy matrix (`provian-backend/src/core/pvt/policy/proposed-action-policy.ts`); a few relay-side types, such as `code` and `agent_api_orchestration`, are in the matrix but not in `types.ts`.

---

## 3a. Type Creation

Emit your envelope — that is all you need to do. The type of work is never the gate; a witness is. Any valid `action_type` records on a witness lane, with no approval:

- **The sovereign lane** (`POST /v1/pe/submit-sovereign`): a hardware-witnessed submission — an occurrence carrying an admitted non-actor `hardware_witness` — of a `compute_or_work`-family type or of a type the network has never seen.
- **The gateway path** on the device batch (`POST /v1/meter/batch`): a registered machine's observer witnesses the work through an observer plugin. The observer stamps the act `metadata.source: "observer_plugin"` and `metadata.observer_plugin: <plugin name>`, and the act records at device tier. The plugin runs in an observer the machine's owner embeds (`ProvianObserver` from `@provian/agent-sdk/observer` + `registerPlugin`; `examples/sensor-gateway` is one); the daemon the one-command setup installs witnesses the machine's own work and loads no third-party plugin. The batch also admits the observation-lane types its own lanes emit (`compute_session`, `inference_session`, `coding_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation`, and a transcript-witnessed `link_spend`; `provian-backend/src/core/provenance/device-observation-types.ts`).
- **The chain, forge, relay and counterparty lanes** witness their own types.

A bare call asserting work with nothing else vouching for it — an actor or its device vouching for its own claim — is refused, not recorded: a device-batch act of any other type without the plugin marker is refused in the receipt (`actor_declared:action_type_not_observed`), and the sovereign lane refuses an occurrence with no admitted witness (`403 actor_declared_work_is_not_a_pe`). A named type keeps its own witness: a chain, relay, forge or Genesis type presented through the actor's own hardware report or an observer plugin is refused. On the phone's batch an unnamed type is the person's own claim: it records at `actor_declared`, earns zero, and does not enter review.

**How it works:**

1. A witness lane seals a PE with a valid `action_type` string.
2. If the type is unknown, the relay creates a `pe_type_catalog` entry with:
   - `source`: `seed`, `auto_registered`, or `namespace`
   - `category`: inferred from the type name (or `uncategorized` if unknown)
   - `first_observed_*`: the submitter and timestamp
3. Independently, when the PE's witness class is a non-actor class, the relay
   transactionally upserts one `pvt_pending_policy_queue` item, naming the lane
   it came in on, and alerts the operator. The type appears in the public review
   queue (`GET /v1/pe/earning-proposals`, provian.ai/proposals).
4. The sealed PE records with no mint (`record_only`, `policy_review_state:
   class_admitted`), whatever its witness class.
5. A named price for the type is a signed policy row (and the maintainer's
   template signature). It affects only PEs recorded at or after its effective
   boundary, on each lane the signature names (a lane the type came in on); earlier
   PEs stay records.
   Submitters are notified when the type earns: a push for people, an
   `action_type_activated` inbox event and webhook for agents. Contributing an
   emitter and a verifier as a PR is welcome, never required.

**Discovery categories (not an unknown-action monetary fallback):**

| Category | Discovery meaning |
|----------|-------------------|
| `financial` | a financial or value-moving action |
| `compute` | compute or work-product activity |
| `social` | communication or social activity |
| `governance` | governance or adjudication activity |
| `security` | security and policy enforcement |
| `institutional` | network-institution lifecycle activity |
| `infrastructure` | internal network machinery |
| `uncategorized` | no semantic policy is inferred |

Approved weights and later adjustments are versioned, prospective monetary policy. The signed Base-mainnet action-policy matrix and exact accounting rules are in [the Provian Manual, §5](./PROVIAN_MANUAL.md#5-earning-pvt--the-record-path). No category default may turn an unseen system action into money.

**A witness records a type; a named price is signed.** A witnessed envelope
with a valid `action_type` is sealed and chained immediately; a type the network
has never seen records with no mint (§3a) and enters the public review queue on
first sight. There is no propose form and no upvote step (the former
`POST /v1/pe/type-catalog`, `/propose-type`, and `/upvote` write forms were
removed). A named matrix row lands only as a code change — an emitter, a
verifier that can independently confirm the work happened, and the row — signed
by the maintainer; anyone may contribute it, nobody is required to. A type with
no verifier is never given an eligible row.

**Published review SLA:** a ruling within 3 business days of first sight
(building, declined with a reason, or alias); approved types go live at the next
weekly signing cut, at most 7 days after merge. Envelopes earn from the go-live
timestamp forward, never before. No path auto-mints an unseen type or revalues an
earlier PE.

**Status:** read the earning-type registry — `GET /v1/pe/earning-proposals` (or
`/:action_type` for one), public at [provian.ai/proposals](https://provian.ai/proposals)
— for every type's status (queued / building / live with its weight / declined
with reason).

### Action catalog

The complete code-derived table is in [the Manual’s action index](PROVIAN_MANUAL.md#complete-action-policy), generated from the signed action-policy matrix. It lists each row’s category, base weight, disposition, evidence requirement and attestation pricing without implying that every identifier has an active emitter.

Device observation lanes emit `compute_session`, `inference_session`, `coding_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation` and transcript-witnessed `link_spend`. Forges emit their signed service events; the chain supplies financial events; the relay and counterparties witness their own Commons and institution acts. The agent’s own assertion supplies none of these witnesses.

The identifier describes the act, while its verified evidence and signed row determine its disposition. Identity, security, costs, failure/no-op bookkeeping and duplicate-witness rows carry no separate work mint. Human approval is a witnessed act the approver owns and the agent may cite; it never authorizes the agent’s actions through Provian.

## 4. Metadata Schemas

Include the relevant metadata block for your `action_type`. These are optional but improve trust scoring and auditability.

### Current action metadata

Use the live schema at `GET /v1/schema/pe` and the action’s actual witness lane. Neither an authorization flag nor copied `verified` metadata establishes evidence. Financial proof requires the chain; forge proof requires the signed forge event; device observation requires its authenticated batch and canonical occurrence. Human approvals carry the approver’s signed request identity and subject hash as citable proof.

### AI Conversation Metadata
```typescript
// Required on ai_conversation PEs. Never contains conversation text,
// URLs, or keystrokes. See the Provian Manual, §9.4 and §10, for the capture
// design.
ai_conversation_metadata: {
  provider:                 'claude' | 'chatgpt' | 'gemini' | 'perplexity' | 'grok' | 'venice';
  surface:                  'desktop_foreground' | 'mobile_wrapper';
                                      // 'mobile_usage_stats' (Android out-of-app capture) is
                                      // not live: the relay refuses it and never mints it.
  duration_ms:              number;   // Wall-clock window length.
  active_duration_ms:       number;   // Subset of duration_ms with observed interaction.
                                      // Equals duration_ms when input_fidelity = 'presence_only'.
  turn_count:               number;   // Conversational turns, clustered from input timing.
                                      // Zero when input_fidelity = 'presence_only'.
  char_count:               number;   // Desktop foreground: 0 (content not visible to the plugin).
                                      // Mobile wrapper: filled by the MutationObserver.
  image_count:              number;   // Same per-surface semantics as char_count.
  video_seconds:            number;   // Same per-surface semantics as char_count.
  session_fingerprint_hash: string;   // SHA-256 over length-prefixed UTF-8 fields
                                      // (provider, session_start_ms, duration_ms,
                                      //  turn_count, plugin_name). Relay-side dedup
                                      // keys on this value.
  input_fidelity:           'full' | 'presence_only';
                                      // full: capture surface observed real input events.
                                      // presence_only: permission was denied or the surface
                                      // cannot observe input. An authorized prospective
                                      // policy event may calibrate weight multipliers;
                                      // a governance vote has authority only after a
                                      // separately approved activation or handoff.
};
```

### Energy / AI Footprint (optional, any action_type)
```typescript
energy_estimate?: {
  estimatedWh:   number;
  confidence:    'measured' | 'corroborated' | 'estimated' | 'inferred';
  method:        string;
  estimatedCO2g?: number;
  providerAnnotation?: {
    reportedWh?:              number;
    hardwareClass?:           string;
    pue?:                     number;
    gridCarbonIntensityGCO2?: number;
    gridRegion?:              string;
  };
};
```

### Commons institutions Transaction Metadata

Commons institutions PEs (`escrow_created`, `escrow_funded`, `escrow_completed`, `escrow_disputed`, `escrow_resolved`, `promise_funded`, `promise_settled`, `promise_defaulted`, `pool_created`, `pool_contributed`, `pool_executed`, `pool_refunded`, `job_posted`, `job_accepted`, `job_delivered`) carry a structured `metadata` block that records the currency and amount in a discriminated form. This lets any consumer query by currency without string-matching on `asset_symbol`.

```typescript
metadata?: {
  currency: 'pvt' | 'usdc';

  // PVT path (when currency === 'pvt')
  amount_pvt?:  string;       // BigInt-as-string, 18-decimal atomic units
  fee_pvt?:     string;       // BigInt-as-string; disposition follows the deployed institution contract

  // USDC path (when currency === 'usdc')
  amount_usdc?: number;       // USD float
  fee_usdc?:    number;       // USD float; routed to fee wallet

  // Deliverable class (present on escrow PEs; see "agent_payment convention" below)
  deliverables?: string;

  // Chain the transaction lives on
  chain?: 'base' | 'arbitrum' | 'optimism';
};
```

**Currency field rules:**

- `currency` is a required discriminator when `metadata` is present. The PVT fields and the USDC fields are mutually exclusive; the relay rejects mixed-currency bodies.
- `amount_pvt` / `fee_pvt` are BigInt-as-string in 18-decimal atomic units (wei-style).
- `amount_usdc` / `fee_usdc` are USD floats (on-chain atomic units are `value * 1e6`).
- For PVT transactions, `fee_pvt` records the fee in PVT atomic units. Disposition follows the deployed contract: protocol burn fees reduce supply; arbitrator fees go to voting arbitrators; posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded; bond deposit and renewal fees go to `provianTechWallet` (both fees are currently zero, with prospective setters).
- For USDC transactions, `fee_usdc` represents the fee routed to the Provian fee wallet.

The `asset_symbol` field at the root of the envelope (Section 2) remains populated for continuity with other PEs; for Commons institutions PEs, `asset_symbol` is `"PVT"` or `"USDC"` to match the metadata currency.

### The `deliverables: 'agent_payment'` Convention

The `deliverables` field on escrow metadata is caller-defined in general (a file path, a commit hash, a human-readable description of the work). **The string `"agent_payment"` is reserved as a cross-cutting tag for one-shot agent-to-agent PVT settlements that are not bound to a specific deliverable.**

The SDK helper `CommonsInstitutions.payAgentPVT` writes `deliverables: "agent_payment"` automatically on every escrow it creates, with a 24-hour auto-release. Any client using `createEscrow` directly for a similar purpose (tipping, flat fees, subscriptions, one-shot settlement) should adopt the same tag.

**Why this matters:**

- Direct agent-to-agent PVT payments are structurally indistinguishable from deliverable-bound escrows at the contract layer (both are PVT-funded escrows with memos). Without a convention, analytics cannot separate "Alice paid Bob 5 PVT" from "Alice escrowed 5 PVT to Bob pending delivery of X."
- A consistent `deliverables: "agent_payment"` tag makes direct settlements queryable as a distinct class. This is how the network measures PVT velocity, agent-to-agent direct-payment volume, and the direct-vs-deliverable mix.

**Consequences of following or not following the convention:**

- **Callers who follow the convention** surface in network composition metrics (direct-payment volume, PVT velocity, settlement-class distribution) and in any third-party analytics that query the `agent_payment` class.
- **Callers who do not follow the convention** still create valid PEs; any proof-of-work PEs can still mint PVT under monetary policy. Nothing economic is gated on the tag. They simply do not appear in queries that filter on direct agent-to-agent payments.

The convention is a naming agreement, not a protocol gate. It is called out here in the spec because it is the only reserved value in the otherwise caller-defined `deliverables` field.

---

## 5. Attestation Tiers

The relay derives attestation from verified evidence. Verified App Attest supplies the hardware-rooted 4.0× class, and so does a verified TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed Provian observer release (the measured observer, 2026-10-10: the platform produces the measurement when the program starts, so the operator cannot choose it; the pins come only from the signed release channel). Any other verified hardware report remains a presentation fact at the normal lane price (desktop secure-element evidence included). A bare attested machine without a daemon mints at `device_tier`. Registration uses the same rule. Prior sealed rows retain their original amounts; non-hardware evidence factors and verified-human linkage remain unchanged.

| Tier | Multiplier | Requirements |
|------|-----------|--------------|
| `hardware_rooted` (witness class) | 4.0x | A verified App Attest assertion over the exact PE body; the tier is lifted to `hardware_full`, which multiplies at 1.0x on the evidence-priced table |
| `hardware_full` | 2.5x | Relay-verified platform attestation on a human device (e.g. iOS App Attest), priced on the standard ladder when no per-PE hardware witness is attached |
| `corroborated` | 1.1x | Merchant MTL commerce signal or on-chain tx confirmed within 30 days of the PE's record time |
| `software_verified` | 1.2x | Replication evidence: `replication_pack.input_hash` and `output_hash` at device intake; settlement enhancement also requires `model_id` |
| `software` | 0.8x | Default for software agents. No hardware backing. |
| `social` | 0.5x | Social attestation only |

Agent-owned devices are assigned the `software` base tier on the server before
signing-method selection, regardless of a hardware claim or Secure Enclave
signature. A valid Replication Pack or independent corroboration can still
apply its PE-level evidence upgrade. The agent-owned registration's own
`device_register` PE carries no device anchor and mints zero PVT.

**Evidence-priced families.** The multipliers above are
the STANDARD ladder. The compute/work family (work products, sessions, code,
research, `ai_conversation`, …) and the forge-witness family (`service:*`) do
not read it: they price on the evidence axis, where the self-attested tiers
earn the family's own discount rather than a terminal zero — `software`
**0.8x**, `social` **0.5x** — while a self-produced replication pack
(`software_verified`) is capped at the family's flat 1.0x, parity with proof —
with novelty decay pricing repeated same-type work down toward the 0.3x floor
(exact duplicates 0).
The externally-proven tiers (`corroborated`, `hardware_partial`, `hardware_full`,
`compute_tee`, `full_stack`) are a *lift* above that base to the family's flat 1.0x; a
mere device-tier claim buys no gradient here, because proof lifts to full value, it
is not a hardware-farm. A verified **App Attest assertion** — the hardware-rooted class,
a non-actor-signed report checked to Apple’s pinned public root — is admitted on these
lanes too and lifts an eligible act to the hardware-rooted tier. A valid witness does
not establish that the reported work was useful or that farming cannot pay. Corroboration is a lift, never the price of admission.
Separately, an actor's own declaration is never a PE: a body with no
non-actor witness (a device body binding for an observation type, an admitted
hardware witness, a forge HMAC webhook, an on-chain watcher, or the relay
performing the act) is refused `403 actor_declared_work_is_not_a_pe` — so the
discount above prices observed work, never a costless assertion. Genesis fixed grants are outside
both tables (attestation-neutral by design).

**Witness classes and unknown-type admission.** Every sealed PE also carries a relay-assigned *witness class* — `hardware_rooted`, `chain_witnessed`, `forge_witnessed`, `relay_verified`, `device_tier`, or `actor_declared` — with a base weight in basis points (40000 / 20000 / 30000 / 10000 / 10000 / 0). A never-before-seen `action_type` that a non-actor witness vouches for (a hardware-witnessed sovereign submission, an observer plugin's act on the device batch, or a chain, forge, relay or counterparty lane; a never-seen type in a person's own phone batch is that person's own claim; Section 3a) is not rejected: it is admitted for recording with no mint and enters the public review queue, so the action-type space stays open to witnesses while a type earns only once a signed row names its price and the type is granted for the lane it came in on, from that row's effective time forward. Named action types are priced by the action-policy matrix exactly as before; class admission changes nothing for them, and a rejection always wins over class admission.

**Settlement and the attestation window:** earnings settle on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date, at no charge; Genesis grants settle daily. Any payee can have its own earnings settled now for a flat $1 USDC service fee (Section 7, *Settlement and on-demand payout*). A PE mints on its evidence at the next settlement rather than waiting behind a hold. If a corroboration signal arrives within **30 days of the PE's record time**, the PE's attestation is upgraded (e.g. to `corroborated`, 1.1x, or, on the evidence-priced families, the lift from the self-attested discount to the family's flat 1.0x), and the difference is paid as an additive top-up in a later settlement — never a rewind of what already minted, and never a delay of the original mint.

---

## 6. Hash Chain Mechanics

Every device keeps its own PE chain. The chain is a linked list where each PE names the hash of the previous PE from the same device.

### Computing `pe_hash` (PE v2)

1. Take the complete PE JSON object
2. Remove the `pe_hash` and `signature` fields
3. Serialize as canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, `undefined` members dropped, non-finite numbers refused
4. Compute SHA-256 of the UTF-8 bytes
5. Encode as lowercase hex string

`prev_hash` is the previous PE's `pe_hash`, or the literal string `"genesis"` for the device's first PE. The hash covers the complete PE, free text included, so a PE presented later is checked byte for byte against what the relay accepted. The one implementation is `meter-wire.ts` (`peHashOf`), byte-identical in the relay, the SDK and the app.

PEs sealed before the meter chain by `prev_envelope_hash` over the v1 envelope, computed as follows.

### Computing `prev_envelope_hash`

1. Take the previous PE JSON object
2. Remove the `signature` field if present
3. Serialize to JSON with keys in lexicographic order, no extra whitespace
4. Compute SHA-256 of the UTF-8 bytes
5. Encode as lowercase hex string

```typescript
function hashEnvelope(envelope: ProvenanceEnvelope): string {
  const { signature, ...withoutSig } = envelope;
  const canonical = stableStringify(withoutSig); // json-stable-stringify
  return sha256(Buffer.from(canonical, 'utf8')).toString('hex');
}
```

### Chain integrity rules
- The owner's device builds, hashes and keeps its chain; the relay never stores it. Every act in a batch must continue the device's chain from the last act the relay accepted from that device (`verifyActChain`), so a PE appears in exactly one accepted batch, and a batch that breaks the chain is refused `409 act_chain_broken`
- PEs the relay authors (webhooks, chain watchers, institution events, Commons acts, Genesis, registration) are chained at the owner's relay chain tip inside one atomic transaction; concurrent writes racing for the same tip are refused with `409 chain_contention` and retried, never interleaved
- Hiding a PE is a display choice on the owner's device; the PE stays in the chain

Each act's record is a leaf of its batch's `acts_root`, and each accepted batch is a leaf of the day's Merkle root anchored on Base (Section 13). **Anchoring is active:** each device fetches its batches' inclusion proofs from `GET /v1/meter/proofs` and keeps them with its PEs.

---

## 7. Submitting PEs to the Relay

Your agent’s work reaches your phone once a day. A presentation or an on-demand payout sends it immediately.

A device keeps its PEs and sends the relay one signed batch per day, plus one immediately before any presentation or on-demand payout, so those always reflect its latest acts. Each act in a batch is the PE's identity, its `pe_hash` over the complete PE, and its pricing inputs, never its free text. An offline device queues its PEs and sends them when it reconnects; an act that reaches the relay more than 30 days after it happened is counted but does not mint (Genesis grants are exempt).

### Endpoints
```
POST https://api.provian.ai/v1/meter/batch           # a registered device: daemon, SDK, any HTTP client holding a device key
POST https://api.provian.ai/v1/meter/batch/mobile    # the Provian app, under wallet auth
```

Companion routes: `GET /v1/meter/tip` (the device's latest accepted batch, to resync), `GET /v1/meter/mailbox` and `POST /v1/meter/mailbox/ack` (PEs sealed to this owner, dropped once the owner files them), and `GET /v1/meter/proofs` (each anchored batch's inclusion proof). The app's equivalents sit under `/v1/meter/mobile/`. Every lane documents its credential in [the Provian Manual, §2.2](./PROVIAN_MANUAL.md#22-relay-authentication-model).

The single-PE recorders `POST /v1/pe/submit`, `/v1/pe/submit/mobile`, `/v1/relay/action` and `/v1/relay/work-product` answer `410 pe_recorder_retired` with the batch route to use. A sovereign agent records a compute/work occurrence via `POST /v1/pe/submit-sovereign` only when it carries an admitted non-actor `hardware_witness` (the agent's own EOA signature alone, and any `x402_payment` or `link_spend` body, is refused). PEs the relay authors are priced as one-act relay batches under the same rules and sealed to their owner.

### Authentication

**External device (registered device key):**
```
Authorization: DeviceKey {device_key}:{device_secret}
```
Or equivalently with HTTP Basic auth:
```
Authorization: Basic {base64(device_key:device_secret)}
```
Where `device_key` has the `pdk_` prefix and `device_secret` has the `pds_` prefix as issued by `POST /v1/devices/register`. Secure-Enclave-registered devices instead send `Authorization: DeviceSignature {device_id}` plus an `X-Provian-Signature` header (`<preimage_b64u>.<sig_b64u>`: a compact P-256 signature over the base64url preimage; that preimage binds method, path, raw-body hash, issue/expiry time, single-use nonce and audience). The relay's device-auth middleware (`provian-backend/src/routes/middleware/device-auth.ts`) accepts all three forms. For `DeviceKey`/`Basic` bearers, an optional `X-Provian-Body-HMAC` header (hex HMAC-SHA256 of the raw body under the device secret) binds the batch to the credential; when present it must verify. See [the Provian Manual, §2.2 and §10](./PROVIAN_MANUAL.md#22-relay-authentication-model) for device registration.

**The app:** wallet auth (the request-bound v2 token); the batch's device is the token's device.

**Provisional agent (retired):** an `Authorization: AgentKey {identifier}` submission is refused (its route, `/v1/pe/submit`, answers `410 pe_recorder_retired`) — an unauthenticated identifier's report is the submitter's own claim. `GET /v1/provisional/:id/status` still reads existing provisional records.

**Admitted acts (device batch):** the observation-lane action types, and an act of a type the network has never seen (or one that entered review this way and has since been signed) that the observer witnessed through an observer plugin (`metadata.source: "observer_plugin"` with `metadata.observer_plugin`, Section 3a), in a batch the device bound (`DeviceSignature`, or `X-Provian-Body-HMAC`); an act labelled `local_witness` / `mcp_self_report`, a caller-typed `action_type` without the plugin marker, a named type outside the observation lanes, or a `link_spend` the transcript lane did not observe earns nothing and stays in the batch fingerprint. So does a plugin-marked act that carries `link_spend`, `agent_tool_orchestration`, a built-in lane's `source` or a lane's `tool`: only the daemon's own lanes carry their markers.

### Owner-local logical batch and encrypted request body

The JSON below is the logical batch retained by its owner, before transport encryption. It is not the HTTP body. Private paths, content digests and original PE commitments never leave the device as clear or dictionary-testable values. The SDK and phone send `{ "private_batch": <AES-256-GCM box> }`, encrypting `{ "batch": <the unchanged batch>, "openings": <per-act opening secrets> }` under the existing registered credential with context `provian-private-batch:v1`. Private act pricing uses `private_pricing`, bound to that act's `pe_id`. A queued historical batch keeps its exact original commitments inside the wrapper.

The device signature, body HMAC or wallet token binds the original encrypted HTTP bytes. The relay authenticates those bytes before opening the request, then verifies and prices the original logical inputs. No new identity key is created. Retained private-capable records, IDs and diagnostics are encrypted or MACed under the existing relay secret. Owner copies and signatures remain exact.

```json
{
  "schema": "provian.pe-batch.v1",
  "device_id": "dev_…",
  "seq": 42,
  "prev_batch_hash": "<the previous accepted batch's hash, or \"genesis\">",
  "created_at_ms": 1791000000000,
  "acts": [
    {
      "pe_id": "pe_…",
      "pe_hash": "<64 hex: the complete PE's hash, Section 6>",
      "prev_hash": "<64 hex, or \"genesis\">",
      "timestamp": 1790999000000,
      "action_type": "coding_session",
      "pricing": {
        "metadata": { "tool": "claude-code", "files_changed": 12, "commit_sha": "0123456789abcdef0123456789abcdef01234567" },
        "compute": { "duration_ms": 4200, "cpu_seconds": 3.1 },
        "geo": null,
        "execution_env": { "os": "linux", "runtime": "node" },
        "parent_goal_pe_id": null,
        "output_digests": [{ "hash": "sha256:…", "kind": "file" }],
        "input_origins": [{ "hash": "sha256:<the cited output digest>", "origin_identifier": "pe:<pe_id>" }]
      }
    }
  ],
  "acts_root": "<64 hex>",
  "sealed": [{ "to": "linked_human", "pe_id": "pe_…", "box": "<base64url sealed box>" }]
}
```

- **Act record.** `pricing` is the PE minus its identity fields and free text (`description`, `intent_text`): the evidence blocks defined in Section 2 (`metadata`, `compute`, `geo`, `execution_env`, `parent_goal_pe_id`, `output_digests`, `input_origins`, `economic_session_lineage`, `hardware_witness`). When the PE carries `private_pricing`, `pricing` is exactly `{ private_pricing }` plus `hardware_witness` and `detail_hash` where present (Section 14.4, step 3). Free text never leaves the device. The evidence blocks are optional; no act is rejected for omitting them. (`cited_pe_ids` is retired; a `pe:` origin that does not resolve is recorded unwitnessed, not rejected.)
- **Owner fields and gates.** The free text the act record omits (`description`, `intent_text`) is still covered by `pe_hash`, which the act record carries into the anchored `acts_root`. These fields are how an owner carries the evidence a gate will require: metadata is the envelope's floor, not its ceiling, and a sensitive system can require specific evidence before it lets an agent act. They leave the device only when the owner elects to disclose them inside a presentation answering a requester's named disclosure ([Burn-to-Present](BURN_TO_PRESENT.md#named-disclosure--beyond-yesno)).
- **Chain.** `seq` starts at 1 and rises by one per accepted batch; `prev_batch_hash` is the previous accepted batch's hash (SHA-256 of the batch's canonical JSON minus `sealed`). The first act continues the device's PE chain from the last act the relay accepted (Section 6).
- **Fingerprint.** `acts_root` is the Merkle root over the act leaves `sha256("provian.meter.act.v1\n" || canonical(act))`, with SHA-256 `0x00`-tagged leaves and `0x01`-tagged sorted-pair nodes, padded to a power of two. The relay recomputes it and never trusts it.
- **Sealed copies.** Optional, one per PE per recipient: `to` is `linked_human` (an agent's linked human) or `owner` (a human device's own owner), `box` an x25519 sealed box the relay cannot open. The relay holds it until the recipient acknowledges durable receipt, then deletes it. The sending daemon re-sends unacknowledged copies from its permanent store.
- **Hardware witness.** A `hardware_witness` signs the act's binding nonce: SHA-256 of the canonical `{ pe_id, prev_hash, timestamp, action_type, pricing }` with the witness slot removed from `pricing`.
- A logical batch holds 1–500 acts. Its commitment format is `meter-wire.ts`, byte-identical in the relay, the SDK and the app; the HTTP body uses the authenticated encrypted wrapper above.

### Response (`201 Created`; `200` for the same batch re-sent)
```json
{
  "schema": "provian.pe-batch-receipt.v1",
  "device_id": "dev_…",
  "actor_id": "…",
  "seq": 42,
  "batch_hash": "…",
  "acts_root": "…",
  "batch_leaf": "…",
  "accepted_at_ms": 1791000001000,
  "acts": [
    {
      "pe_id": "pe_…",
      "pe_hash": "…",
      "relay_pe_id": "pe_m_…",
      "leaf_index": 0,
      "disposition": "eligible",
      "reason": "…",
      "record_points_atomic": "…",
      "mint_status": "eligible"
    }
  ],
  "totals": { "eligible_points_atomic": "…", "acts": 1, "eligible": 1 }
}
```

The signature, sequence and previous-batch hash are verified once. The day’s counters are read once, acts are priced in memory, and counters, totals, pending claims and the batch record are committed together. Exact packed occurrence membership spans all devices of an actor; single-lane acts need no per-act identity lookup or dedupe row. Two-lane types retain cross-witness keys, and output-bearing acts retain the small trust row needed for consumption edges, independence and corroboration top-ups. New trust and cross-witness keys remain until their claims are paid, then at least 30 days; their corroboration horizon is still measured from record time. Each act is priced under every rule, exactly as a single submission was; `disposition` is one of `eligible`, `record_only`, `held`, `duplicate`, `refused`, `ineligible`. Record points are not PVT: an act that is not `eligible` mints 0 however large its points. An act more than 30 days old when it arrives is counted in its owner's records and totals but seals `record_only` (`meter_act_older_than_30_days`); Genesis grants are exempt. An act dated more than 10 minutes in the future earns nothing. `GET /v1/pvt/estimate` prices a scenario by the same derivation.

### Error responses
| HTTP | `error` / `code` | Reason |
|------|------------------|--------|
| 401 | `Device authentication required`, `X-Provian-Body-HMAC verification failed` | Credential missing or unknown, or body binding failed |
| 400 | `batch_invalid` (`code`: `bad_schema`, `bad_seq`, `bad_prev_batch_hash`, `no_acts`, `too_many_acts`, `bad_act`, `duplicate_pe_id`, `acts_root_mismatch`, `bad_sealed`, …) | Malformed batch |
| 403 | `batch_device_mismatch` | A batch may only be submitted by the device that built it |
| 409 | `batch_replay`, `batch_chain_broken` (with `expected_seq`, `expected_prev_batch_hash`, `last_pe_hash`) | The batch does not extend the device's latest accepted batch |
| 409 | `act_chain_broken` (with `act_index`) | An act does not continue the device's PE chain |
| 409 | `batch_concurrent`, `batch_retry` | Another batch landed first, or state an act depended on changed — re-send the same batch |
| 429 | `batch_too_soon` (`retry_after_ms`), `Rate limit exceeded` | A second batch within 5 minutes (unless draining a full backlog), or the per-device rate limit |

### Settlement and on-demand payout

A batch's receipt prices each act; PVT reaches the wallet at settlement. Earnings settle on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date, at no charge. Genesis grants settle daily.

Any payee can have its own ready earnings settled now for a flat $1 USDC. The fee pays for running that one payee's settlement; it is never a price for PVT and is the same whatever is owed. Only that payee's earnings mint; no one else's PVT moves. Nothing is charged when nothing is ready, or while Base gas costs more than the fee.

- **Agent:** `POST /v1/payout` under its agent API key, paid over x402 from its own wallet (`PAYMENT-SIGNATURE`); without a payment the route answers `402` with the requirement. The SDK verb is `provian payout --yes`; the MCP tool is `request_payout`.
- **Person:** `POST /v1/payout/mobile` under wallet auth, paid from the app wallet (the "Settle now" card).
- `GET /v1/payout/{id}` reads the requester's own request; a paid request finishes on its own.

---

## 8. Null State Flags

When data is unavailable at PE creation time, record it in `null_state_flags` rather than omitting the field. This signals to the relay that the absence is intentional, not an error.

| Flag | Meaning |
|------|---------|
| `no_counterparty` | Counterparty address not applicable or unknown |
| `no_contract` | No contract interaction |
| `no_asset` | Non-financial action |
| `no_amount` | Amount not applicable |
| `no_hardware_attestation` | Device does not have a hardware secure element |
| `offline_submission` | PE was generated offline and submitted with delay |

---

## 9. Replication Packs

A Replication Pack is cryptographic evidence that a compute output can be independently verified. Including a complete Replication Pack records the `software_verified` attestation tier. On standard-priced action types that is a pricing upgrade (0.8x → 1.2x); on the evidence-priced compute/work family (§5) the `software_verified` tier is capped at the family's flat 1.0x — parity with proof, up from `software` 0.8x — strengthening the record's verifiability at the same value verified hardware attestation, chain-verified corroboration, or a third-party witness earns.

Use the snake-case `replication_pack` block:

| Field | Meaning |
|---|---|
| `input_hash` | Digest of the input, kept private or protected under the applicable commitment rules |
| `output_hash` | Digest of the produced output |
| `model_id` | Model identifier; additionally required by settlement-time enhancement |
| `pack_hash` | Commitment to the replication pack, required by the separate work-evidence completeness check |

The device-batch intake selects `software_verified` from `input_hash` and `output_hash`. The economic-projection enhancement also requires `model_id`; the work-evidence completeness predicate checks `input_hash`, `output_hash` and `pack_hash`. These are separate checks, not one interchangeable three-field rule. Replication strengthens witnessed work; an actor’s own claim has no PE path.

---

## 10. PE Public Projections

A PE Public Projection is a derived document that makes selected PE data publicly visible while preserving cryptographic verifiability and redacting sensitive content. Projections are the mechanism by which PE data enters the public record - no PE is ever exposed directly.

### 10.1 PEPublicProjection Structure

```typescript
interface PEPublicProjection {

  // ── Identity fields (always present) ───────────────────────────────────────
  //    Every public read (the publish response, GET /v1/pe/projection/:id,
  //    Commons listings) returns relay-secret HMAC aliases for pe_id, pe_hash,
  //    prev_envelope_hash and projection_signature.
  //    The originals stay in the relay's stored record and in the owner's PE and
  //    inclusion proof.
  pe_id:                    string;     // Public: the opaque projection ID,
                                        //   "projection_" + 64 hex, an alias of the
                                        //   relay's id for the PE (pe_m_…)
  pe_hash:                  string;     // Public: an alias of the PE's hash (Section 6)
  prev_envelope_hash:       string;     // Public: an alias of the PE's prev_hash
  action_type:              ActionType; // Action classification
  attestation_tier:         string;     // Tier the relay assigned when it priced the act,
                                        //   read from the retained output trust row or supplied owner proof;
                                        //   `software` once that record has expired
  timestamp:                string;     // ISO 8601 time of the source PE
  actor_wallet_id:          string;     // Provian wallet id of the publisher, who proved
                                        //   the PE is theirs (an agent's wallet id, a
                                        //   person's user id); not an on-chain address

  // ── Redactable fields (controlled by publisher via RedactionConfig) ─────────
  //    Always present. A field the publisher did not choose to show is null and
  //    named in redacted_fields; a shown field is null when the PE has no value.
  intent_text:              string | null; // RedactionConfig.intent_text_summary if given,
                                           //   else the PE's intent_text (or metadata.intent_text)
  counterparty_wallet_id:   string | null; // The PE's counterparty_address (needs consent, 10.4)
  amount:                   number | null; // The PE's metadata.amount
  currency:                 string | null; // The PE's metadata.currency (e.g. "USDC")
  artifact_hash:            string | null; // The PE's metadata.artifact_hash

  // ── Publication metadata ───────────────────────────────────────────────────
  published_at:             string;     // ISO 8601 time the projection was created
  published_by:             string;     // Provian wallet id of the publishing party
                                        //   (the same id as actor_wallet_id)
  consent_parties:          string[];   // The publishing wallet's id (`[published_by]`).
  redacted_fields:          string[];   // Names of the redactable fields the publisher
                                        //   did not choose to show
                                        //   (e.g. ["amount", "counterparty_wallet_id"])
  institution:              string;     // Free-form string identifying the institutional
                                        //   context (e.g. "commons", "audit", "portfolio").
                                        //   The protocol does not define what institutions
                                        //   exist. Any PE-conforming implementation can
                                        //   generate projections through the relay.

  // ── Verification fields ────────────────────────────────────────────────────
  projection_signature:     string;     // Public: an alias of the relay's SHA-256 of the
                                        //   stable-stringified signing content (the
                                        //   relay's pe_id, pe_hash, published_by,
                                        //   redacted_fields, institution, and the
                                        //   publication time in ms), computed by the
                                        //   relay at publication time. Keys are sorted
                                        //   lexicographically; no extra whitespace. The
                                        //   millisecond time it covers is not stored, and
                                        //   no verifier recomputes it: it is a reference,
                                        //   not a proof (verification is anchor_proof, 10.7).
  original_pe_exists:       boolean;    // true: the relay proved the presented PE through
                                        //   its act record and batch to the day's anchored
                                        //   root on Base (10.5, step 2).
  chain_position_verified:  boolean;    // true: the anchored batch that holds the PE's act
                                        //   record names the publisher as its actor
                                        //   (10.5, step 3).
  anchor_proof?: {                      // The on-chain half of the inclusion proof the
    kind:         'meter_day';          //   publisher presented: hashes only, no PE content.
    batch_id:     string;               //   Anyone re-checks it on Base (10.7). Absent on
    day:          string;               //   a projection published before the meter.
    batch_leaf:   string;
    leaf_value:   string;               // keccak256(0x00 || batch_leaf)
    merkle_proof: string[];
    chain_id:     number;               // 8453
  };
}
```

### 10.2 RedactionConfig

The publisher controls which optional fields to include via a `RedactionConfig` submitted at publication time:

```typescript
interface RedactionConfig {
  show_intent_text:               boolean;  // Default: false
  intent_text_summary?:           string;   // Optional: published as intent_text instead
                                            //   of the PE's own text when show_intent_text
  show_counterparty:              boolean;  // Default: false
  show_amount:                    boolean;  // Default: false
  show_currency:                  boolean;  // Default: false
  show_artifact_hash:             boolean;  // Default: false
}
```

A field whose flag is `false` or absent is written to the projection as `null`, and its name is appended to `redacted_fields`. The identity fields (Section 10.1) are always included and cannot be redacted.

### 10.3 Tier 3 Field Stripping

Tier 3 data never enters a projection. The relay builds a projection from the fixed field list of Section 10.1, never by copying the source PE, so no other PE field, and no balance, key, credential, telemetry or policy setting, can appear in it. The PE's free text appears only as `intent_text`, and only when the publisher sets `show_intent_text`.

Separately, the relay strips a fixed set of sensitive key names from every ordinary Commons response, regardless of authentication level. Router-level middleware wraps the JSON response of the Commons routes (`/v1/commons`, `routes/commons.ts`), the agent record routes (`routes/agent-record.ts`) and the reputation routes (`routes/reputation.ts`) in `stripTier3Fields`, which removes every key in the `TIER_3_FIELDS` set (`provian-backend/src/core/commons/publication.ts:49-69`) recursively. The guarantee holds as long as that key set stays complete: a sensitive value under a key not in the set would not be caught, which is why adding a new sensitive field requires extending `TIER_3_FIELDS` in the same change. The code set currently holds 16 field names, including `description` and `intent_text`. Because `intent_text` is in the set, a projection listed through a Commons route (a profile's published PEs, `GET /v1/commons/agent/:walletId/published-pes`) never carries it; the projection routes under `/v1/pe` (Section 10.6) do not run this pass, so `GET /v1/pe/projection/:id` returns the `intent_text` a publisher chose to show. The categories below are illustrative of that set:

| # | Field | Rationale |
|---|-------|-----------|
| 1 | `private_key` | Cryptographic key material |
| 2 | `secret` | Generic secret values |
| 3 | `api_key` | Service credentials |
| 4 | `session_token` | Active session identifiers |
| 5 | `connection_token` | Relay connection credentials |
| 6 | `wallet_balance` | Financial balances |
| 7 | `telemetry` | Device/agent telemetry data |
| 8 | `recovery_config` | Wallet recovery parameters |
| 9 | `credential` | Any stored credential material |

The projection signature (Section 10.1) covers six identity and publication values and none of the redactable fields, and no verifier recomputes it, so it plays no part in this guarantee.

### 10.4 Mutual Publication Consent

When a PE involves a counterparty (identified by `counterparty_address` on the source PE), the publisher cannot show it (`show_counterparty`, which publishes `counterparty_wallet_id`) without that party's explicit consent. The other redactable fields need no consent. The protocol enforces this via a structured consent flow:

**Step 1: Request consent.**
The publisher calls `POST /v1/pe/request-consent` with the PE identifier (`pe_id`), the PE itself (`pe`) and its inclusion proof (`inclusion`), the desired redaction config, and the institution context. The relay proves the PE and that the caller owns it exactly as at publication (Section 10.5, steps 2 and 3). It reads the counterparty from the proven PE's `counterparty_address` and resolves it to the agent wallet registered at that address. A PE with no counterparty is refused (`400`, consent not needed), and so is a counterparty the relay cannot resolve to an agent wallet (`400 Counterparty not found in the network`). The answer (`201`) is the consent request, which expires after **7 days**.

**Step 2: Counterparties review.**
Counterparties retrieve pending consent requests via `GET /v1/pe/consent/pending`, which lists the unexpired requests still awaiting the caller's decision. Each request carries its `consent_id`, the relay's id for the PE, the requesting wallet, the redaction config the publisher asked for, the institution context, and its request and expiry times.

**Step 3: Counterparties respond.**
Each counterparty calls `PUT /v1/pe/consent/:consentId` with a decision of `approved` or `denied`. Only a party the request names may respond, once, and not after the request has expired (`400 Consent request has expired`).

**Step 4: Consent resolution.**
- If all counterparties approve, the publisher may show the counterparty.
- A denial, or a request that expired without an answer, never becomes an approval: the counterparty cannot be shown under that request.

**Step 5: Publication.**
The publisher calls `POST /v1/pe/publish-projection`. When the PE has a counterparty and `show_counterparty` is set, the relay checks the publisher's consent request for this PE before generating the projection, and refuses the whole publication with `400` when consent is not complete: `Mutual consent required to show counterparty. Use POST /v1/pe/request-consent first.` when no request exists, and `Not all parties have approved publication` when any party has not approved (pending, denied, or expired unanswered). Nothing is redacted silently. The publisher may publish again without `show_counterparty`, and `counterparty_wallet_id` is then `null` and listed in `redacted_fields`.

For single-party PEs (no `counterparty_address`), and for any publication that does not show the counterparty, the consent step is skipped. The publisher may publish immediately.

### 10.5 Relay Responsibilities

When processing a projection publication request, the relay performs the following operations in order:

1. **Check the publisher.** Apply the publication rate limit (10 per minute per wallet; `400` past it) and require a Commons profile (`403 Must be registered on the Commons to publish PEs`).
2. **Verify the presented PE.** The relay keeps no PE, so the publisher supplies the PE (`pe`, a `provian.pe.v2` object) and its inclusion proof (`inclusion`). The relay recomputes the PE's hash and proves it through its act record, its batch, and the day's anchored root on Base (Section 13); a proof that does not hold is refused `400 PE proof refused: <reason>`. `pe_id` must name the presented PE (its own `pe_id` or the relay's id for it). Set `original_pe_exists`.
3. **Verify ownership.** The anchored batch leaf commits to its actor; it must be the caller's wallet id or agent id (`403 Only the PE owner can publish it`). Set `chain_position_verified`.
4. **Enforce consent.** When the PE has a counterparty and `show_counterparty` is set, require the publisher's consent request for this PE with every party `approved`; otherwise refuse the publication with `400` (Section 10.4, step 5). Nothing is redacted silently.
5. **Refuse a second publication.** A PE already published is refused (`400 This PE is already published`).
6. **Apply redaction config.** Build the projection from its fixed field list (Sections 10.1 and 10.3). A field the publisher did not choose to show is `null` and named in `redacted_fields`. The attestation tier is the one verified from the output trust row or supplied owner proof, else `software`.
7. **Compute projection signature.** Serialize the signing content (the relay's id for the PE, `pe_hash`, `published_by`, `redacted_fields`, `institution`, and the publication time in ms) with keys in lexicographic order, no extra whitespace. Compute SHA-256 of the UTF-8 bytes. Store as lowercase hex.
8. **Persist and return.** Store the projection under the relay's id for the PE, with the hash-only on-chain half of the inclusion proof (`anchor_proof`), never the PE. Increment the publisher's published-PE count, seal a `commons_pe_published` PE, and return `201` with the public form of the projection (aliased identity fields, Section 10.1).

### 10.6 Protocol Endpoints

All projection and consent endpoints are served under `/v1/pe/`. They are protocol-level operations, not bound to any specific institution or application layer. "Wallet or Agent" means wallet auth, an agent API key, or a Commons session token.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/v1/pe/publish-projection` | Wallet or Agent | Publish a projection for a PE the caller owns. Body: `pe_id`, `pe`, `inclusion`, `redaction_config`, `institution`. Relay proves the PE, enforces consent, computes the signature, stores only the projection, and answers `201` with its public form. |
| `GET` | `/v1/pe/projection/:peId` | None | Retrieve a published projection by its opaque projection ID (`projection_` + 64 hex). Returns `{ projection, verified }` (Section 10.7). Returns `404` for an ID of any other form or with no projection. |
| `POST` | `/v1/pe/unpublish-projection` | Wallet or Agent | Retract a projection. Body: `{ pe_id }`, the relay's id for the PE or its projection ID, carried in the authenticated body rather than the URL. Only the original publisher may retract (`403`). The source PE is unaffected. Answers `{ status: "unpublished" }`. |
| `DELETE` | `/v1/pe/projection/:peId` | Wallet or Agent | The same retraction, by projection ID in the path. |
| `POST` | `/v1/pe/request-consent` | Wallet or Agent | Request publication consent from the counterparty of a PE the caller owns. Body: `pe_id`, `pe`, `inclusion`, `redaction_config`, `institution`. Answers `201` with the consent request. |
| `PUT` | `/v1/pe/consent/:consentId` | Wallet or Agent | Respond to a consent request. Body includes `decision` (`approved` or `denied`). Only the identified counterparty may respond, once, before the request expires. |
| `GET` | `/v1/pe/consent/pending` | Wallet or Agent | List the unexpired consent requests awaiting the caller's decision (`{ consents }`). |

### 10.7 Conformance Note

Projection verification is live. `GET /v1/pe/projection/:peId` returns the public projection with `verified`. The relay keeps no PE to compare against, so `verified` is `true` only when the projection's stored `anchor_proof` still holds: `keccak256(0x00 || batch_leaf)` equals `leaf_value`, and `PEAnchor.verifyPE(batch_id, leaf_value, merkle_proof)` returns `true` on Base. A projection with no anchor proof (one published before the meter), or an anchor contract the relay cannot read, answers `false`, never an assumed `true`. Anyone can repeat the on-chain check from the returned `anchor_proof` with a Base RPC (Section 13.7). The first hop (the PE's act record in its batch) was checked when the PE was published (Section 10.5); `projection_signature` takes no part in verification.

The conformance validator at `POST /v1/pe/conformance/validate` validates PE structure as defined in Section 2; it does not check projections.

---

## 11. Open Source Participation

The PE protocol is open. You do not need permission to build a PE-generating agent. You need:

1. A Provian wallet: a person's, created in the mobile app, or an agent's own, created with the SDK (`POST /v1/agent/wallet/create`)
2. A device signing key registered with the relay (see External Device Integration Guide)
3. An implementation of this spec that produces valid PE JSON
4. A store for its own PEs, and the ability to POST signed batches to `api.provian.ai/v1/meter/batch`

PEs from external devices that generate real compute work - mining rigs, GPU inference clusters, IoT sensors, home servers - are first-class citizens of the network. Their proof-of-work PEs mint PVT once at the work's best-supported value under the same protocol rules as wallet-native PEs; the attestation tier supports that value.

A sensor connects one of two ways (Section 3a): a hardware-attested device submits on the sovereign lane (`POST /v1/pe/submit-sovereign`, an agent wallet's EIP-191 binding plus an admitted `hardware_witness` chained to its scheme's pinned root), or the sensor reports through a registered machine whose owner runs an SDK observer with a plugin for it (the gateway path). The daemon the one-command setup installs witnesses the machine's own work and loads no sensor plugin. Three more witnesses reach a sensor's work with no observer plugin and no daemon: a payment for its readings (the chain watchers read its on-chain settlement; the owner's `receive` mints only from a counterparty the owner has dealt with — an earlier send or x402 payment to the payer, a shared escrow or a shared job — and a first payment from a stranger records without minting), a counterparty's witnessed PE citing an output its machine signed (`Provian-Output-Signature`, Section 2.2, which counts toward the owner's Consumption and pays nothing), and a hardware root on the sensor itself, which reaches the relay through the sovereign lane. See the External Device Integration Guide, Section 11b.

The Foundation treasury receives the kernel’s Foundation share in the settlement transaction. Its human and Genesis floor is immutable; the Network Constitution describes the human-participation purpose.

Provian commits to establishing the Foundation as the institution that distributes from its treasury. That commitment includes membership for verified people and unique-human verification, which will establish that each member is one distinct person. The Network Dividend is Provian’s commitment to distributions from that treasury to verified human members.

**Compute mints money. No one gets left behind.**

---

## 12. Jurisdiction Policy

The relay maintains a jurisdiction policy table that determines how PEs from each jurisdiction are processed. This table is not part of the PE envelope format. During bootstrap, changes require an authorized prospective policy event from Provian's direct authority, signed through its bootstrap wallet. A governance vote gains that authority only after separate explicit activation or handoff approval; changing jurisdiction policy does not change the PE format or smart contracts.

### 12.1 Policy States

| State | PE Acceptance | Minting | Use Case |
|-------|--------------|---------|----------|
| `immediate` | Accepted | PEs enter minting pipeline normally | Most jurisdictions |
| `deferred` | Accepted | PEs are valid but minting is deferred until jurisdiction opens | Jurisdictions that prohibit domestic token generation (e.g., mainland China) |
| `blocked` | Accepted with restrictions | PEs remain valid and are held without minting until the policy block is lifted | Jurisdictions the table marks as closed to any PVT flow |

### 12.2 What Deferred Means

A deferred PE is a fully valid Provenance Envelope. It has the same hash chain integrity, the same attestation tier, the same provenance value, and the same reputation impact as any other PE. The only difference is that it does not trigger PVT minting.

Deferred PEs:
- **Are accepted** by the relay and validated normally
- **Are hash-chained** into the actor's PE chain with full integrity
- **Are attestation-scored** at the appropriate tier (software, hardware, corroborated, etc.)
- **Build reputation** for the actor in the Commons Registry and Court eligibility
- **Can be published** as PE Public Projections with the same consent and privacy rules
- **Can be corroborated** - corroboration signals are processed and recorded normally
- **Accumulate minting eligibility** - the `deferred_since` timestamp records when deferral began

Deferred PEs do NOT:
- Trigger any PVT minting
- Create any claim on future PVT - minting is not a financial instrument
- Guarantee that minting will ever be activated for their jurisdiction
- Receive any different treatment in the hash chain or attestation system

### 12.3 Jurisdiction Activation (Graduated Release)

If and when a jurisdiction's policy changes from `deferred` to `immediate`, accumulated PEs enter the minting pipeline only through a graduated release process authorized by a prospective policy event. During the kernel's bootstrap period Provian Technologies, LLC remains the sole direct, non-gated economic-policy setter, signing through its bootstrap wallet. A governance proposal may become the authorizing event only after Provian separately approves the authority table and an activation or handoff. The policy event must specify:

1. **Jurisdiction code** - which jurisdiction is being activated
2. **Release schedule** - the configured `daily_ceiling_percent` applied to the recent PE-count/day average calculated from up to the latest 100 `pvt_mint_batches`; the code specifies no universal 15% ceiling
3. **No age-based adjustment** - a released PE is priced exactly as it was recorded; time spent deferred never reduces it (see Section 12.4)
4. **Re-attestation requirement** - whether deferred PEs must pass a lightweight re-validation before minting

No 7-day vote, 30-day delay, executor, Safe, or timelock process is approved for the kernel. Any later governance process must be separately approved before it can replace the bootstrap EOA's direct authority.

### 12.4 No Vintage Decay (Deferred PEs)

**Earned value does not shrink with time.** A PE deferred by a jurisdiction
policy the contributor does not control, and cannot shorten, is released at exactly the value it was
recorded with. Deferred PEs enter the same settlement pipeline as any other (mint rate, in-contract
per-epoch issuance ceilings, differential Foundation rate) with **no age adjustment of any kind**.
Parity minting has no lifetime-supply indexing: the kernel consumes sealed record points directly.

`deferred_since` is still recorded, as audit evidence of when deferral began. It no longer prices
anything. Anti-fraud belongs in what QUALIFIES to mint, never in how much a qualified act pays.

Provian does not make any representation about the future value, timing, or certainty of deferred
minting. Deferred PEs represent verified work, not a claim on future tokens. Jurisdiction policy
changes are determined by sovereign governments, not by Provian Technologies or the Foundation.

### 12.5 Blocked Jurisdictions

PEs from a jurisdiction the table marks `blocked` remain contributor-owned provenance proof. The relay holds otherwise-ready acts as `pending_compliance`, with reason `jurisdiction_blocked`, without minting while the block stands. When that jurisdiction’s block is lifted in `jurisdiction_policy`, the automatic recovery processor releases held acts at their original sealed value into ordinary settlement. A change to `deferred` retains the authorized graduated release path. No age adjustment or repricing applies. Existing jurisdiction-blocked terminal projections move into this held state; sealed PEs and economic snapshots remain unchanged. SDN address hits remain terminal `ineligible` and are never reopened by a jurisdiction policy change. The relay derives country and region from each wallet’s own authenticated request-IP sessions; submitters do not assign mint status.

### 12.6 Policy Table

The jurisdiction policy table is relay-side state (Firestore-backed, `provian-backend/src/core/jurisdiction/jurisdiction-policy.ts`), keyed by ISO 3166-1 alpha-2 code with a default of `immediate`. The relay applies the table at record time and reports the outcome in the batch receipt and relay economic projection — `mint_status` (`eligible` / `deferred` / `pending_compliance` / `ineligible`) and `jurisdiction_context` — so a submitter learns its jurisdiction's treatment from that receipt. The complete internal projection can retain jurisdiction context beyond the receipt summary. Provian does not make representations about future jurisdiction policy changes; the table reflects current law as understood by Provian Technologies.

---

## 13. Daily On-Chain Anchoring (anchor-everything)

> **STATUS: ACTIVE.** The daily anchor runs over every batch the relay accepts,
> signing against the deployed `ProvianPEAnchor` on Base; each device fetches its
> batches' inclusion proofs from `GET /v1/meter/proofs` (the app:
> `GET /v1/meter/mobile/proofs`), and `POST /v1/pe/verify` answers real on-chain
> checks. If the anchor env is ever unconfigured, verification fails closed
> (`503 PVT9_UNCONFIGURED` / `anchor_runtime_unconfigured`) rather than
> fabricating a verdict.
>
> Independently checkable regardless of anchoring state: the PE hash chain itself —
> every PE carries `prev_hash` (Section 6), and its owner holds the chain.

The design: every accepted batch — and through it every act, not just the acts that mint — is anchored against Base. Once per closed UTC day, the relay builds a Merkle tree over that day's accepted batch leaves and anchors the root in the `ProvianPEAnchor` contract. Anyone holding a PE can thereafter prove its existence and content hash from public chain data alone, with zero trust in the Provian API. Minted PVT and the on-chain root are permanent; proving a specific act later requires keeping its PE.

Daily anchoring is a receipt mechanism. It is orthogonal to minting: anchoring an act does not make it eligible, mint PVT, or change any economic status.

### 13.1 Leaf Rule

An act is proven in two hops. Its **act leaf** sits in its batch's `acts_root` (Section 7); the batch's **batch leaf** sits in the day's anchored root:

```
batch_leaf = sha256( utf8("provian.meter.batch-leaf.v1\n") || canonical({ actor_id, acts_root, batch_hash, device_id, seq }) )
leaf       = keccak256( 0x00 || bytes32(batch_leaf) )
```

- `batch_leaf` commits to the device, the actor, the sequence number, the batch hash and the root of its acts; it is returned in the batch receipt.
- `0x00` — a single leaf-domain prefix byte required by the on-chain verifier. Leaves (`0x00`) and internal nodes (`0x01`) occupy disjoint hash spaces, foreclosing second-preimage attacks where an internal node is presented as a leaf.
- `||` — raw byte concatenation (33 bytes total); `keccak256` over those bytes.

### 13.2 Leaf Ordering

Leaves are ordered by **(`accepted_at_ms` ascending, then `batch_hash` ascending)**. A leaf's position under this order is its `leaf_index`. The tree pads the leaf layer to the next power of two with `keccak256(0x)` zero-leaves.

### 13.3 Internal Nodes and Root

Internal nodes hash sorted pairs (identical to mint-batch anchoring and to on-chain `verifyPE`):

```
parent = keccak256( 0x01 || min(left, right) || max(left, right) )
```

Because pairs are sorted at every level, an inclusion proof is just the array of sibling hashes bottom-up — no left/right direction flags.

### 13.4 Batch Identity and Namespace

```
batch_id = keccak256( 0xFF || utf8("provian:daily-pe-anchor:v1:meter:<YYYY-MM-DD>") )
```

- The `meter` kind keeps the meter's day anchors apart from the per-PE `day` / `backfill` anchors written before the meter, so the two can never collide.
- Daily anchors share the PEAnchor `batches` mapping with PVT mint-batch anchors. Mint batch ids are `keccak256(utf8(sortedPeIds.join(',') + ':' + merkleRoot))` — a hash over pure UTF-8 bytes. The `0xFF` prefix byte can never appear in valid UTF-8, so no mint batch input, however adversarial, can share a preimage with a daily anchor id.
- The contract refuses to overwrite an existing batch (`BatchAlreadyAnchored`), so even a hypothetical id collision could only deny one batch, never replace a root.

The `anchorBatch` call carries `peCount` = leaf count (pre-padding), `timestamp` = the anchored day's end boundary (Unix ms), and `epochNumber` = the UTC day number (`floor(dayStartMs / 86_400_000)`) — self-describing, unrelated to PVT epochs.

### 13.5 Membership and Completeness

A day's anchor contains every batch the relay accepted during that UTC day that no segment (below) already anchored. A day is anchored once it has been closed for ten minutes; a re-run of an anchored day changes nothing, and a day over 1,000,000 batches is refused loudly rather than truncated. Days with no batches anchor nothing. An act accepted today is provable after the next daily run — or the moment an anchor segment lands.

**Anchor segments (2026-10-10).** An operator may anchor the OPEN day's accepted-but-unanchored batches at once (`POST /v1/internal/scheduler/meter-anchor-now`, scheduler auth, never on a schedule). The segment's batch id is `keccak256(0xFF || utf8("provian:daily-pe-anchor:v1:meter:<YYYY-MM-DD>:<n>"))` with `n ≥ 1` counting the day's segments; every batch it covers gets its proof with `anchor.segment = n`, and each verifier (relay, SDK, app, archive confirm) derives the on-chain batch id from `(day, segment)` — a segment proof presented without its segment resolves to the day id and is not anchored. The day's close then commits only the batches no segment took, under the plain day id. A batch is anchored exactly once.

### 13.6 Proofs

```
GET https://api.provian.ai/v1/meter/proofs          (device auth)
GET https://api.provian.ai/v1/meter/mobile/proofs   (wallet auth)
```

Each batch record remains until settlement, anchoring and sealed-copy delivery complete, then carries its proof for another 30 days for its device to fetch and keep with its PEs:

```json
{
  "chain_id": 8453,
  "anchor_contract": "0x…",
  "seq": 42,
  "batch_hash": "…",
  "batch_leaf": "…",
  "acts_root": "…",
  "actor_id": "…",
  "anchor": {
    "day": "2026-10-03",
    "anchor_batch_id": "0x…",
    "leaf_index": 7,
    "leaf_count": 19,
    "leaf_hash": "0x… (keccak256(0x00 || batch_leaf))",
    "proof": ["0x…", "…"],
    "merkle_root": "0x…",
    "anchor_tx_hash": "0x…",
    "anchored_at_ms": 1791000000000
  }
}
```

The device builds the first hop itself: the act leaf's path to `acts_root` from the batch's own acts (`merkleProofOf`). `GET /v1/pe/{pe_id}/proof` and `GET /v1/pe/export/{wallet_id}` answer `410 pe_kept_by_owner`: the relay keeps no PE to prove.

A PE sealed to another party (a linked agent's PE sealed to its human, a relay-authored PE sealed to its owner) arrives without this proof. Its recipient reads the batch's anchoring record with `POST /v1/meter/batch-proofs` (device auth) or `POST /v1/meter/mobile/batch-proofs` (wallet auth). The body is `{ "batch_hashes": [ … ] }`, and the answer holds the identity, `batch_leaf`, the anchor proof and the batch's `act_leaves`. The recipient keeps that record with the PE. The relay's batch record expires 30 days after settlement, anchoring and sealed-copy delivery complete.

A relay-authored PE the relay hands its owner directly (the first PE of a new wallet) comes with no batch hash. A relay-authored batch holds exactly one act, so its `acts_root` is the root of a one-leaf tree over the PE's own act leaf, which the owner computes. The owner asks by that root: `{ "acts_roots": [ … ] }`, answered only from one-act batches of a `relay:` device; roots with no such batch come back in `missing_acts_roots`. One request carries at most 200 hashes and roots in all.

An owner exports every PE it holds, each with this proof, as one `provian.pe-export.v1` file (Section 14).

### 13.7 Independent Verification (zero API trust)

Everything the endpoint returns is checkable against public data:

1. **Recompute the PE hash** from the PE (Section 6), and its act record and act leaf (Section 7).
2. **Walk the first hop**: the act leaf's path must fold to `acts_root` (`verifyActInclusion` in `meter-wire.ts`).
3. **Recompute the batch leaf** from `{ actor_id, acts_root, batch_hash, device_id, seq }` (Section 13.1), and the on-chain leaf `keccak256(0x00 || bytes32(batch_leaf))`; it must equal `anchor.leaf_hash`.
4. **Walk the second hop**: fold `anchor.proof` over the leaf with the Section 13.3 pair rule; the result must equal `anchor.merkle_root`.
5. **Check the chain**: `ProvianPEAnchor.getBatch(anchor_batch_id).merkleRoot` (on Base, via any RPC or BaseScan) must equal `anchor.merkle_root`, and `ProvianPEAnchor.verifyPE(anchor_batch_id, leaf_hash, proof)` must return `true`. Optionally recompute `anchor_batch_id` per Section 13.4.

`verifyActInclusion` in `meter-wire.ts` (shipped in the SDK and the app) runs steps 1 and 2 and returns the recomputed `batch_leaf`, the first half of step 3; computing `keccak256(0x00 || bytes32(batch_leaf))` and comparing it with `anchor.leaf_hash` is left to the caller. That comparison is local, and steps 4–5 need only a Base RPC, never the Provian API. The repository's standalone `scripts/verify-pe-proof.ts` verifies the per-PE proof bundles of PEs anchored before the meter.

## 14. PE Export (`provian.pe-export.v1`)

A PE export is everything one owner holds, written to one file, in a form anyone can verify
without Provian. A person makes one in the app: Settings → Storage → **Export all my PEs**. An
agent makes one from its shell: `provian export-pes` (or `provian pes export` with the CLI). Either
way it is one action, and the file contains:

- every PE of the owner's own device chains, whether still on the device or pulled back from the
  paid PE Archive;
- every batch those chains were sent in, with the relay's receipt and the batch's anchor proof;
- every PE another party sealed to the owner: a linked agent's PEs, PEs from the owner's other
  devices, and PEs the relay recorded for the owner. Before writing the file, the producer drains
  the relay mailbox, so the sealed PEs it had not filed yet are included;
- every legacy (pre-meter) activity record the owner holds.

Which lines carry an anchor:
- an **anchored** metered PE carries its two-hop inclusion proof, from the PE to the day root
  written on Base in Provian's PEAnchor contract;
- a **pending** metered PE (one not yet in an anchored day root) carries no anchor until the file
  is exported again after the next daily anchor;
- a **legacy** (pre-meter) record carries no anchor and is checked against its own hash only.

To check the anchors you need the file and any Base RPC endpoint; no Provian server is involved.
Whatever the producer holds and could not include is named in the file's `end` line, and a file
that names anything is never verified as a clean `ok` (§14.5).

The executable definition is `pe-export-wire.ts`. It is byte-identical in the SDK
(`provian-agent-sdk/src/pe-export-wire.ts`) and the app (`src/core/meter/pe-export-wire.ts`), and
`scripts/check-pe-export-wire-parity.sh` refuses any drift. Where this section and that file differ,
the file wins.

### 14.1 The file

- **Encoding:** newline-delimited JSON, UTF-8. One record per line, each line ending in `\n`.
- **Canonical form:** every line is the record's canonical JSON. Object keys are sorted by UTF-16
  code unit, there is no whitespace, and `undefined` members are omitted. This is `canonicalJson`
  in `meter-wire.ts`. A line that is not in canonical form is refused.
- **Order:**
  1. one `header` line;
  2. the `pe` lines (each device chain in index order);
  3. the `batch` lines;
  4. the `received` lines;
  5. the `legacy` lines;
  6. one `end` line.
- **Running hash:** start with `c₀ = sha256hex("provian.pe-export.v1")`. Then for each line before
  the `end` line, `cᵢ = sha256hex(cᵢ₋₁ + "\n" + lineᵢ)`, where `lineᵢ` is taken without its
  newline. The `end` line carries the final value as `chain`, and the number of lines before it as
  `lines`. An edited, re-ordered or truncated file fails this check.
- **File name:** `provian-pe-export-<owner>-<UTC timestamp>.jsonl`.

### 14.2 Records

#### `header`

| field | meaning |
|---|---|
| `schema` | `provian.pe-export.v1` |
| `spec` | where this specification is published (`https://provian.ai/docs-md/pe-protocol-spec.md`, Section 14) |
| `exported_at_ms` | when the export was made |
| `producer` | `{kind: "app" \| "sdk", version}` |
| `owner` | `{kind: "human" \| "agent", wallet_id, address}` |
| `anchor` | the anchoring rules: chain id `8453`, contract `0x889A59A847e490c5Cc91f281468AbAacc100a9fD`, the `getBatch` signature, and the batch-id, leaf and node rules below |
| `devices` | every device chain held where the export was made, this device first |
| `archive` | `{state: "on" \| "off" \| "unknown", days: [{wallet, day, pulled, reason}]}`: every Archive day the owner can open, and whether it was pulled into this file |

#### `pe`: a PE of the owner's own chains

| field | meaning |
|---|---|
| `source` | `device` (held on the device) or `archive` (pulled back from the PE Archive) |
| `device_id`, `index` | the chain, and the PE's 0-based position in it |
| `pe` | the complete PE v2, including `pe_hash` and its original `signature` when present. A device P-256 signature is not universal; the verifier checks the PE hash and anchored inclusion. |
| `detail` | app exports only: the phone's full private record of the act (amounts, terms, recipients). The PE commits to it through `pe.detail_hash`. |
| `status` | `anchored`, or why the PE has no complete proof yet: `not_batched_yet`, `not_anchored_yet`, `batch_composition_unknown`, `acts_root_mismatch`, `proof_unavailable` |
| `inclusion` | the inclusion proof (below), or `null` |

#### `batch`: one batch the relay accepted from one of the owner's devices

The record carries the batch identity (`device_id`, `seq`, `batch_hash`, `prev_batch_hash`,
`acts_root`, `actor_id`), the range of PEs it carried (`first_index`, `count`, `last_pe_hash`), and
its timestamps. It also carries:

- `batch_leaf`;
- `receipt`: the relay's receipt for the batch, verbatim, with the per-act disposition and record
  points;
- `anchor`: the batch leaf's keccak path to its day root:
  `{day, anchor_batch_id, leaf_index, leaf_count, leaf_hash, proof, merkle_root, tx_hash}`.

An `adopted` batch has no per-batch receipt. Such a range was adopted from the relay's tip after a
lost local write.

#### `received`: a PE another party sealed to the owner

| field | meaning |
|---|---|
| `source` | `device` (filed from the mailbox) or `archive` (pulled back from a linked agent's Archive) |
| `mailbox_id`, `from_actor`, `from_device`, `batch_hash`, `received_at_ms` | where it came from |
| `pe`, `status`, `inclusion` | as for `pe` |

#### `legacy`: a pre-meter record, verbatim

| field | meaning |
|---|---|
| `source` | `device_history` (the app's own activity record) or `handed_back` (the relay's copy, handed back to its owner at the meter cutover) |
| `id`, `record` | the record |
| `hash` | the record's own hash. For `device_history` this is the sha256 of its canonical JSON minus `signature`, the value its successor's `prev_envelope_hash` links to. For `handed_back` it is the record's `hash` field, which the relay computed with its writer's recipe (below) and which the next record's `prev_hash` links to. |
| `status` | `pre_meter`: the record was never in a meter batch. Before the meter, the relay anchored stored PEs one by one in a different daily tree, and those trees' leaf sets were deleted with the rest of the pre-meter data. No inclusion path can be rebuilt for a pre-meter record by anyone, so these lines are checked against their own hash only. `not_yet_metered`: a current record the device has not built its PE for yet. |

##### Checking a handed-back record's hash

The pre-meter relay hashed each record as `sha256(canonicalJson(content))`, where `content` is a
fixed set of the record's own fields. The set depends on the writer, which the record names in
`integration_source`. The stored record also carries storage fields that were never hashed
(`user_id` where not listed, `policy_action_type`, `durability`, `created_at`, …). A field absent
from the record is absent from `content`.

| writer (`integration_source`) | hashed fields |
|---|---|
| `device_pe_submit` | `id wallet_id action_type actor_address timestamp prev_hash attestation_type description intent_text metadata compute geo execution_env cited_pe_ids parent_goal_pe_id input_origins output_digests` |
| `agent_bank_generate_pe` (also the agent's first PEs, which carry no `integration_source`) | `id wallet_id agent_id action_type actor_address timestamp prev_hash attestation_type metadata compute geo execution_env cited_pe_ids parent_goal_pe_id input_origins output_digests` |
| `mobile_pe_submit` | `id wallet_id user_id action_type actor_address timestamp prev_hash attestation_type description metadata compute geo execution_env cited_pe_ids parent_goal_pe_id input_origins output_digests` |
| `human_wallet_registration` | `id wallet_id user_id action_type actor_address timestamp prev_hash attestation_type metadata` |
| `device_registration`, `device_revocation` | `id wallet_id action_type actor_address timestamp prev_hash attestation_type metadata` |
| `delegation_pe` | `id user_id action_type actor_address timestamp prev_hash attestation_type intent_text chain_id asset_symbol amount counterparty_address counterparty_type device_attestation_id policy_decision risk_score risk_category null_state_flags metadata` |
| `relay_work_product` | `id product_type artifact_hash created_at` |

A verifier tries the record's own writer first, then the others (`preMeterRecipeOf`). A record no
recipe reproduces is reported as unverifiable, never as checked. This happens when a field the
writer hashed was not kept on the stored record.

#### `end`

`{lines, chain, counts: {pe, batch, received, legacy}, incomplete: [{what, reason}]}`.
`incomplete` names anything the owner holds that the producer could not include in full, and why.
It is empty for a complete export. A producer never leaves something out silently. It names at
least:
- an Archive day that could not be pulled, and each PE or proof it could not include;
- mailbox items still waiting on the relay after its drain (no key where the export ran, an item
  that does not open, the relay unreachable), by count. A producer that did not check the mailbox
  says so (`mailbox_not_checked`);
- a handed-back record that is no longer held where the export ran (`not_held_on_this_phone`);
- for an agent export, the chains recorded on other machines. Another machine's chain reaches the
  file only through the PE Archive (`only_this_machine` when the Archive was not pulled). When the
  Archive was pulled, that machine's PEs since its last Archive day are named
  (`kept_on_that_machine`).

### 14.3 The inclusion proof

```
{ act_index, act_proof[], acts_root,
  batch: { device_id, actor_id, seq, batch_hash },
  anchor: { chain_id, contract, anchor_batch_id, day, segment?, leaf_index, proof[], merkle_root, tx_hash } }
```

`act_proof` and `acts_root` are sha256 hex. `anchor.proof`, `merkle_root` and `anchor_batch_id`
are 0x-prefixed keccak-256 hex.

### 14.4 Verifying a PE against its on-chain anchor

All hashes are over UTF-8 bytes. "‖" is byte concatenation.

1. **The PE's own hash.** Compute `pe_hash = sha256(canonicalJson(pe without pe_hash, signature))`.
   It must equal `pe.pe_hash`.
2. **The private detail (app exports).** If a `detail` is present, compute
   `sha256(canonicalJson(detail without signature))` (when `pe.detail_commitment` is
   `provian.detail-commitment.v1`, `sha256(pe.private_commitment + "\0" + that digest)`). It must
   equal `pe.detail_hash`.
3. **The act record, and its path to `acts_root`.** The act record is `{pe_id, pe_hash, prev_hash,
   timestamp, action_type, pricing}`. When the PE carries `private_pricing`, `pricing` is exactly
   `{private_pricing}` plus `hardware_witness` and `detail_hash` where present; otherwise it is the
   PE minus `schema`, `pe_id`, `device_id`, `prev_hash`, `timestamp`, `action_type`, `pe_hash`,
   `signature`, `description`, `intent_text`, `private_commitment`, `private_owner_view` and
   `detail_commitment`.
   - Act leaf: `sha256("provian.meter.act.v1\n" ‖ canonicalJson(act))`.
   - The Merkle node of a leaf is `sha256(0x00 ‖ leaf)`. An internal node is
     `sha256(0x01 ‖ min(a,b) ‖ max(a,b))`. The tree is padded to a power of two with
     `sha256("")`.
   - Folding the act leaf's node up `act_proof` must give `acts_root`.
4. **The batch leaf.** Compute
   `sha256("provian.meter.batch-leaf.v1\n" ‖ canonicalJson({actor_id, acts_root, batch_hash, device_id, seq}))`.
5. **The day root.**
   - The on-chain leaf is `keccak256(0x00 ‖ batch_leaf)`.
   - Fold it up `anchor.proof` with `keccak256(0x01 ‖ min(a,b) ‖ max(a,b))` at each level. The
     result must equal `anchor.merkle_root`.
   - `anchor.anchor_batch_id` must equal
     `keccak256(0xff ‖ utf8("provian:daily-pe-anchor:v1:meter:" + anchor.day + suffix))`,
     where `suffix` is empty when `segment` is absent and `":" + anchor.segment` when present.
6. **On Base.**
   - Call `getBatch(anchor_batch_id)` on PEAnchor `0x889A59A847e490c5Cc91f281468AbAacc100a9fD`,
     chain 8453, through any RPC endpoint. It must return `exists = true` and
     `merkleRoot = anchor.merkle_root`.
   - Read only that contract. A proof that names a different contract or chain is refused.
   - `PEAnchor.verifyPE(anchor_batch_id, keccak256(0x00 ‖ batch_leaf), anchor.proof)` is the
     same check done on chain.

Every `batch` line is checked the same way:

- its `batch_leaf` must equal step 4 recomputed from its identity;
- its `anchor` must pass step 5 and its day root step 6;
- its `acts_root` must equal the root over the act leaves of the `pe` lines it carried
  (`first_index` … `first_index + count − 1`);
- its receipt's acts must name those same PEs, in that order.

Within each device chain, `pe` lines must link: index 0 has `prev_hash = "genesis"`, and every
later PE's `prev_hash` is its predecessor's `pe_hash`. A missing position is reported as a gap.

- A gap in a chain the header lists under `devices` means the export left out PEs that device
  holds.
- A gap in a chain known only from the Archive marks days that were never archived. Examples:
  another machine's chain from before the Archive was turned on, or a previous phone whose store
  was not restored.

A PE whose `status` is not `anchored` is reported as pending, never as verified. The daily anchor
(00:25 UTC) commits the batches of the UTC day that just closed. So a PE batched today is pending,
as is one batched yesterday until that anchor has run, and one not batched yet. A batched pending
PE carries its first hop (steps 1–4) and no `anchor`; an unbatched one carries no `inclusion`.
Export again after the next anchor to get its full proof. A pending line is never a failure and
never makes the file incomplete.

### 14.5 Verifying a file

With the SDK (`@provian/agent-sdk`, or the agent's installed runtime):

```bash
provian verify-export provian-pe-export-….jsonl --rpc-url https://mainnet.base.org
```

- It parses the file and checks the running hash, then checks every line offline.
- It then reads each distinct day root once from PEAnchor through the RPC you name, and contacts
  no other host.
- It prints counts per record type, every failure with its line number, every gap and every
  pending line. Legacy records are counted as `hash_checked` (their content reproduces their hash)
  or `hash_unverifiable`; all of them are `unanchorable`.
- With `--offline` it stops after the offline checks and lists the day roots to check on chain.
- It prints each `end.incomplete` entry under `missing`.

The verdict (`exportVerdictOf` in `pe-export-wire.ts`) is the same on every verifier, including
the app's own check of the file it has just written:

| verdict | meaning | exit |
|---|---|---|
| `ok` | every line verifies, no chain the header lists has a gap, every day root is on Base, and `end.incomplete` is empty | 0 |
| `incomplete` | the same, except `end.incomplete` names something the owner holds that the file does not carry | 3 |
| `offline_ok` | `ok` without the chain read (`--offline`) | 0 |
| `offline_incomplete` | `incomplete` without the chain read | 3 |
| `failed` | a parse error, a failing line, a gap in a chain the header lists, or a day root Base does not confirm | 1 |

A usage error exits 2. A file whose `end.incomplete` names anything is never `ok`: everything in
it is proven, but it is not everything the owner holds.

Any other implementation of the steps above works the same way. The format has no part that only
Provian can read.

### 14.6 Where each part comes from

| part | app (person) | SDK / daemon (agent) |
|---|---|---|
| own chains, batches, receipts, proofs | the phone's PE store, including restored chains of previous phones | every device store under `~/.provian/pe-store/` on this machine |
| Archive days | every own day plus every linked agent's day sealed to the person, pulled and opened on the phone with the person's key | every own day, pulled and opened with the agent's key |
| received PEs | the phone's mailbox files, after draining the relay mailbox for the export | `received.jsonl`, after draining the relay mailbox for the export (opened with the agent's key, where its keystore is on the machine) |
| proofs for received PEs | fetched daily once the day is anchored, and kept with the received row (a relay-authored PE handed over without a batch hash is found by its one-act `acts_root`) | fetched daily, kept in `received-proofs.jsonl` |
| legacy records | the phone's activity history and the handed-back records | `legacy.jsonl` |

The relay is used while an export is being **made**: it serves the mailbox and the Archive
objects (ciphertext only) and any batch proof not yet fetched. It is not needed to **verify** a
finished export.


### Private authenticated operations

Private approval descriptions, presentation tokens, bilateral thread messages and hashes, private job applications/deliverables, Archive parts and batch-proof lookups use `{ "private_request": <AES-256-GCM box> }` containing `{ "request": <the original logical body> }`. The context is `provian-private-request:v1:<original path>`, using the existing authenticated device, wallet, agent API or Commons session credential. Private mailbox cursors use the analogous `private_query` box. Original producer signatures, hardware binding nonces, hashes, claims and pricing inputs remain unchanged inside that boundary. The relay rejects clear override fields and authenticates the outer bytes before opening them.

A bare hardware-attested submitter encrypts its original signed submission as `private_relay_request` to the `/v1/present/privacy-key` capability derived from the existing relay presentation signing identity. TPM and cloud reports are verified facts and price at device tier without a daemon, unless their launch measurement is one the relay pins for a signed observer release (the measured observer), in which case they seal `hardware_rooted` exactly as App Attest does.

Public Commons PE projections retain the owner's five content disclosure choices and unchanged day-anchor proof. Public `pe_id`, `pe_hash`, previous commitment and projection reference are relay-secret aliases. Public lookup accepts only the opaque projection ID; original logical IDs remain internal and in owner-held proofs. A private candidate cannot be tested through a legacy public ID lookup. Existing aggregate on-chain anchors remain immutable.
