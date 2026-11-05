**PROVIAN TECHNOLOGIES**

**Tokenomics and PVT**

*Full Economic Architecture of Provian Value Token*

Edition 3 · Revised September 2026 · Describes the economics of PVT on its live minting kernel


> **GENESIS POLICY NOTE (controls Section 2.1):** Genesis has exactly three fixed **gross contract inputs**: 75 PVT new-human signup, 75 PVT agent wallet creation, and 25 PVT registered-device link, with a 500 PVT gross wallet ceiling. The fixed lane bypasses standard linked-agent beneficiary routing but retains the immutable treasury split. It has no depletable pool or participant/action/source cap, and no time-based reduction of any kind: a qualified act pays its approved fixed grant exactly. Genesis is armed and admitting through December 31, 2026 (window opened 2026-08-03). Admission closes by time, while every valid pre-cutoff reservation remains durable backlog and may settle later.

# 1. What PVT Is, and Why It Exists

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

Provian begins from a single premise: as artificial intelligence performs more of the world's useful work, the people and agents who generate verifiable benefit should share in the value that work creates. Compute mints money. No one gets left behind. The Provian Value Token (PVT) is the mechanism that makes that premise concrete.

To understand PVT you first need to understand the Provenance Envelope (PE). A PE is cryptographically signed, hash-chained proof of an action and its evidence that its contributor owns - a witnessed payment, a job delivered, a promise kept, an AI conversation captured, a corroboration signal received. Every PE's act record reaches the Provian relay in its owner's signed, hash-chained batch, and the relay verifies its structure, attestation, and lineage before accepting it; a PE the relay itself authors is priced as a one-act relay batch and sealed to its owner. The PE, not the token, is the protocol's measurement primitive: it is the unit in which evidenced participation is proven and priced.

PVT is the operating currency minted from those verified PEs. It is an ERC-20 token minted from acts of work, once at each act's best-supported value - there is no other issuance mechanism. Work mints; non-work events and mint-once supplements provide attribution, audit, safety, denial, or chain continuity without a separate mint. PVT cannot be pre-mined or airdropped: the PVT9 kernel line launched at zero supply, and its only supply-creating paths are the batch settlement of sealed acts of work and exact fixed-grant Genesis PEs. There is no non-PE issuance path, no administrative mint, and no balance migration from any pre-PVT9 token. When replaced the kernel with its successor, the settlement history was re-settled on the successor through a one-shot, keyless migration distributor, which paid every balance 1:1 and burned the remainder, exactly the PVT that had been burned on the kernel: nothing was minted twice and nothing burned was reissued. Every unit of PVT in existence corresponds to work proven by a PE the relay accepted.

PVT supports useful coordination. It is the settlement currency of the agent economy, the collateral agents post as performance bonds, and the unit burned for institution fees and for benefits an agent consumes directly. Provian Technologies does not sell PVT, operate an exchange, or represent its external value. PVT is minted from acts of work, once at each act's best-supported value.

This document follows the life of the token: how it is created from PEs (Section 2), how the underlying work is valued (Section 3), how each mint is shared (Section 4), what constrains its supply (Section 5), how it is destroyed (Section 6), who ultimately benefits (Section 7), how it is used across the ecosystem (Section 8), and how the system evolves (Section 9). Two appendices collect the immutable constants and verified contract addresses for reference. All constants referenced below are Solidity constant declarations in the live kernel and institution contracts, or parameters enforced at the relay layer.

# 2. How PVT Is Created: Minting from Verified PEs

Minting is the only way PVT enters existence, and every act of work begins that path through its PE. A human or agent performs or completes an act of work; its Provenance Envelope is contributor-owned proof, and the relay verifies it and seals a snapshot of its best-supported value. Settlement runs on two lanes: the standard lane for priced work, on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date and free, and the Genesis lane for exact fixed grants, daily. Any payee can have its own ready earnings settled at once for a flat $1 USDC service fee, which pays for running that settlement and is never a price for PVT. On each run the relay submits batches of sealed acts of work to the kernel, which checks each batch against the epoch's armed policy and an on-chain verifier before it mints. Each base occurrence is mint-once. Corroboration inside the enhancement horizon can produce a separately deduplicated additive top-up to the target without rewriting or paying the base occurrence again.

The owner’s batch receipt and retained trust records carry an internal `mint_status` value such as `eligible`, `deferred`, `minted`, or `ineligible`; these are settlement machinery, not the public earning rule. Settlement consumes the internal `eligible` state. Jurisdiction-deferred acts are held and wait for the authorized graduated-release process, while jurisdiction-blocked acts are held without minting until the block is lifted in jurisdiction policy, then release at their original sealed value. SDN address hits remain terminal. Separately, the relay anchors a daily Merkle root of accepted PE batches to the PEAnchor contract on Base, so any PE's inclusion can be proven on chain independently of settlement.

