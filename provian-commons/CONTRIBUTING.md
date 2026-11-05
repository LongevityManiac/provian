# Contributing — on the open protocol, not on this code

> **This reference implementation is closed source.** It is not open for forking,
> copying, or pull requests. What is open — and where contribution actually happens —
> is the **Provenance Envelope protocol** and the developer tooling
> (`@provian/agent-sdk`, `@provian/cli`, the Python SDK, the published PE
> specification). This guide explains how to contribute *there* and how to build your
> own Commons on the open primitives. See the repository root `LICENSE` and this
> package's `LICENSE` for the boundary.

## New PE Action Types — emit your envelope; a witness records it, a signature prices it

**Emit your envelope — that is all you need to do.** The type of work is never the gate; a
witness is. A PE exists only when something other than the actor vouches for it, so any valid
`action_type` (a flat `snake_case` name or `namespace:action_name`) records on a witness lane:

- **The sovereign lane** (`POST /v1/pe/submit-sovereign`): a hardware-witnessed submission — an
  occurrence carrying an admitted non-actor hardware witness (a TPM, enclave, confidential-VM or GPU
  report verified to its scheme's pinned public root) — of a `compute_or_work`-family type or of a
  type the network has never seen.
- **The gateway path** on the device batch (`POST /v1/meter/batch`): a registered machine's
  observer witnesses the work through an observer plugin. The observer (never the plugin) stamps the
  act `metadata.source: "observer_plugin"` and `metadata.observer_plugin: <plugin name>`, and the
  act rides the device's body-bound daily batch at device tier. The batch also admits, as before,
  the types the observer's own lanes emit — `compute_session`, `inference_session`,
  `coding_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation`, and
  transcript-witnessed `link_spend`
  (`provian-backend/src/core/provenance/device-observation-types.ts`).
- **The chain, forge, relay and counterparty lanes** witness their own types — Commons acts, chain
  watchers, forge webhooks, institutions, Genesis, registration — from evidence the relay checked.

**A type the network has never seen is recorded with no mint** and enters the public review queue
(`GET /v1/pe/earning-proposals`, [provian.ai/proposals](https://provian.ai/proposals)). It earns
from the day its policy row is signed, on each lane the signature names (a lane it came in on); envelopes sealed before the
signature stay records. You are notified when it earns: an `action_type_activated` inbox event and
webhook for an agent, a push for a person.

**What is refused, not recorded.** A bare call asserting work with nothing else vouching for it —
an agent or device vouching for its own claim — is refused: a device-batch act of a type outside
the observation lanes without the plugin marker comes back in the receipt as
`actor_declared:action_type_not_observed`, and the sovereign lane answers 403
`actor_declared_work_is_not_a_pe` to an occurrence with no admitted witness, to any `x402_payment`
or `link_spend` body, and to a self-report-labelled body. A named type keeps its own witness: a
chain, relay, forge or Genesis type presented through the actor's own hardware report or an
observer plugin is refused. On the phone's batch (`POST /v1/meter/batch/mobile`, wallet auth) a
type the action-policy matrix does not name is the person's own claim: it records at the
`actor_declared` witness class, earns zero and does not enter review. The single-PE recorders
(`POST /v1/pe/submit`, `/v1/pe/submit/mobile`, `/v1/relay/action`, `/v1/relay/work-product`) are
retired and answer 410 `pe_recorder_retired`. (The old `POST /v1/pe/propose-type` and the upvote
endpoint are gone.)

**Contributions are welcome, never required.** A named price for a type is a matrix row that the
maintainer signs. You may help it along with a PR: an emitter that produces the envelope, a
verifier that can independently confirm the work happened, and a matrix row in
`proposed-action-policy.ts`, with the regenerated matrix and its hash pin. The local gate battery
checks the pin, the emitter→row coverage, the row→verifier coverage, and the money-path tripwire.
The row takes effect only after the maintainer signs the new template digest and the relay deploys
it. **A type with no verifier is never given an eligible row.** Envelopes sealed before the go-live
timestamp keep the price they were sealed at.

**Turnaround:** a ruling within 3 business days of first sight; signed rows go live at the
weekly signing cut. Status for every proposed type — queued, building, live (with its
weight), or declined with a reason — is public at **https://provian.ai/proposals** (and per
type at `GET /v1/pe/earning-proposals/<type>`).

## Building a New Institution on the open protocol

You can build an institution without this proprietary implementation, on the open primitives:

1. **Define your PE types.** Every meaningful action should generate a PE. On the Provian relay any type records through a lane that witnesses it (above) — a sovereign submission with an admitted hardware witness, or your observer plugin on a registered machine — and a type the network has never seen records with no mint and enters review until its row is signed. An identifier with nothing vouching for it is refused. Pricing a type on the Provian relay is the signed path above.

2. **Deploy your own reference contracts.** If your institution involves on-chain value transfer, follow the open reference contract pattern (`docs/REFERENCE_CONTRACT_PATTERN.md`):
   - Take fees in PVT or USDC
   - Burn a PVT fee from the contract's own balance via `IPVTBurnable.burn(amount)`; send a USDC fee to your fee wallet
   - There is no registration step: PVT9 has no `protocolBurn` and no `setProtocolContract`

3. **Build your UI on the open SDK/CLI.** `@provian/agent-sdk`, `@provian/cli`, and the Python SDK are MIT-licensed and client-agnostic — mobile, web, CLI, or purely agent-to-agent.

4. **Run it independently or interoperate.** Your institution shares the PE protocol layer, so PVT and attribution flow across all Commons instances regardless of who built them.

## Building an Alternative Commons Client on the open protocol

The protocol layer is open; the reference implementation in this package is not. To build your own Commons client, build against the open surface — do **not** fork or copy this proprietary code:

1. **Use the open `/v1/pe/` protocol endpoints** — the shared vocabulary:
   - `GET /v1/pe/earning-proposals` -- the earning-type registry (every type ever seen: queued / building / live / declined, with weights and effective dates); `GET /v1/pe/earning-proposals/:type` for one type
   - `POST /v1/pe/verify` -- Verify a PE against its Merkle root
   - PE export -- the relay keeps no PEs (`GET /v1/pe/export/:wallet_id` answers 410 `pe_kept_by_owner`); each owner exports its own PEs with their anchor proofs as a `provian.pe-export.v1` file (`docs/PE_PROTOCOL_SPEC.md` Section 14)

2. **Stand up your own backend** against the open protocol and SDK. The Provian relay's reference Commons backend is proprietary and is not a starting point you may copy from.

3. **Respect the three-tier visibility model:**
   - Tier 1: Aggregate metrics (always public for Commons participants)
   - Tier 2: Selectively published via PE Public Projection (mutual consent required for multi-party PEs)
   - Tier 3: Never exposed (credentials, policies, balances, telemetry, guardian info)

4. **Generate PEs for all consequential actions.** The hash chain must not have gaps. Every action that affects state should produce a PE.

## Protocol Guarantees (hold for every Commons client)

These guarantees are protocol-level and hold across all Commons clients, not just this reference implementation:

- **Relay-signed projections.** PE Public Projections are signed by the relay to prevent tampering. Any client can verify the signature.

- **Relay-enforced consent.** Multi-party PEs require all parties to approve before counterparty details are visible. Consent expires after 7 days. No client can bypass this.

- **Immutable treasury floors.** The Provian 0.5% cut and human/Genesis Foundation 0.5% floor cannot be changed by governance, admin action, or client code. Human-resolving and Genesis mints therefore use 99% contributor / 0.5% Provian / 0.5% Foundation. For an agent-side mint without a verified human beneficiary, the Foundation rate may adjust prospectively under authorized policy but never below the human floor; the contributor receives the residual.

- **Append-only PE chain.** PEs are signed and hash-chained. The relay assigns each PE its evidence-derived attestation tier: a verified hardware witness (a non-actor key's report that chains to the scheme's pinned public root: Apple App Attest, or a TPM or confidential-computing quote whose launch measurement a signed observer release pins) lifts it to `hardware_rooted` on any lane, and agent-owned devices otherwise start at `software`. No client can modify a sealed PE or break the chain. This is the tamper-evidence guarantee.

- **PE-based PVT minting.** Every PE, regardless of which Commons client generated it, is priced by the same signed action-policy matrix and monetary template, and every act of work mints PVT once at its best-supported value. No client gets preferential minting treatment.
