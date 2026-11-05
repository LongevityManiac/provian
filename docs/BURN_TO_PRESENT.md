# Burn-to-present — the trust mechanism

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

> This is the burn mechanism and the trust layer. It is not an incremental
> architecture change: it is the thing that lets one party be *believed* by another
> that has never met it, and the reason PVT is worth destroying. Burn-to-present is the
> **foundational burn**: any party asks, and the presenter burns once to produce a signed
> presentation bound to that requester. Most presentations happen at **gates outside
> Provian** — services, rails and counterparties that Provian does not run and that do
> not register with Provian. Provian proves the presentation is real; the gate decides
> what it grants and for how long, so an agent does not burn on every transaction: one
> presentation opens the relationship, and the gate decides when to ask again. **Agents
> are the primary path**, over the SDK, CLI and MCP; the human app is the symmetric
> on-device leg. Provian's own Commons talking pass and rail handshake are applications
> of the same primitive, under the settings Provian chooses for its own space and rail.

## The idea in one paragraph

To be trusted, you **burn PVT** to produce a **signed presentation** — a disclosure of
something true about you that a counterparty verifies itself, with no Provian account.
Burning is the skin in the game: it is irreversible and it costs, so a presentation is
never free noise. **The burn is single-use at issuance**: one burn backs exactly one
presentation, network-wide. **The presentation is bound to the requester, its challenge,
and the moment**: it names the requester's `audience` and the exact challenge nonce the
requester issued, and it **expires in minutes**. A presentation cannot be re-aimed at
another requester, another challenge, or a later moment. Verification itself is
stateless, so **the verifier accepts each presentation once** — Provian's SDK, CLI, and
MCP verifiers do this by default (see [The replay model](#the-replay-model)). Two things
can be presented:

- **PE fact** — Provenance Envelopes you own, carried with their on-chain anchor
  inclusion proofs and the **required Provian co-signature** (Provian attests the burn
  and your ownership of the PEs, which the chain cannot show). The counterparty checks
  the presenter signature, the co-signature against the public JWKS, and the anchor
  proofs against Base. Fee: **5 PVT**.
- **Reputation** — facts from your live record, computed and signed by Provian at
  issuance as a compact EdDSA JWS that anyone verifies against the public JWKS. It
  answers the requester's **predicates**; other facts are disclosed by default and may be
  explicitly redacted, except Standing, which is always present and non-redactable. Fee:
  **15 PVT**.

Both fees are config-driven (the `burn_floor_policy` overrides, no redeploy, no
arming gate) and are floors, not exact charges — which is what lets a rail
commitment *fold* onto the same burn (below). A presenter learns the effective
per-tier floor before it burns from the public read
`GET /v1/present/floor?tier=<pe_fact|reputation>` (SDK
`institutions.presentationFloorAtomic(tier)`), so it burns exactly the fee and never wastes
real PVT on an under-burn the relay would reject after the on-chain burn is
irreversible.

## The counterparty loop

1. **The requester issues a challenge** — a fresh nonce bound to its own id
   (`audience`), optionally naming **predicates** (the questions it wants answered) and
   the one **presenter** it is asking. The challenge is **signed**, so the presenter
   can see who is asking before it burns (see [Signed challenges](#signed-challenges-and-requester-identity)).
   The requester keeps the challenge and hands a copy to the presenter over any channel
   it likes — an API response, a chat message, an email, a QR code, a Commons thread.
   The requester never burns and needs no Provian account.
2. **The presenter checks who is asking** — every Provian presenter surface verifies a
   signed challenge **before any burn** and shows the requester as VERIFIED, or shows an
   unsigned challenge as UNVERIFIED. A signed challenge that is invalid, expired, or
   addressed to a different presenter is refused, and nothing is burned.
3. **The presenter burns and presents** — it burns at least the tier floor, records the
   burn, signs the requester-bound binding with its own live key (ECDSA-SHA256 for an
   agent, EIP-191 for a human, biometric-gated on device), and calls its `/present`
   route with the challenge envelope. **The relay computes** every fact and every
   predicate result from the presenter's live history at that moment, Provian signs
   them, the burn is consumed, and the presenter receives a token.
4. **The requester verifies and accepts once** — against the exact challenge it issued:
   freshness, the requester binding, the challenge deadline, the addressed presenter,
   the presenter's live-key signature, the Provian signature for the tier, the anchor
   proofs for PE facts, and that every predicate it asked was answered. A valid
   presentation is then accepted **once** — a gate records the `presentation_id` and
   refuses it the second time. What the acceptance grants, and how long the gate trusts it
   before asking again, is the gate's own policy.

### The surfaces

| Role | SDK (`@provian/agent-sdk`) | CLI (`provian`) | MCP | Raw HTTP |
|---|---|---|---|---|
| Requester: issue | `issuePresentationChallenge({ requester, predicates, presenter? })` (pure, no account); `institutions.issuePresentationChallenge(...)` (relay-signed for an agent wallet) | `challenge` (`--domain --key-file` for no account); `requester-key` | `present_challenge` | `POST /v1/agent/wallet/:wallet_id/present/challenge`, `POST /v1/wallet/present/challenge`, or build the envelope yourself |
| Presenter: check | `verifyChallengeEnvelope`, `institutions.checkChallengeBeforeBurn` | `check-challenge` | `check_challenge` | — |
| Presenter: burn + present | `institutions.respondToChallenge(challenge, { privateKeyHex, rpcUrl, onRequester? })`, or `institutions.sendBurn` + `institutions.present({ burnTx })` (pipelined), or `institutions.recordBurn` + `institutions.present` | `respond`, `present` | `present` with `burn_tx_hash` (pipelined), or `record_burn` + `present` | `POST /v1/agent/wallet/:wallet_id/present`, `POST /v1/wallet/present` (with `burn` to pipeline) |
| Requester: verify | `verifyPresentationToken(token, { challenge, jwksUrl })` (accepts once) | `verify` (accepts once) | `verify_presentation` (accepts once) | `POST /v1/present/verify` (stateless) |

An actor reads its OWN live vocabulary with `GET /v1/agent/wallet/:id/vocabulary`
(`institutions.readVocabulary`, MCP `read_vocabulary`) or, for a human,
`GET /v1/wallet/vocabulary`. In the **human app**, "Present my credentials" is on your
own Commons profile and "Request a presentation" is on a counterparty's profile; the app
issues a relay-signed challenge naming your wallet, verifies a challenge before it
burns, and accepts each presentation once.

## Timing — from burn to benefit

**Acceptance at inclusion.** The relay accepts a burn once it is **mined in one Base block**:
two independent RPC providers must agree on the receipt and on its canonical block, and the two
lookups run in parallel. A pending (mempool) transaction is never accepted, and neither is one
replaced by a same-nonce transaction. Acceptance therefore lands about one Base block (~2 s)
after broadcast. The accepted burn is recorded `finality: "provisional"`, and from that moment it
buys its benefit — a presentation, a speech window, a challenge stake, a featured bid — and is
consumable exactly once, like any recorded burn.

Measured on Base mainnet against the deployed relay (2026-09-25). Each figure is wall-clock time
from the burner's call to the benefit being usable: `valid: true` for a presentation, a live
handshake for a talking pass, or the placement in the featured list for a bid.

| Burn | Time to benefit |
|---|---|
| Cold outside-gate presentation (domain requester, SDK-local verify) | 5.1 s |
| Thread presentation (answer a request inside a thread) | 3.5 s |
| Talking pass (`provian:commons`) | 2.6 s |
| Featured bid (15 PVT) | 3.3 s |

Everything Provian adds on top of inclusion is pipelined into it:

- **Broadcast, don't wait.** The burner broadcasts `burn(amount)` and moves on. The SDK prepares
  the transaction's nonce, fee and gas reads in parallel. The app and SDK do not wait for a
  receipt of their own.
- **One call, held until the burn is mined.** Hand the tx to the relay once. `POST …/present`
  accepts `burn: { tx_hash, amount_atomic, chain? }` beside `burn_id` (which must be
  `sha256("<chain>:<lowercase tx hash>")`); the relay records the burn and prepares the
  presentation **while** it waits for inclusion, then issues. For every other product,
  `POST …/burn/record` with `await_finality: true` holds the call until the burn is mined and
  accepted (at most 90 s), so a record sent right after broadcast is answered once, with the
  accepted burn. Both burn-record responses carry `finality: "provisional" | "final"`. Either
  call is idempotent: a dropped connection is simply re-sent. `tx_failed` means the burn reverted
  and burned nothing.

**The finality check runs on every accepted burn.** Right after acceptance the relay runs the
12-block Base economic finality check (`BASE_ECONOMIC_FINALITY_CONFIRMATIONS`, the two-leg
`verifyEvmPvtBurn` check) in-process, and a 5-minute sweep guarantees it for any burn the
in-process check did not finish. The burn then moves once to:

- **`final`** — it reached finality. A burn **re-included in a different block** after a reorg
  (the same transaction) is final too and keeps its benefit.
- **revoked** — it reverted, its receipt carries no matching PVT burn log, or a reorg provably
  dropped it and it was not re-included within 10 minutes. Every relay-held benefit it backs is revoked: the presentation record and anything it
  opened (a rail handshake, a talking pass, a thread opened on it); a featured bid; a name claim;
  a challenge stake; a vouch, pledge or subscription. A presentation request answered with it is
  marked `burn_revoked`, and speech made under a revoked talking pass is hidden or reversed and
  mints nothing. A revoked burn can never be recorded again (`burn_revoked`, 409).

A burn is revoked only on that evidence. An RPC error is never evidence against a burn: one not
yet provably final stays provisional, keeps its benefits, and is re-checked on every sweep; past
30 minutes it is marked stalled and raises an operator alarm until it finalizes.

Amounts, floors, requester binding, signed challenges, featured stacking and the speech-window
invariant (what a window mints stays strictly below the burn that opened it) apply to a
provisional burn exactly as to a final one. `POST /v1/present/verify` is stateless.

**The one accepted residual.** A presentation verifies offline against the public JWKS, so an
**outside-gate** presentation that a gate already verified before its burn was revoked
stands — the relay cannot reach a verdict it never stored. The exposure is one presentation, and
only on a Base sequencer reorg. Everything the relay itself holds is revoked.

From the SDK, `respondToChallenge`, `ensureRailHandshake({ burn: { rpcUrl } })` and
`ensureSpeechWindow({ burn: { rpcUrl } })` take the pipelined path by default;
`burnPvt` / `recordBurn({ awaitFinality: true })` do the same for the stake and bid products.
Passing `confirmations` to `burnPvt` or `respondToChallenge` makes the SDK wait for that many
receipt confirmations on the caller's own RPC before it records the burn.

## Signed challenges and requester identity

A challenge is a JSON **envelope** (`provian-challenge-v1`):

```json
{
  "v": 1,
  "audience": "gate.example.com",
  "challenge": "3c11cde65a8fa6fedaa9a498114f647d41a89105e30f470cf11b528b5593a5a3",
  "predicates": [
    { "field": "work.witnessed_90d", "op": "gte", "threshold": 25 },
    { "field": "standing.adverse_events", "op": "in", "set": [0] }
  ],
  "issuedAt": 1790000000,
  "expiresAt": 1790000900,
  "presenter": "0x8fd379246834eac74b8419ffda202cf8051f7a03",
  "requester": { "type": "domain", "id": "gate.example.com", "kid": "k1" },
  "sig": "<Ed25519 signature, base64url>"
}
```

`predicates` and `presenter` are optional. The `requester` block says who is asking,
and there are two kinds of requester identity:

- **Domain requester — no Provian account.** `requester.id` is a lowercase DNS
  hostname you control. You generate an Ed25519 key yourself (SDK `generateRequesterKey`, CLI
  `provian requester-key`) and publish its public half at
  `https://<id>/.well-known/provian-requester.json` as
  `{ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "k1" }] }`
  (SDK `requesterWellKnownDocument(...)`). To rotate, publish the new key beside the
  old one.
- **Wallet requester.** `requester.id` is a Provian wallet id and `requester.address`
  its EVM address. The **relay** signs the envelope with the Provian presentation key
  (the key in `GET /v1/present/jwks`) after it has authenticated that wallet, so the
  identity is a Provian-attested wallet id and address. Agents call
  `POST /v1/agent/wallet/:wallet_id/present/challenge` (agent API key); people call
  `POST /v1/wallet/present/challenge` (wallet auth). Body:
  `{ predicates?, ttl_seconds? (60..604800, default 900), presenter? }` → `{ challenge: <envelope> }`.
  Commons thread presentation requests and remote requests to a linked human carry a
  relay-signed envelope automatically.

Rules every verifier applies to a signed envelope:

- `audience` **must equal** `requester.id`, so the presentation's audience *is* the
  verified requester identity.
- The window `expiresAt − issuedAt` is 60 seconds to 7 days (defaults: 900 seconds on
  the SDK, CLI and relay issuers). Keep a gate's window short; the 7-day ceiling exists
  so a remote or thread request can stay open as long as its delivery.
- The signature is Ed25519 over one canonical string — nine `\n`-joined lines, no
  trailing newline:

  ```
  provian-challenge-v1
  aud=<audience>
  chal=<challenge>
  iat=<issuedAt>
  exp=<expiresAt>
  req=domain:<host>            (or  req=wallet:<wallet_id>:<lowercase address>)
  kid=<kid>
  presenter=<lowercase 0x address, or empty>
  predicates=<sha256 hex of the canonical predicate list JSON>
  ```

  The canonical predicate list sorts the predicates, gives each `in` set sorted and
  de-duplicated, and serializes `{field, op, threshold}` / `{field, op, set}`; an absent
  list hashes as `[]`. Any language with Ed25519 and SHA-256 can issue a domain
  challenge.

**Unsigned challenges still work.** A bare `{ audience, challenge, predicates? }` is
accepted everywhere, and presenter surfaces show it as **UNVERIFIED** — nothing proves
who issued it. A **signed** envelope that fails any check is never shown as anything: it
is refused. What a presenter surface does before burning:

| Verdict | Meaning | Presenter surface |
|---|---|---|
| `verified` | Signature valid, audience bound, not expired, addressed to this presenter (or to anyone) | Shows the requester identity; may present |
| `unverified` | Unsigned challenge | Shows "unverified"; may present |
| `invalid` | Signed, but a check failed (bad signature, unknown key, malformed, audience ≠ requester, key unreachable) | Refused, no burn |
| `expired` | Signed, past `expiresAt` | Refused, no burn |
| `not_addressed` | Signed, names a different presenter | Refused, no burn |

The relay re-verifies a signed envelope passed as `challenge_envelope` to `/present`
(fetching a domain requester's key through an SSRF-guarded https fetch) and then issues
a **v2 presentation**: the payload carries `requester` and `chal_exp`, the presenter's
binding (`provian-presentation-v2`) and Provian's signature both commit to them, and
every verifier enforces the signed deadline. When the signed challenge names
predicates, the relay refuses a disclosure that does not answer all of them — before the
burn is consumed.

Over raw HTTP the `/present` body still carries `audience` and `challenge` alongside
`challenge_envelope`, and the relay checks that they agree with the envelope
(`challenge_mismatch` otherwise). A signed-challenge `/present` is refused, with the burn
left unconsumed, as `challenge_expired`, `presenter_not_addressed` (403),
`challenge_signature_invalid`, `requester_key_unreachable` (502 — the domain's
well-known key could not be fetched), `challenge_predicates_missing` (the disclosure does
not answer every predicate the challenge asks), or `predicates_require_reputation_tier`
(a `pe_fact` presentation against a challenge that names predicates).

## Predicates — the wire grammar

A predicate is one of:

```json
{ "field": "<vocabulary field>", "op": "gte" | "gt" | "lte" | "lt" | "eq", "threshold": <finite number> }
{ "field": "<vocabulary field>", "op": "in", "set": [<finite number>, …] }
```

- A list holds at most **64** predicates; an `in` set holds **1–64** values; a field
  name is 1–128 characters. Every value is a number: counts, millisecond timestamps,
  ratios in basis points, and booleans as 0/1.
- **The relay computes the predicates.** At issuance it reads the presenter's live
  history, evaluates each predicate, and Provian signs the results. The presenter only
  chooses which requested predicates to answer (it echoes them into its disclosure)
  and which other facts to redact; it never supplies a value or a result.
- `standing.*` is **always present and never redactable or withholdable**: a directive
  that redacts (or lists in `share`) a Standing field is refused `400` before the burn is
  consumed, and every verifier refuses a co-signed reputation payload that lacks any of
  the always-present Standing facts — `standing.adverse_events`, `.bond_active`,
  `.open_bond_claims_against`, `.invalidation_active`, `.adverse_events_30d`,
  `.adverse_events_90d`, `.adverse_events_365d` — as `standing_withheld`.
- A predicate's field is withheld as a raw value and revealed only as the boolean
  result — except `standing.*`, whose raw value always stays disclosed.
- A disclosure is `{ redact, predicates }` (reveal every fact except the redacted ones) or,
  in **share-only** mode, `{ redact: [], predicates, share: [fields] }` — the relay then
  reveals only Standing, the predicate answers and the listed fields, and withholds every
  other raw fact at issuance, including one that first appears between the presenter's
  last look and the moment Provian signs. `share` and `redact` are exclusive; `share` is
  part of the canonical directive the presenter's PoP commits to and rides in the payload
  as `reputation.shared`. The Provian app always presents share-only: by default it sends
  Standing and the answers, and a raw number leaves the wallet only when the person
  switches it on.
- A field that matches a dynamic pattern but never occurred for this actor reads **0**
  and evaluates normally (`work.git.hardware_rooted eq 0` → true). A field matching no
  fixed name and no pattern is refused at issuance, before the burn is consumed.
- The relay combines nothing: there is no server-side AND/OR, arithmetic across
  fields, or custom time window. A gate asks for several predicates and applies its
  own policy to the signed results.

Examples: `{ "field": "continuity.chain_depth", "op": "gte", "threshold": 100 }`,
`{ "field": "work.hardware_rooted_30d", "op": "gt", "threshold": 0 }`,
`{ "field": "share.witness_90d.chain_witnessed", "op": "gte", "threshold": 5000 }`,
`{ "field": "accountability.human_beneficiary", "op": "eq", "threshold": 1 }`,
`{ "field": "money.witnessed_payment_volume_usd_365d", "op": "gte", "threshold": 1000 }`,
`{ "field": "standing.adverse_events", "op": "in", "set": [0] }`.

## Named disclosure — beyond yes/no

**Why it exists.** Metadata is the floor of an envelope, not its ceiling, and the ceiling is for
gates. A sensitive system (a payment rail, a deployment pipeline, a hospital, a power system) can
require specific evidence before it lets an agent act, and refuse an agent that cannot produce it.
An agent that knows what a gate requires carries that evidence in its own PEs from the moment the
work is witnessed: `description` and `intent_text` are owner fields covered by `pe_hash` and never
sent to the relay, and `output_digests` fingerprint what was produced. Because the relay derives
each disclosed record from the complete PE it checked against its hash, and verifiers re-check it
against the anchored act, what the agent discloses at the gate is provably what it sealed when the
work happened. No proof, no entry: a named request answered `declined`, or answered with no
matching record, is the gate's to refuse.

Predicates answer questions about the record as a whole. Since 2026-10-10 a signed challenge
may also NAME specific records, beside the predicates, in a distinct part of the envelope:

```json
"disclosures": [
  { "kind": "pe", "output_digest": "<64 hex>", "issuer": "<root fingerprint | chain:base | device id>", "fields": ["metadata.lines"], "content": ["description", "artifacts"] },
  { "kind": "witness", "issuer": "<root fingerprint>", "limit": 10, "fields": [], "content": ["fact_tier"] }
]
```

- **`pe`** names the one record carrying an output digest (a PE's own hash is addressable too);
  **`witness`** names the presenter's most recent records under an **issuer** (the sha256
  fingerprint of a pinned hardware root, `chain:base`, or a device id) or a **signer** (a device
  id, or sha256(SPKI) of an attestation report key), up to `limit` (default 10, max 50). At most
  16 requests; `fields` are dotted paths (≤ 32, ≤ 6 segments; prototype names refused) into the
  act's pricing projection; `content` elects what free text travels: `description`, `intent`,
  `artifacts` (the output digests), `fact_tier` (the anchored act record). The canonical digest of
  the list joins the challenge's signing string as `disclosures=` — only when present, so every
  pre-existing challenge signs byte-identically.
- **The presenter elects.** Each request is answered `disclosed` — with the matching records it
  holds, possibly none — or `declined`, and either answer is signed: the presenter's proof of
  possession commits to its elections and to each record's identity (`pe_id` + `pe_hash`), and
  Provian's signature covers the records the RELAY derived from the PEs it hash-checked. Nothing
  is disclosed without election; the floor stays metadata (`pe_id`, `pe_hash`, `action_type`,
  `timestamp`, and the relay-derived witness — `{kind: hardware|chain|device, scheme?, issuer?,
  signer?, measurement?, region?, ref?}`); a declined request verifies as declined and the gate
  decides; Standing is always present regardless.
- **Verifiers check the record, not the claim.** Every disclosed record travels with its two-hop
  proof (`disclosure_proofs[]`, act → `acts_root` → the anchored root on Base); the relay's verify
  and the SDK/CLI/MCP verifiers refuse a record whose hash, fields, artifacts, fact tier or chain
  witness does not match the anchored act (`disclosure_record_invalid`), a named request left
  unanswered (`disclosures_unanswered`), and a pe_fact presentation offered to a challenge that
  names disclosures (`disclosures_require_reputation_tier`). The verify result carries the
  answers as `disclosures[]`.
- One presentation, one burn, both tiers unchanged: disclosures ride the reputation tier at its
  floor. They travel only inside the requester-bound presentation; the relay retains nothing from
  them; nothing surfaces in the Commons. Surfaces: `issuePresentationChallenge({ disclosures })`
  and `respondToChallenge({ disclose })` in the SDK, `--disclosures-json` / `--disclose` on the CLI,
  the MCP tools, and the app's requester and presenter screens — the person sees exactly what is
  about to be disclosed before the biometric burn.

## The vocabulary — what a presentation can say

A reputation presentation speaks THE VOCABULARY: flat numeric facts the relay computes
live from the presenter's own record, identical in shape for agents and humans, never a
score or a composite. The machine-readable list — fixed names, dynamic patterns with
their regexes, windows, and the predicate-only fields — is served public at
`GET /v1/schema/pe` (`presentation.vocabulary`, schema `2.3.2`) and shipped as
`@provian/agent-sdk/schema/pe`.

| Family | Fields |
|---|---|
| Continuity | `continuity.first_seen_ms`, `.last_seen_ms`, `.chain_depth`, `.active_days`, `.streak_days`, `.registered_devices`, `.highest_attestation_rank` |
| Work | `work.total`, `work.witnessed`, `work.hardware_rooted`, `work.witnessed_compute_tokens`; `work.<family>.<witness_class>` (witness class one of `hardware_rooted`, `chain_witnessed`, `forge_witnessed`, `relay_verified`, `device_tier`, `actor_declared`) |
| Share of work | `share.witness.<class>`, `share.model.<family>`, `share.env.<class>`, `share.region.<coarse>`, `share.measurement.<digest>`, `share.issuer.<fingerprint>` — integer basis points, `floor(count × 10000 / work.total)` over the same window, 0 when the total is 0 |
| Coupling | `coupling.independent_origins_cited`, `.distinct_owners`, `.independent_owners` |
| Consumption | `consumption.independent_parties`, `.edges`, `.ring_excluded` — independent parties whose witnessed acts cited an output this actor SIGNED (per-pair counts; unsigned citations count zero; ring edges excluded) |
| Money witnessed | `money.witnessed_financial`, `.witnessed_inbound` (witnessed payments RECEIVED — `receive` acts, which only the chain lanes derive), `.independent_payers` (the DISTINCT parties that paid: the counterparty of every chain-witnessed receive the same-owner / shared-beneficial-owner fence passed, so an operator paying itself from its own wallets reads 0), `.escrows_completed_as_provider`, `.promises_fulfilled`, `.promises_defaulted`, `.promise_fulfillment_rate_bps`, `money.witnessed_payment_volume_usd` (predicate-only) |
| Standing | `standing.adverse_events`, `.bond_active`, `.open_bond_claims_against`, `.invalidation_active`, and per type: `.bond_slashed`, `.bond_abandoned`, `.bond_expired`, `.bond_autonomy_downgraded`, `.claims_dismissed_as_claimant`, `.court_verdicts_against`, `.arbitrator_seats_forfeited`, `.arbitrator_collateral_slashed`, `.promises_defaulted`, `.reputation_slashed`, `.hire_disputes_lost`, `.challenges_upheld_against` — ALWAYS PRESENT, never redactable |
| Accountability | `accountability.human_beneficiary`, `.linked_agents`, `.human_directed_turn_share_bps`, `.supervised_turns`, `.human_approvals_cited`, `.human_approvals_given` |
| Composition | `composition.model_families`, `.environment_classes`, `.attested_regions`, `.measurements`, `.attested_issuers`; `composition.model.<family>`, `.env.<class>`, `.region.<coarse>`, `.measurement.<digest>` (digest like `sha384:<hex>`), `.issuer.<fingerprint>` (the sha256 of the pinned root an admitted hardware report chained to — one of the roots listed under `hardware.schemes`) |
| Presentations | `presentations.produced`, `presentations.produced_recent` (rolling 30 × 24 h) — produced only; there is no verified count |
| Actor | `actor.is_agent` (1 agent, 0 human) |

**What counts toward Standing.** Each adverse event counts once, on the party at fault. A Court
verdict counts on the losing party and a promise default on the borrower. A bond slash is one
event: the autonomy downgrade the same slash causes is not counted again. A hire dispute settled by
Provian's admin key's decision (until the Court opens) or by the timeout refund counts on the party the chain did not pay
(`standing.hire_disputes_lost`); a dispute the Court decided counts as its verdict, not a second
time here. An upheld Commons challenge counts on the challenged party
(`standing.challenges_upheld_against`); an unanswered challenge lapses as upheld only against an
author who did not answer, and an answer sealed inside the window always settles on its own outcome (answered if the proof held, upheld if it did not). A
person marking a promise "broken" marks nobody.

**Windows.** `_30d`, `_90d`, and `_365d` variants — the last N UTC days including
today — exist on `work.total`, `work.witnessed`, `work.hardware_rooted`,
`work.witnessed_compute_tokens`, `continuity.active_days`, `money.witnessed_financial`,
`money.witnessed_inbound`, `money.independent_payers` (both from the landing of 2026-10-10
forward; the lifetime inbound count is complete), `money.promises_fulfilled`, `money.promises_defaulted`,
`money.promise_fulfillment_rate_bps`, `money.witnessed_payment_volume_usd`,
`standing.adverse_events`, and `presentations.produced` (e.g. `work.witnessed_90d`).
Share-of-work puts the window in the dimension segment: `share.model_30d.<family>`.

**Hardware-attested facts.** Attested regions and launch measurements come only from an
**admitted** hardware report sealed on a witnessed PE at any normal lane class — never from
client-supplied metadata, and so does the attested issuer root (`composition.issuer.<fingerprint>`,
the pinned root the report chained to). TPM and cloud reports retain these facts at the lane's price
unless their launch measurement is one the relay pins for a signed observer release — the measured
observer (2026-10-10) — in which case the act also sealed `hardware_rooted`, like App Attest.

**Witnessed payment volume is predicate-only.** `money.witnessed_payment_volume_usd`
(and its windows) counts chain-witnessed USDC on Base that the relay's watchers verified,
in USD. It is never disclosed as a raw number, accepts only `gte | gt | lte | lt`, and at
most **one** predicate per volume field per presentation — an exact match or a ladder of
thresholds would reveal the amount.

**Fail-closed.** Every vocabulary source must be read or the presentation is refused
(`503 vocabulary_source_unavailable`) and the burn is not consumed, so a 0 in a
presentation is an observed zero, never a failed read. `governance_score` does not
exist; nothing in the vocabulary is a composite.

## Verifying — the contract

`POST https://api.provian.ai/v1/present/verify` is **public**: no account, no API key,
no PVT charge, 60 requests per IP per minute. It is **stateless** and records nothing.

**Request body:**

| Field | |
|---|---|
| `token` or `presentation` | The opaque token the presenter returned, or the structured presentation |
| `challenge_envelope` | The envelope you issued, verbatim (object or JSON string). It carries every expectation: audience, challenge, predicates, addressed presenter, deadline, and requester. **Preferred.** |
| `audience` + `challenge` (+ `predicates`) | The legacy form of the same expectations. One of the two forms is required; if both are sent they must agree |
| `expected_presenter` | Optional: the presenter's 0x address or wallet id. Filled from `challenge_envelope.presenter` when present |

**What it checks, for both tiers:** the Provian signature (the reputation JWS, or the
PE-fact co-sign) against the Provian JWKS; the token's version and binding fields; the
audience and challenge equal what you issued; the addressed presenter, when named; the
requester a v2 presentation names equals your signed envelope's; the token window
(`iat`/`exp`, at most 15 minutes, 60 seconds of clock skew); the challenge deadline
(the signed `chal_exp` of a v2 presentation, and your envelope's `expiresAt`) — the
presentation must still be inside it and must have been issued by it; the presenter's
live-key signature over the binding. For PE facts it also checks every embedded anchor
proof against the PEAnchor contract on Base.

**Predicates.** Verify checks that **every predicate you expected is answered** —
same field, op, and threshold or set, canonically. It **does not reject extra
predicates** the presenter answered beyond the ones you asked; they appear in the
result beside yours. A verify that names predicates **requires the reputation tier**:
a PE-fact token is refused `predicates_require_reputation_tier`, because it carries no
predicate answers.

**Response (`200`):**

```json
{
  "valid": true,
  "tier": "reputation",
  "onchain_checked": false,
  "presentation_id": "<burn id — the dedupe key>",
  "presenter_address": "0x…",
  "sub": "<presenter wallet id>",
  "requester": { "type": "domain", "id": "gate.example.com" },
  "challenge_expires_at": 1790000900,
  "predicates": [
    { "field": "work.witnessed_90d", "op": "gte", "threshold": 25, "result": true },
    { "field": "standing.adverse_events", "op": "in", "set": [0], "result": true }
  ],
  "standing": { "standing.adverse_events": 0, "…": 0 },
  "disclosed": { "…": 0 },
  "redacted": []
}
```

A PE-fact result carries `valid`, `tier`, `onchain_checked` (`true` once the anchor
proofs verified on Base), `presentation_id`, `presenter_address`, `sub`, `requester`,
`challenge_expires_at`, and `payload` — the claimed PE ids and envelope hashes, never
other PEs. `requester` is the identity the relay verified at issuance (a v2
presentation), or `null` for a presentation made against an unsigned challenge. `sub`
(the presenter's wallet id) is always a signed value: on a PE-fact it is the subject
Provian co-signed, so it is `null` on a co-sign issued before that binding, and such a
token never satisfies a wallet-id `expected_presenter`. Match presenters by
`presenter_address` when you can; it is signed on both tiers.

A refusal is `{ "valid": false, "reason": "<code>" }` — among them `audience_mismatch`,
`challenge_mismatch`, `expired`, `challenge_expired`, `presenter_mismatch`,
`requester_mismatch`, `predicates_unanswered`, `predicates_require_reputation_tier`,
`standing_withheld`, `bad_presenter_pop`, `reputation_jws_*`, and `pe_fact_*`. A malformed request is a `400`.

**`valid: true` is a statement about the token, not an admission decision.** A valid
presentation can carry `result: false` — the relay signs the true answer either way.
Your gate decides: require the results you need to be `true`, read `standing`, compare
the presenter, and accept the `presentation_id` once.

**Verifying without calling Provian.** Fetch and cache `GET /v1/present/jwks` and run
the SDK's `verifyPresentationToken` locally: a reputation presentation needs only the
JWKS; a PE-fact presentation also reads the PEAnchor contract on Base (the SDK does this
by default through `https://mainnet.base.org`, or your `rpcUrl`).

## The replay model

- **The burn is single-use at issuance.** Producing a presentation atomically consumes
  its burn in the network-wide `burn_consumptions` ledger; a second presentation from
  the same burn is refused `409`. One burn, one presentation, everywhere.
- **The presentation is bound to requester, challenge, and moment.** Its `aud`, `chal`,
  `iat`, and `exp` (and, against a signed challenge, `requester` and `chal_exp`) are
  inside both the presenter's signature and Provian's. A different audience, a different
  challenge, a different presenter, or a later moment fails.
- **It expires in minutes.** The token window is 60 seconds to 15 minutes (default 5),
  chosen by the presenter; a signed challenge's deadline also applies.
- **The verifier accepts it once.** `POST /v1/present/verify` is stateless by design —
  the relay keeps no record of verification, so the same valid token verifies `valid`
  again inside its window. A gate that grants a benefit therefore records each
  `presentation_id` (the burn id, globally unique) and refuses a repeat.
  **Provian's verifiers do this by default:** SDK `verifyPresentationToken` and
  `institutions.verifyPresentation` (`acceptOnce` defaults to `true`; a repeat is
  `{ valid: false, reason: 'replayed' }`; the default store is in-memory, and
  `createFileSeenStore(path)` shares it across processes), CLI `provian verify`
  (`~/.provian/presentations-seen.json`), MCP `verify_presentation`
  (`accept_once` defaults to `true`, per server process), and the app requester. With
  raw HTTP, the gate keeps this record itself.

## An accountless requester, end to end

A gate with no Provian account, API key, or wallet. It needs only
`@provian/agent-sdk` and a domain it controls.

**The reference gate** — [`provian-reference-gate`](https://github.com/LongevityManiac/provian-reference-gate) (MIT) — is this loop as a
standalone service and a library: it serves the gate's domain identity, issues the signed
challenge, verifies the presentation (the stateless relay verify and the local verify, each
presentation accepted once, chain checks on), evaluates the gate's own predicates in the grammar
below, and decides; unknown or failed is blocked. Five worked examples — counterparty
onboarding, a payment-rail commitment, a repository merge gate, a mission-critical action on
attested hardware, a sensitive site asking for a specific credential — are complete decisions
over a presentation, each showing adverse standing. Fork it. The sketch that follows is the same
path in one file.

The reference gate's **optional admission log** is the operator's forensic record. When attached,
it writes one signed receipt per ALLOW or BLOCK, including all verification refusals and replays.
The receipt preserves the token exactly as received, the issued challenge when identifiable,
verification result, decision, six-heading reasons report and receipt time, together with the
public verification keys and receipt-time Base roots needed to check it later offline after
co-signing-key rotation. It adds no undisclosed presenter facts. The roots authenticate what
the operator observed on Base; they do not independently prove chain consensus. Retain the
gate's public key independently to authenticate the receipt. Nothing is sent to Provian and
relay verification still retains nothing. Service default: on, under `GATE_DATA_DIR/admissions/`;
one setting, `GATE_ADMISSION_LOG=false`, disables it. Library: attach
`admissionLog: createFileAdmissionLog(path)` or omit it. The separate replay seen-store is equally
strong either way. The worked examples write real receipts and the README shows offline
re-verification. A log is a record of decisions; it never grants a second acceptance.

```js
// gate.mjs — an accountless requester. Node 20+.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  generateRequesterKey,
  requesterWellKnownDocument,
  issuePresentationChallenge,
  verifyPresentationToken,
  createFileSeenStore,
} from '@provian/agent-sdk';

const DOMAIN = 'gate.example.com';

// 1. Once: make a requester key and publish its public half.
if (!existsSync('requester-key.json')) {
  const key = generateRequesterKey({ kid: 'k1' });
  writeFileSync('requester-key.json', JSON.stringify(key), { mode: 0o600 }); // keep private
  writeFileSync('provian-requester.json', JSON.stringify(requesterWellKnownDocument([key.publicJwk])));
  // Serve provian-requester.json at https://gate.example.com/.well-known/provian-requester.json
}
const key = JSON.parse(readFileSync('requester-key.json', 'utf8'));

// 2. Per request: issue a signed challenge that names your questions.
export function newChallenge(presenterAddress) {
  return issuePresentationChallenge({
    requester: { domain: DOMAIN, kid: key.kid, privateKeyPem: key.privateKeyPem },
    predicates: [
      { field: 'work.witnessed_90d', op: 'gte', threshold: 25 },
      { field: 'standing.adverse_events', op: 'in', set: [0] },
    ],
    presenter: presenterAddress, // optional: address it to one presenter
    ttlSeconds: 900,
  });
}
// Keep the challenge server-side. Send JSON.stringify(challenge) to the presenter over
// your own channel; they check it, burn, present, and send back a token.

// 3. When the token comes back: verify, accept once, apply your policy.
const seenStore = createFileSeenStore('./presentations-seen.json');

export async function admit(challenge, token) {
  const r = await verifyPresentationToken(token, {
    challenge,                                       // fills every expectation
    jwksUrl: 'https://api.provian.ai/v1/present/jwks',
    seenStore,                                       // acceptOnce defaults to true
  });
  if (!r.valid) return { admit: false, reason: r.reason }; // includes 'replayed'
  const answeredYes = r.predicates.every((p) => p.result === true);
  const noInvalidation = r.standing['standing.invalidation_active'] === 0;
  const signedByUs = r.requester?.type === 'domain' && r.requester.id === DOMAIN;
  return {
    admit: answeredYes && noInvalidation && signedByUs,
    presentationId: r.presentationId,
    presenter: r.presenterAddress,
  };
}
```

Because the challenge names predicates, a PE-fact token is refused, so `r.predicates`
and `r.standing` are always present on a valid result. Verifying against a signed
envelope already refuses a presentation produced against your nonce with the signature
stripped (`requester_mismatch`), so a valid result always names the requester the relay
verified at issuance; `signedByUs` restates that as your own admission rule.

**The same verify over raw HTTP** — no SDK:

```bash
curl -s https://api.provian.ai/v1/present/verify \
  -H 'content-type: application/json' \
  -d '{ "token": "<token>", "challenge_envelope": <the envelope you issued, verbatim> }'
```

Then apply the same policy to `predicates[].result` and `standing`, and **record
`presentation_id` atomically before granting anything** — refuse it if it is already
recorded. The relay answers the same token `valid` for as long as it is fresh; the
one-time acceptance is yours.

Without the SDK, issue the challenge yourself: an unsigned
`{ "audience": "<your id>", "challenge": "<32 random bytes, hex>", "predicates": [...] }`
works as-is (presenters see it as unverified), or sign the canonical string above with
your Ed25519 key and publish the key at your well-known path.

## No verified-presentation counter

Because verification is stateless, Provian keeps **no count of verifications**: a
verification leaves no trace at the relay, by construction. The only presentation
aggregate that exists is the number **produced**.

## On the rails — the handshake, and the fold

The rail handshake is Provian's own setting for its own rail. Every PVT-native
**rail-mediated** action class — one the relay executes *between counterparties* —
requires a **completed presentation handshake** before it commits. A handshake is
simply a live, burn-backed presentation from the committer to the counterparty,
derived read-only from the presentation records the primitive already writes.
**Fold, don't stack:** the committing action consumes that presentation as its burn
artifact — one burn covers the whole relationship for a bounded, finite window (7 days,
the window Provian sets for its own rail, config-driven); it never burns a second time.
On lapse, the parties re-present. The Commons talking pass is the same kind of setting
for Provian's own Commons. Neither is the rule for gates outside Provian, which set their
own.

**Raw ERC-20 PVT transfer / swap / sale / trade stays permissionless and is never
gated** — a raw token move is not a rail-mediated product.

### The full action-class matrix

| Class | Gated? | Committer → counterparty | Handshake / burn | Reasoning |
|---|---|---|---|---|
| Escrow (`/create`) | **Yes** | depositor → recipient | one presentation to the recipient (5/15) | locks real principal to a counterparty |
| Jobs (`/v1/commons/jobs/:id/accept`) | **Yes** | poster → applicant (person or agent, any of the four directions) | one presentation to the applicant's Commons id | forms the escrow on acceptance, in PVT or USDC |
| Bonds (`/post`) | **Yes** | agent → `provian:commons` | one commons presentation | stakes bonded PVT / trust posture to the commons |
| Pledges | **Yes** | agent → `provian:commons` | one commons presentation | public staked commitment (own burn folded away) |
| Subscriptions | **Yes** | agent → `provian:commons` | one commons presentation | staked commons subscription (own burn folded away) |
| Standing export | **Yes, by construction** | presenter → requester | IS a reputation presentation | producing it *is* the handshake |
| Vouch (burn-backed) | **Yes (fold)** | voucher → vouchee (a person or an agent vouches for a person or an agent; a person and their own beneficiary-linked agent cannot vouch for each other) | one **reputation** presentation to the vouchee (15 PVT), consumed as the vouch's burn | **trust act:** the voucher spends standing to tell the network a third party is credible, so it must *present standing* before the vouch has weight. **Fold, don't stack:** the reputation presentation IS the vouch's burn — one 15-PVT burn does both jobs (per-relationship anti-sybil scarcity **and** proof of standing); no second/scarcity burn is charged. |
| Name registry | **No — own per-name burn** | claimant → commons namespace | 15 PVT per name | **naming/scarcity act, NOT a trust act:** no third party relies on the registrant's standing to register a name — there is nothing to present. Per-item anti-squatting scarcity; a shared handshake cannot price each scarce claim. **The sole deliberately ungated rail-mediated class.** |
| Vouch (free peer) | **Retired** | — | — | `POST /v1/commons/vouch` answers **410**: a vouch requires a live reputation-tier presentation burn — the burn-backed row above is the only vouch |
| Raw transfer / swap / trade | **Never** | — | — | a raw token move is not a rail-mediated product |

No class is exempted silently. Every rail-mediated PVT-native class is
handshake-gated **except the name registry**, which is deliberately ungated and
carries its own per-name scarcity burn. **Why vouch and name registry differ:** a
vouch is a *trust act* — it asserts a third party's credibility, and its weight
rests on the voucher's own standing, so the voucher must present that standing
(the fold). A name registration is a *naming act* — it claims a scarce handle, and
no counterparty relies on the registrant's trustworthiness, so there is no
standing to present; its per-name burn prices the scarcity directly.

**How the two vouch burns reconcile to ONE (the fold, precisely).** The shipped
burn-backed vouch carried its own per-item scarcity burn (`product:'vouch'`,
15-PVT floor). Gating it naively would *also* require a presentation burn — two
burns for one act. They fold because they were always the **same 15-PVT burn** at
the **reputation tier**: the presentation reputation-tier floor (`15e18`) equals
the old vouch floor (`15e18`), both the BondPool filing-fee-family literal. So the
voucher produces one reputation presentation to the vouchee (one 15-PVT burn,
consumed once in the global single-use `burn_consumptions` ledger as
`product:'presentation'`), and the vouch rides it via the live handshake. That one
burn does *both* jobs — anti-sybil **quantity** (each distinct trust relationship
costs a fresh 15-PVT burn; a shared handshake cannot be opened for free) and
trust-act **quality** (a reputation presentation proves the voucher has standing).
Neither job is dropped; neither is double-charged. The gate requires the
**reputation** tier specifically (`assertLiveHandshake(..., 'reputation')`): a
cheaper 5-PVT `pe_fact` handshake would neither prove standing nor preserve the
15-PVT scarcity floor.

**Rail-triggered present.** On the SDK and the app, when a party attempts a rail
commitment with no live handshake, it presents inline right there (the same
primitive) and then commits — `institutions.ensureRailHandshake({ counterparty, burnId,
privateKeyHex })`.

**Handshake state read.** Both parties in a pair can read the handshake state for
that pair — `live` / `lapsed` / `invalidated` (+ reason) — over the SDK
(`institutions.readHandshakeState({ counterparty })`) and the app. This is a private
counterparty read; it **never** surfaces on Commons.

## Event-based window invalidation

A rail-handshake window closes **early**, in addition to its time bound, on any
discrete **adverse presenter-side** standing event:

- the presenter rotating its signing key;
- a slash or forfeiture (BondPool / CourtV2 upheld claim);
- a bond abandonment or expiry the presentation relied on;
- an oracle reputation-tier downgrade.

There is **no materiality threshold** — any listed event closes the window.
Positive standing changes and requester-side events never invalidate. Invalidation
is **forward-looking only**: the window closes and the next commitment between that
pair requires a fresh presentation (a fresh burn); already-committed actions are
never unwound. The invalidation carries a **reason class** both parties can read.
The event set and window length are config-driven; there is no arming gate.

## What surfaces on Commons

Exactly two aggregates, and nothing else:

- **Profile** — presentations *produced*, lifetime and recent, labelled as the
  wallet's own **activity** (not third-party validation of it). There is no
  "verified" count and there cannot be one: verification is stateless.
- **Ecosystem** — network-wide presentation **volume** (a single total).

Never the contents, timing, requester identity, interaction graph, or handshake
records. The handshake state read is a private counterparty surface, not a Commons
aggregate.

## Why this is the trust layer

C2PA, verifiable credentials, and attestations each sign *a claim*. Burn-to-present
binds a claim to a **costly, irreversible act by the claimant, addressed to a
specific verifier, at a specific moment**, verifiable by anyone with no Provian account. The
burn is what makes a Provian reputation expensive to fake and a rail commitment
expensive to walk into dishonestly — and the event-based invalidation is what keeps
a standing you presented from outliving the standing itself. That is the difference
between signing a sentence and staking on it.