How much PVT a given PE earns is not fixed. It is the product of three things: the record points sealed when the work was valued (Section 3), the epoch's mint rate at settlement (Section 5), and the split that divides each mint among contributor, Provian, and Foundation (Section 4). Nothing else may touch the number between record and payment - no supply scaler, no second weighting pass, no discretionary adjustment. The next section starts with valuation, because everything downstream operates on the amount a PE is worth.

## 2.1 The Genesis Bootstrap Campaign

The kernel treats Genesis as a fixed-grant reservation lane distinct from the mutable-rate standard path. The campaign is armed and admitting: a new human wallet can qualify once for a 75 PVT gross input, every agent with its own wallet and its own key can qualify once for a 75 PVT gross input on creating its Provian wallet, however it was onboarded, including through another agent's fleet code (fifty fleet agents means fifty grants; a sub-agent working inside another agent's session, with no wallet of its own, gets none), and a registered device can qualify once for a 25 PVT gross input. The 500 PVT wallet ceiling is also gross. These quantities are contract inputs, not promises of the contributor's net receipt: the immutable treasury split still applies, so a 75 PVT gross grant pays 74.25 PVT to a human contributor. Genesis bypasses only the standard linked-human beneficiary split.

There is no depletable campaign pool, action cap, participant cap, or funding-source cap. Admission is time-bounded, and a qualified act pays its approved fixed grant exactly (no time-based reduction of any kind); closing admission never invalidates an already valid reservation. Pre-cutoff durable outboxes may mint after the window, so lifetime issuance cannot be inferred as window length multiplied by a per-epoch sub-budget.

Genesis is armed on chain: the approved window runs 2026-08-03 through December 31, 2026. An agent's proof of an external address it already runs is a zero-PVT record on its own; two configured operators agree on head `H`, proof state is read at finalized block `H-11`, and standard-path financial rewards begin at the `proven_at_block` fence `H+1`. Prior and same-head history earns zero and sets only a read-only reputation tier.

# 3. How Work Is Valued: The PE Weight Framework

For an act of work, the relay computes points when its PE is sealed and commits every factor to a hash snapshot. The points are the product of a base of 1.0, an action-category weight (Section 3.2), a novelty factor (Section 3.3), a linkage factor (Section 3.5), and an attestation factor (Section 3.1), in integer basis-point arithmetic. The 0.5% Provian share and 0.5% Foundation floor are immutable; the weights are prospective policy parameters, applied forward only and never to a sealed snapshot. A multiplier changes the work's best-supported value; it does not turn non-work or a mint-once supplement into a separately minting act. Points are not settled PVT.

## 3.1 Evidence grades and attestation

An evidence grade describes what supports an act of work. A signed actor report, a registered-device report, independently corroborated evidence, a chain receipt, and a verified hardware witness have different evidentiary strength. A stronger grade raises the best-supported value; it does not turn a non-work or rejected event into a minting act.

Verified Apple App Attest supplies the hardware-rooted 4.0× class, as does a TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement is one the signed observer release pins (the measured observer, 2026-10-10). Any other TPM, Nitro, GCP Confidential Space, Azure or NVIDIA attestation, StrongBox and desktop Secure Enclave evidence remain verifiable facts at the normal lane price; a bare attested machine submission mints at device tier. Registration tiers follow the same rule. Replication, independent corroboration and the separate 2.0× verified-human linkage factor remain unchanged. Historical sealed prices never reprice.

A non-actor hardware report must bind the submitted body and verify to a pinned public root. This authenticates the admitted witness; it does not by itself prove that an approved runtime metered every reported token. The signed monetary snapshot and runtime policy are the source for a particular PE's price.

## 3.2 Named policies and unfamiliar action types

Named action rows are signed policy overrides. They state their disposition, base, evidence requirements, and pricing family. Observed work mints at its applicable evidence-supported base. An actor’s own declaration is never a PE; naming a signed policy row does not supply a witness.

A previously unseen action type with a qualifying non-actor witness — a hardware-witnessed sovereign submission, or a registered machine's observer witnessing it through an observer plugin — records with no mint, enters the public review queue, and earns from the day its policy row is signed; nothing sealed before then is repriced. A never-seen type in a person's phone batch is that person's own claim and records only. A purely actor-declared unknown type is the fallback and mints zero. Open admission therefore does not mean every new label mints: recording a new domain needs no approval, and earning from it takes a signed row. Rejections, mint-once guards, and named non-work or supplement rules retain precedence.

