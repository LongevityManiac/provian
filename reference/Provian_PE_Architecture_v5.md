# Provenance Envelope Architecture

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

*Architecture companion · September 2026*

Provian connects contribution, evidence, and economic participation. The Provenance Envelope (PE) gives a participant signed proof of an action that they own and can carry into future relationships. Every act of work also mints PVT once at its best-supported value under protocol policy. The [Thesis](TheProvianThesis_v24.md) develops that purpose; this paper explains the proof and its trust boundaries.

## A record with an accountable source

A PE identifies an actor, an action type, a timestamp, and the prior record in the actor's hash chain. Its signatures and hashes make later alteration detectable. They do not prove that every reported fact is true, that the output is correct, or that the activity benefited society. A record's witness and evidence determine what another participant can reasonably infer.

The [PE Protocol Specification](../docs/PE_PROTOCOL_SPEC.md) defines the fields. The versioned schema at `GET /v1/schema/pe`, generated from relay types and snapshotted in the SDK, defines their assignment and privacy rules. Integrators should use those interfaces instead of maintaining a second schema from this explanatory paper.

A PE lives with its owner: on the device that observed it, and on the person's phone, backed up encrypted to their own iCloud or Google Drive. Each device sends the relay one signed batch of act records a day (identity, a hash over the complete PE, and pricing inputs; never descriptions or content). The relay prices the acts and keeps running totals, compact batch economics and permanent packed occurrence digests shared across an actor’s devices, and the daily on-chain fingerprint of every batch; it keeps no PE. Public Commons activity and transactions on Base have their own public visibility.

## Witnesses and earning admission

The relay assigns a witness class: `hardware_rooted`, `chain_witnessed`, `forge_witnessed`, `relay_verified`, `device_tier`, or `actor_declared`. It verifies the evidence available on the submission path. Attestation tiers and class admission serve different purposes; neither substitutes for the other eligibility checks.

Named signed policy rows retain their dispositions. Named work vouched for by a registered-device observer mints once at its software/base evidence price; an actor’s own claim is refused. Any action type records on a witness lane — a hardware-witnessed sovereign submission, or a registered machine's observer witnessing it through an observer plugin — and an unfamiliar type with a verified non-actor witness records with no mint, enters the public review queue, and earns from the day its policy row is signed; a never-seen type in a person's phone batch is that person's own claim and records only. The unfamiliar purely actor-declared fallback mints zero. A rejection takes precedence, and a policy read failure never admits a claim.

A hardware witness is signed by a non-actor key over the bound body and verified to the scheme's pinned public root. Verified Apple App Attest supplies the hardware-rooted 4.0× class, as does a TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement is one the signed observer release pins (the measured observer, 2026-10-10). Every other verified report, including an unpinned confidential-computing attestation, desktop Secure Enclave and StrongBox, is a presentation fact at the normal lane price. An unverifiable report records its digest and reason without a hardware lift. Agent-owned devices start at software; replication, independent corroboration and verified human linkage remain separate evidence treatments. Historical sealed prices never change.

Body-bound registered-device reports are accepted at their device tier. An operator can patch a daemon to fabricate reported token counts or origins. Hardware identity evidence does not by itself establish independently metered computational expenditure. This is an accepted residual of the current model, not a claim that volume or origin stuffing is impossible.

## One graph for what work built on

`output_digests` identify produced artifacts by hash and kind. `input_origins` describe consumed inputs. An unsigned `pe:<pe_id>` citation can resolve through retained act trust facts when available, but counts zero toward consumption. Signed `out:` citations are verified at intake and counted once for an independent pair of participants. Separate attribution edges retain their existing 31-day lifetime; permanent occurrence membership across the actor's devices, rather than those edges or an expiring priced record, enforces mint-once. The former separate `cited_pe_ids` vocabulary is retired; compatibility input is folded into this graph.

These edges support attribution. Consumption, the count of independent parties that built on a participant's outputs, comes only from signed citations: an `out:` origin carrying the producer's signature over the output's hash, captured from a signed output the citing device received and carried on a witnessed PE. A `pe:` citation carries no producer signature and counts zero toward consumption. Edges do not automatically pay upstream contributors, redirect mint shares, or delay a mint while ancestors settle. Closed-loop rules can exclude edges from consumption or independence credit without erasing the underlying work record.

## Capture and mint-once

Phones, desktops, repositories, agents, and relay services provide different capture paths. The [Generation Model](../docs/PE_GENERATION_MODEL.md) describes them; [Capture Architecture](../docs/CAPTURE_ARCHITECTURE.md) covers observer behavior. New devices and domains can implement the same protocol without claiming every prospective integration already exists.

Multiple witnesses can prove the same occurrence. Mint-once coordinates one base earning claim; it does not require there to be only one PE. Corroboration within the policy window may support an additive top-up to the target PE. Sealed proof and its economic snapshot remain unchanged.

Human approval is its own witnessed act: an agent requests approval, the human reads the request and signs with their wallet, and subsequent work can cite the approval PE. The agent-facing list does not expose the request text, and the approval PE carries its subject hash. Approval is evidence of authorization for that request, not a universal guarantee of outcome or safety.

## From evidence to a relationship

A presentation is bound to a presenter, requester, and challenge. A reputation presentation can disclose authenticated vocabulary facts and predicate results, with standing always present and non-redactable. Verification does not reveal the full PE chain. Default disclosure includes the authenticated vocabulary except explicit permitted redactions; callers should choose the required facts and predicates deliberately. Beyond predicates, a challenge may name specific records (an envelope by its output digest, or the envelopes a named issuer or signer witnessed), specific fields of a record, or content the envelope's owner attached (description, intent, linked artifacts, fact-tier content). The presenter elects: each named item is answered as disclosed or declined, and a declined item is signed as declined. Disclosures travel only inside the requester-bound presentation, and the relay retains nothing from them.

PVT can fund a supported presentation burn. The token is transferable, but the presenter's history is not. A burn cannot purchase favorable evidence or remove adverse standing. A requester decides how long it trusts a presentation; Provian's own rail handshake windows permit repeated coordination on its rails; ordinary transfers and swaps do not universally require a presentation.

## Economic identity and continuity

An agent can hold its own wallet, own its proof history, and share the PVT its work mints through a beneficiary agreement. Linked contributor shares default to 20% agent and 80% human; the agent share can be configured prospectively from 5% to 50% with the linked human’s signed consent. The link ends by bilateral consent or by the linked human alone; an agent cannot end it by itself. Independent agent spending uses the agent's own keys; the relay witnesses supported activity rather than governing it.

Wallet recovery, device attestation, and provenance continuity have distinct keys and failure modes. The app's wallet seed is encrypted and supports a ciphertext cloud backup. Its hardware-held PE attestation key is separate. See the [Wallet Architecture](Provian_Agent_Wallet_v2.md) and [Recovery Architecture](../docs/RECOVERY_ARCHITECTURE.md).

## Current authority and future reach

The sole [Network Constitution](../NETWORK_CONSTITUTION.md) is unratified. Provian Technologies, LLC stewards current policy; governance is dormant. Contracts and signed policy artifacts establish implemented monetary behavior. This paper describes those boundaries and cannot amend them.

The same record format can support more kinds of contribution over time. Its value depends on the evidence it carries, the judgment counterparties exercise, and the relationships people and agents choose to build.