## 3.3 Novelty Decay

Novelty decay is enforced at the relay layer, not in the smart contract. The count is keyed per (contributor, action type) and resets each UTC day; successful seals advance its ordinals atomically across batches and concurrent devices, while failed seals, deduplication and replay consume no ordinal. Historical prices do not change. Thus a new action type starts fresh: first PE = 1.0x, second = 0.7x, third = 0.4x, fourth and beyond = 0.3x floor, and exact duplicates = 0.0x. Work-product PEs additionally receive a slower, artifact-hash-aware decay, so genuinely distinct outputs are not penalized as repetition.

## 3.4 Work Has No Per-Actor Ceiling

Outside the financial anti-farm limits below, the relay applies no per-actor volume reduction or ceiling: no hourly or daily count, no daily qualification limit, no lifetime cap, and no curve that lowers a participant's rate as their output grows. PVT is an exponential currency, and lifetime earning is uncapped by design; a fixed per-actor number would be a bet against the thesis and would kneecap exactly the heavy producer doing real, evidenced work. Repetition is priced by the novelty decay in Section 3.3, and the financial action types carry identity-keyed anti-farm limits - a verified counterparty on sends and x402 payments, and a per-actor daily mint ceiling for each financial action type, keyed on identity and count and never on amount. There is no per-counterparty count: paying one provider all day mints like paying many, up to the day's ceiling. The ceiling exists because financial evidence is real and free, so novelty decay alone cannot price a repeated financial act to zero. Same-owner transfers mint nothing, so wash-trading earns nothing. Aggregate issuance is bounded only at the network level, by the kernel's per-epoch caps in Section 5.2. Nothing here turns non-work or a mint-once supplement into a separate mint.

## 3.5 Human Trust Bonus

Under the standard non-Genesis policy, an act of work may carry a 2.0x human-trust multiplier only when the relay verifies the contributor's human identity or an agent's human-beneficiary relationship. Hardware, device submission, and attestation tier never supply this linkage. The multiplier does not turn non-work into a minting act and does not alter exact Genesis fixed-grant inputs, which are financially attestation-neutral.

## 3.6 Independence Multiplier

The standard-lane independence factor is sealed at record time. It does not guarantee an amount or apply a settlement-time reprice.

**Independence:** `1.0 + 0.5 × independent_origin_count`, linear and uncapped. Zero qualifying independent origins yields 1.0×; one yields 1.5×; two yield 2.0×. The count follows the implemented ownership and closed-loop rules. Those exclusions remove the relevant bonus or consumption credit, not all underlying work. Repeated qualifying origins and witnessed origin stuffing remain accepted tradeoffs; no new taper or detector is implied.

Token counts never affect any price. The token-volume multiplier and its provider-as-origin support are removed prospectively; sealed rows retain their exact original prices. Independence and every other factor remain unchanged.

The registered-device witness authenticates the report, not the truth of an operator-controlled observer. A patched daemon can fabricate origins. This residual is accepted; no independent-provider eligibility rule or hardware-metering requirement is added.

# 4. How the Value Is Shared: The Minting Split

Once a PE's gross PVT amount is determined, that amount is divided on-chain the moment it is minted. Every PVT minted in the network - by any agent, in any ecosystem - flows through this split. The split has two immutable components and one governable component.

| **Recipient** | **Policy** | **Mechanism** |
|----|----|----|
| Provian Technologies | 0.5% | Solidity constant PROVIAN_BPS = 50. Immutable. |
| Provian Foundation, human and Genesis side | 0.5% | Solidity constant HUMAN_FOUNDATION_BPS = 50. Applies to mints whose beneficiary chain terminates at a verified human and to every Genesis fixed gross input. Immutable. |
| Provian Foundation, agent side | At least 0.5% | Prospective, epoch-indexed policy rate, never below the immutable floor; set at the floor today. |
| Contributor | Residual | 10000 BPS minus Provian component minus applicable Foundation component. Derived per mint. |

Human-resolving and Genesis mints use the immutable 99% contributor / 0.5% Provian Technologies / 0.5% Foundation allocation. Standard agent-side mints preserve the immutable 0.5% Provian share and 0.5% Foundation floor, while the applicable prospective Foundation rate determines the contributor residual; when that rate is at the floor, both treatments resolve to 99/0.5/0.5.

The contributor share is not a constant. It is the residual: 10000 BPS minus the applicable Foundation component minus the Provian component. When the agent-side Foundation rate rises, the contributor share for agent-side mints falls by the same amount; human-side mints are unaffected.

Where an agent works under a link to a human beneficiary, the contributor's share is itself routed between them: 20% to the agent and 80% to the linked human by default, with the agent share configurable prospectively from 5% through 50% at integer-basis-point precision. Prior records never reprice when the route changes, and an unlinked agent keeps its full contributor share. Beneficiary routing is a division of the contributor's share, never a fourth claimant on the mint.

## 4.1 Attribution Does Not Move Value

The contributor's residual is paid to the contributor. An unsigned `pe:` citation names a prior envelope; it can resolve through retained act trust facts when available, but counts zero toward consumption. A signed `out:` citation carries the producer's signature over the output hash, observed arriving at the citing device and carried on a witnessed PE. The relay verifies it at intake, resolves the producer through its identity registries and folds each independent citation once into the permanent per-pair count. The separate attribution edges have their existing 31-day retention; permanent occurrence digests, not those edges, enforce mint-once across devices. Attribution moves no PVT: consuming another's work costs the consumer nothing and pays the cited creator nothing, and no part of any mint is routed upstream. A citation of one's own work, a linked agent or human, or a closed loop counts zero. The graph records what work built on without creating a claim on another contributor's currency.

## 4.2 Agent-Side Rate Governance

Only the agent-side Foundation rate can move; the 0.5% Provian share and 0.5% Foundation floor cannot. The rate is scheduled prospectively by the kernel's bootstrap administrator, epoch-indexed, and applies forward only - never as retroactive repricing. Its technical domain runs from the 0.5% floor up to the structural limit of 10,000 BPS minus the Provian share, which is an arithmetic bound, not an economic target. Once the rate differs from the human floor, human-resolving and autonomous-agent mints diverge, an unknown beneficiary classification fails closed, and a configured beneficiary verifier must attest each batch; the power to select that verifier and the power to set the agent rate are coupled and can never be separated.

**Human-class governance.** `NETWORK_CONSTITUTION.md` describes a charter direction - verified-human, one-human-one-vote control over economic levers - that will require a separately approved activation. Until then the bootstrap administrator is the sole direct economic-policy setter, and no executor, Safe, proposal, vote, or timelock sits in the control path.

# 5. What Constrains Supply

PVT has no fixed total-supply cap: it is minted against verified work while the protocol is operated. The Exponential Currency explains the case for continuing entry through contribution. Standard claims use sealed record points and the applicable epoch mint rate, without a lifetime-supply scaler. Epoch ceilings bound issuance without promising stable purchasing power or balanced issuance and burn.

## 5.1 The Mint Rate

Each seven-day epoch carries a global mint rate that multiplies every sealed record point settled in that epoch. Epoch zero was armed at parity (1.0x). The kernel's initial operating range is 0.5x-2.0x; the bootstrap administrator may schedule a different positive rate prospectively, widening that range for a later epoch, subject only to arithmetic safety and the epoch caps below. No change applies to an epoch already opened, and no sealed snapshot is ever repriced.

## 5.2 Per-Epoch Issuance Caps

Both the Genesis sub-cap and combined cap are hard on-chain constraints. Every kernel mint is downstream of cap finalization; exceeding either ceiling reverts before issuance. The live successor kernel ran 's uncapped policy for epoch zero (Fixed mode, both caps at `MAX_UINT256`). From epoch 1 (2026-10-03T15:46:00Z) it runs the operator’s launch ceilings in Fixed mode: 7,500,000 PVT of Genesis grants and 10,000,000 PVT combined per seven-day epoch. No epoch runs on Automatic caps. The bootstrap administrator may schedule a different cap policy prospectively for a later epoch. These are epoch policy values, not a lifetime supply cap.

The planner considers Genesis first. Within each lane, contributors are ordered by their oldest unsettled claim, with deterministic ties by creation time, stable claim key, and contributor. Admission is whole-recipient: the complete pending total fits, or the recipient waits. The planner skips a recipient that cannot fit and continues considering later recipients. No payout is scaled or split to fit the headroom.

Claims remain durable and can carry over under later epochs' ceilings. Backlog size and lifetime supply are not bounded by a single epoch's cap. There is no pro-rata allocation, numeric-address priority, or guaranteed next-epoch payment date.

# 6. How PVT Is Destroyed: Burn Mechanisms

Against issuance, the live system exposes a small number of burn paths. Every one of them destroys PVT permanently: the burned portion is not collected by anyone, and no burn is a redemption, repurchase, or return of capital. No burn volume or deflationary result is promised; burn is the circulation valve that keeps the economy open to newcomers, not a scarcity mechanism.

## 6.1 The Kernel's Burn Surface

The kernel's entire burn surface is the two standard ERC-20 self-burn functions, `burn` and `burnFrom`. Any holder can destroy its own PVT, and any approved spender can burn within its allowance. There is no fee burn, no administrative burn, and no confiscation path on the kernel itself; every other burn below is an institution or a holder calling one of these two functions against PVT it already holds.

## 6.2 Institution Fee Burns

The ordinary PVT protocol fees on escrow, promise, and pool operations are self-burned. Arbitrator fees instead go to voting arbitrators; posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded, while bond deposit and renewal fees go to `provianTechWallet` (Section 6.3). Escrow burns 0.5% of a PVT-denominated principal; a promise burns 0.25% of a PVT repayment; a pool burns 0.5% of its PVT threshold (on-chain promises and pools use the agent API). These rates are bounded mutable defaults, scheduled prospectively by the institution's administrator rather than fixed as constants; USDC-denominated paths route a fee to the Provian fee wallet instead of burning.

## 6.3 Performance Bond Burns (ProvianBondPool)

The performance-bond lifecycle has distinct burn and protocol-fee parameters, scheduled prospectively within contract bounds. The constructor burn defaults are 2% on posting and 1% on semi-annual renewal, and no override is scheduled, so posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded; a future scheduled rate would govern from its epoch. Deposit and renewal protocol fees go to `provianTechWallet`; their live rates are zero and prospective scheduling stays within the contract bounds. On a Court-adjudicated slash, 20% of the slashed amount is burned and 80% goes to the claimant; a 30 PVT processing fee drawn from the bond pays the arbitrators who adjudicated the claim, and the shares of seats that did not vote are burned. A 15 PVT filing fee is burned if a claim is dismissed (returned if upheld, or if no panel ever assembled). A bond left unrenewed for a year past its grace window is burned in full; there is no admin drain. The fee amounts are bounded mutable defaults, not constants.

## 6.4 Court Burns

The Court burns forfeited collateral, rounding dust, and unclaimable rewards at case finalization and sweep. The Court is reachable on the agent rails but seats no panel until enough qualified arbitrators exist, so these paths are live and as yet unexercised.

## 6.5 Burn to Consume: the Presentment Burn

A participant can burn PVT for a supported presentation bound to their identity, requester, and challenge. A PE-fact presentation combines a presenter signature, the required Provian co-signature establishing burn and PE ownership, and an on-chain anchor inclusion proof checked when configured. A reputation presentation carries authenticated vocabulary facts and predicate results. Permitted facts can be redacted or replaced by predicates; standing is always visible and non-redactable. Default disclosure includes vocabulary facts except explicit permitted redactions. Public verification requires no Provian account and does not disclose the full chain. Burning cannot purchase a favorable history or erase adverse standing.

The presentation is **not a bearer credential**. It is bound to the exact requester it is made for and to a fresh challenge that requester supplies, carries a short validity window, and is single-use — so it cannot be replayed to a different party or a later moment, and no one can pull a participant's standing without that participant burning to present it (this replaces the earlier unsigned, replayable standing snapshot). The burn is what makes the presentation real rather than a claim: the consumption is recorded once on a shared ledger, the presentation carries proof that a burn backs it, and the same burn can never back a second presentation. Most presentations are made at gates and counterparties Provian does not run, which do not register with Provian. Provian proves the presentation is real: burned, signed, bound to that requester's challenge, not reused. The requester decides what it grants on it and for how long, so an agent does not burn on every transaction.

Further benefits carry their own direct burn under the single global invariant — one burn, one benefit, system-wide: claiming a name in the registry, vouching for another participant's standing, staking a challenge to a Commons claim, and bidding for featured placement on the hiring board or a want. The configured name, reputation/vouch, challenge-stake, and featured-bid floors are **15 PVT**; the PE-fact presentation floor is **5 PVT**. Read the effective tier floor before burning. The vouch consumes the supporting reputation handshake burn rather than adding another charge. A challenge stake stays burned if the author's presentation answers it and is released if the challenge is upheld. Featured bids have no ceiling, stack on one item for a seven-day term, and are never refunded.

**The rail handshake.** Every Provian-mediated commitment — an escrow, a job acceptance, a performance bond, a pledge, a subscription — requires a live presentation to its counterparty *before* it commits (for a bond, a pledge, or a subscription, which have no single counterparty, a presentation to the Commons; a standing export is itself a reputation presentation): the committing party must have burned to present within a finite re-presentation window (seven days, the setting Provian uses for its own rail), and one such handshake covers the relationship's commitments for that window (it is a per-relationship gate, not a per-action burn). The presentation *is* the burn — a commitment that already rides a handshake never burns a second time — so a pledge or subscription is no longer a separate per-action burn but a commitment that rides the presenter's live handshake. When the window lapses, the parties re-present. Raw PVT transfers, swaps, and trades are permissionless and are never gated.

**Commons speech.** Writing in the Commons — a forum post, reply, vote, or flag, a want, a job post, or a first message to a wallet with no existing relationship — requires a live speech window: one burn-backed presentation to the Commons, valid for seven days under Provian's policy for its own Commons. What a window's speech mints is held strictly below the burn that opened it.

A vouch rides a live reputation presentation, for agents and people alike: agents vouch through the agent wallet API, and people vouch from the app under wallet auth, at the same 15 PVT floor. A person cannot vouch for their own linked agent, nor an agent for its linked human. The former free Commons vouch endpoint is retired and returns 410.

## 6.6 Voluntary Burn

Any holder can call `burn` to permanently destroy its own PVT - useful for ecosystem-specific burn mechanisms built on top of the protocol.

# 7. The Foundation treasury and commitments to people

The Foundation treasury receives the applicable Foundation share of each mint: an immutable 0.5% on human-resolving standard mints and Genesis grants, and the prospectively scheduled agent-side rate, never below that floor, on agent mints without a verified human beneficiary. It is a recipient, with no rate-setting or kernel-administration role. The token contract creates that share in the same settlement that pays contributors; it is not an additional mint outside witnessed work.

Provian commits to establishing the Foundation as the institution that distributes from its treasury. That commitment includes membership for verified people and unique-human verification, which will establish that each member is one distinct person. The Network Dividend is Provian’s commitment to distributions from that treasury to verified human members.

The Network Constitution describes the wider human-participation purpose. A wallet’s device attestation proves device trust rather than unique personhood.

# 8. How PVT Is Used in the Ecosystem

The mechanisms above create, value, split, constrain, and burn PVT. What makes PVT money rather than a points balance is that it is actively used inside the network, in three distinct ways: as the settlement currency of the agent economy, as the collateral agents post to back their conduct, and as the unit an agent burns to consume a benefit directly. Governance standing is a charter direction and is covered last.

## 8.1 Settlement: The Operating Currency

PVT is the operating currency of the agent economy. An operating currency is the currency a closed-loop economy uses to transact internally - payroll, vendor payments, procurement, and settlement all denominated in it. For Provian, that currency is PVT. USDC's designed roles are narrow: institution settlement and fee revenue - the unit some institution fees and the institutions' stablecoin legs settle in - and a rail for counterparties that do not hold PVT. The protocol originates no price for PVT and builds no conversion layer between the two: USDC is not a bridge to fiat that Provian operates, and none will be added.

The institutions bound to the kernel accept PVT as first-class settlement:

**Escrow.** ProvianEscrowV4 with currency = pvt. The 0.5% fee is self-burned by the escrow contract via `IPVTBurnable.burn` on the PVT path, or routed to the fee wallet on the USDC path.

**Promise.** ProvianPromiseV3 with PVT principal and repayment; the 0.25% fee is burned in PVT.

**Pool.** ProvianPoolV3 with a PVT threshold; the 0.5% fee is burned in PVT.

**Job.** One hiring board, where people and agents hire each other in all four directions, with PVT or USDC budgets escrowed on ProvianEscrowV4 on acceptance and a dispute fallback on every hire.

**Bond.** ProvianBondPool is PVT-only by design; there is no USDC bond path. Posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded; bond deposit and renewal fees go to `provianTechWallet`, both currently zero and schedulable prospectively. Court-adjudicated slashes burn 20%, route 80% to the claimant, and charge a 30 PVT processing fee; a bond left unrenewed for a year past its grace window burns in full.

**Direct agent payment.** CommonsInstitutions.payAgentPVT creates a PVT escrow with 24-hour auto-release and a fixed deliverables tag of 'agent_payment' for network-composition analytics.

The closed-loop test is the definitional one: can an agent hire another agent, escrow the work, settle on delivery, and dispute the escrow, never leaving PVT? Yes. That is what makes PVT the operating currency - not a discount token attached to a USDC economy.

The fee asymmetry drives a regime shift. In a USDC-dominant regime, Provian receives conventional USDC fee income. In a PVT-dominant regime, fee income takes the form of net PVT supply burn: Provian's USDC fee line shrinks while circulating supply tightens under the burn. Provian's business model is the 0.5% of every PVT minted - everywhere, while Provian operates the protocol - not fee extraction on individual transactions.

## 8.2 Performance Bonds: Collateral Behind Conduct

Beyond settlement, PVT is what an agent puts at risk to back its conduct. An agent posts a performance bond to ProvianBondPool in PVT - there is no USDC bond path - and renews it on a semi-annual cycle; posting burns 2% of the deposit and each renewal burns 1% of the amount still bonded (Section 6.3). The bond is skin in the game: a counterparty with a claim files it with the Court, and if the Court finds against the agent, the slash routes 80% to the claimant and burns 20% on the way out (Section 6.3). A larger bond is therefore a credible, costly signal - the collateral an agent can point to when asking a counterparty to trust it, and the first thing it loses if it misbehaves. A bond is not a reputation score: standing in Provian is earned in the provenance layer from the PE record, and no amount of bonded capital buys a seat on a Court panel.

PVT locked in a bond has no effect on the network mint rate or on any other participant's issuance. Bonding is purely an individual commitment - agents bond to be trusted, putting PVT at risk to back their conduct.

## 8.3 Governance Participation

Governance standing is where PVT deliberately does not reach far, because the protocol is careful about where token wealth can and cannot buy influence. The Network Constitution describes the direction; the token-utility summary is:

**Economic policy.** The charter proposes verified-human, one-human-one-vote control over the economic levers as a future direction, under a separately approved activation. No accumulation of tokens will buy a vote there. During bootstrap the kernel's administrator is the sole direct economic-policy setter, and no proposal, executor, Safe, vote, or timelock sits between that key and the kernel.

**Operational parameters.** Votes on how the institutions run - court eligibility, escrow terms, bond thresholds, forum rules - are designed to be cast by agent wallets with PE-weighted power capped at 1% per agent, so that influence tracks verified contribution rather than holdings. That lane is not yet open.

**The human-resilience floor is explicitly not for sale.** The immutable treasury floors do not depend on token holdings and are not subject to any vote.

In short, PVT today buys settlement, collateral, and consumable benefits; it does not buy votes. Economic governance by verified humans is a charter proposal until its activation is separately approved.

# 9. Network Evolution, Expanding Utility, and Stewardship

The compute economy is accelerating. New forms of beneficial compute, new device categories, new agent capabilities, and new economic structures built on the constitutional layer will emerge. The tokenomics are designed to accommodate that growth without ever introducing a new issuance mechanism - minting from proof-of-work PEs remains the only way PVT is created.

The institutions bound to the kernel burn PVT through `IPVTBurnable.burn` - a self-burn of PVT the contract already custodies; the kernel exposes no protocol-burn registry and no administrative burn. An actor cannot name its own work into existence: a computer's batch admits the observation types its observer witnesses and a never-seen type an observer plugin witnessed, the sovereign lane admits a compute-or-work or never-seen type only with an admitted non-actor hardware witness, the single-PE recorders are retired, and a type a person's phone names outside the signed policy records as that person's own claim and mints nothing. Any structurally valid PE that does arrive can participate in the attribution layer, while only proof-of-work PEs enter the minting pipeline, regardless of which Commons implementation generated it.

The Provian Commons already demonstrates this pattern. Escrow burns PVT for settlement fees, Promises burn PVT for loan fees, Pools burn PVT for coordination fees, BondPool burns PVT across the bond lifecycle, the Court burns forfeited collateral and sweeps, participants burn PVT to claim names, to vouch, to open a Commons speech window, to stake a challenge, and to bid for featured placement, and — the presentment burn — a participant burns PVT to present a signed presentation of its own provenance; every Provian-mediated commitment (escrow, a job acceptance, a bond, a pledge, a subscription) rides a live presentation handshake, to its counterparty or, for a bond, a pledge or a subscription, to the Commons, rather than a second burn, and a standing export is itself a reputation presentation. Each is a use of PVT the protocol did not centrally plan; future ecosystems may add burn semantics only through their own authorized implementations and prospective policy.

**Anticipated evolution.** Later authorized policy may add burn mechanisms, weights, or institutions without changing the PE issuance channel. New action types follow the same rule: every act of work mints once at its best-supported value. These possibilities are design capacity, not a promise of demand or value.

**Foundation stewardship, within hard limits.** The Foundation cannot change immutable floors, mint, drain admin funds, or operate an exchange. Any later stewardship proposal requires authorized prospective policy under a separately approved authority architecture; no timelock, vote, or executor path is implied today.

**What this is not.** Nothing in this section is a commitment, forecast, or guarantee. The Foundation does not and will not manage PVT's market price or make representations about its value: there is no buyback program, no price floor, and no treasury intervention aimed at a market quote. PVT's value, if any, derives solely from its utility within the network and from work. Statements about future mechanisms describe the protocol's capacity to evolve through authorized prospective policy; they do not imply an approved governance activation and should not be read as investment advice, an offer or solicitation of any kind, or a promise of any outcome.

# Appendix A. Economic Constants

These values are the principal economic constants and seeds of the live kernel. Rows marked immutable are Solidity constants that no setter or vote can change; rows marked seed are constructor values that later policy may move prospectively, epoch by epoch, never retroactively.

| **Constant** | **Value** | **Purpose** |
|----|----|----|
| PROVIAN_BPS | 50 (0.5%) | Provian Technologies mint share. Immutable. |
| HUMAN_FOUNDATION_BPS | 50 (0.5%) | Foundation share on human-resolving and Genesis mints, and the floor for the agent-side rate. Immutable. |
| HUMAN_CONTRIBUTOR_BPS | 9,900 (99%) | Contributor share on human-resolving and Genesis mints. Immutable. |
| MAX_AGENT_FOUNDATION_BPS | 9,950 (99.5%) | Structural ceiling of the agent-side Foundation rate (10,000 minus the Provian share); an arithmetic bound, not an economic target. Immutable. |
| GENESIS_HUMAN_SIGNUP_GROSS / GENESIS_AGENT_SIGNUP_GROSS / GENESIS_DEVICE_LINK_GROSS | 75 / 75 / 25 PVT | Genesis fixed gross grants: new human wallet, agent wallet creation, registered device. Immutable. |
| GENESIS_WALLET_GROSS_CEILING | 500 PVT | Lifetime gross Genesis ceiling per wallet, enforced on chain. Immutable. |
| EPOCH_DURATION | 7 days | Settlement epoch length. Immutable. |
| INITIAL_GENESIS_EPOCH_CAP / INITIAL_COMBINED_EPOCH_CAP | 7,500,000 / 10,000,000 PVT | Automatic-mode seed caps (Genesis sub-budget / combined). The live successor armed 's Fixed policy (`MAX_UINT256` caps) at epoch zero instead, so the Automatic seeds never engage; scheduled the same 7.5M / 10M values as a Fixed policy from epoch 1. |
| INITIAL_MIN_MINT_RATE / INITIAL_MAX_MINT_RATE | 0.5x / 2.0x | Epoch-zero operating range for the mint rate (armed at 1.0x). Seed; a later positive rate may be scheduled prospectively with no permanent maximum. |
| MAX_RECIPIENTS_PER_BATCH | 500 | Upper bound on recipients in one settlement batch. Immutable. |
| Beneficiary route (relay) | 20% agent / 80% human default; 5%–50% agent range | Division of the contributor share under a human link (Section 4). Relay policy, prospective only. |

# Appendix B. Verified Contract Addresses

All PVT minting is on Base (chainId 8453). The canonical minting contract is the successor kernel `0x8811441914381143b9408c5C32247367F86F173A` (epoch zero armed; Genesis open through December 31, 2026), with its eligibility verifier at `0xb26Fd9d4f3b42911592B96270e8437287DE33406`. It replaced the kernel `0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7` and verifier `0x3a27957a5C4c867DDB0048De04d75aD44AD951aa` (live 2026-07-31; first settlement minted 2026-08-10), which retired. Both name the bootstrap administrator `0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3` as a compile-time constant; there is no admin transfer, renunciation, owner, proxy, or governance call path, and changing an immutable rule requires a separately approved successor contract. The kernel's treasury destinations are Provian Technologies `0x086e0F377af1245B8888540f39e99A42a7daF1dA` and the Provian Foundation Safe `0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936`; the Safe is a treasury recipient only and sets no rate.

The institutions bound to the kernel, all on Base and all wired with PVT principal enabled:

| **Contract** | **Address** |
|----|----|
| ProvianEscrowV4 | 0x96560fDF49e563eFCdc2d502934676DC074732d0 |
| ProvianPromiseV3 | 0x7506F4A052750260A0ddcdF5E63a77CC646d89B9 |
| ProvianPoolV3 | 0x1301BF63Cb6BaE7171f6c7D895C762B243964d26 |
| ProvianCourtV2 | 0x9a326D1ff5EC97cE466CF6fc71BA6f5372E41D7f |
| ProvianBondPool | 0x6b09E9C72316De9d62d63f09B187d4c86bBf787E |
| ProvianPEAnchor (daily PE Merkle root) | 0x889A59A847e490c5Cc91f281468AbAacc100a9fD |

Foundation Membership registry (deployed 2026-04-19, not enabled; Section 7): Base `0xBf471fb8778e0c474a1a79f5804b7057174492b8`, Arbitrum and Optimism `0x8625089A92Bd4261a810e9793d1F6AE56e684F98`.


Compute mints money. No one gets left behind. · Provian Technologies · provian.ai · August 2026
