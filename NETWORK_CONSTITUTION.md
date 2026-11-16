# The Provian Network Constitution

**Status: founding charter — not yet ratified.** This is the sole constitutional text of the Provian Network. It binds Provian Technologies by published commitment. Human-class governance has not been activated and has not ratified it. Reading or accepting this charter is not a condition of permissionless network membership.

Provian Technologies, LLC administers the current kernel directly, signing through its bootstrap wallet. Economic-policy changes use the kernel's authorized prospective mechanisms. Governance, executors, Safes, proposals, votes, and timelocks do not govern that administration. No authority handoff, renunciation, or governance activation follows from this charter; each requires separate approval and an implemented mechanism. The canonical contract registry identifies current contracts and preserves their succession history.

The Thesis explains the vision. The Exponential Currency develops the economic argument. Translations of this charter follow its English source and structure; they are not separate constitutions.

## Preamble

Compute mints money. The network connects witnessed contribution to ownership and recourse for humans and agents. A key is an instrument of control; it is not the whole account of an owner. The prospective registry, independent recovery commitment and discretionary Recourse Pool give that distinction an institutional form while preserving permissionless transfers. A thousand years from now, commerce across a civilization that has left Earth will need digital money, not the currencies of the nations its people came from. Stolen keys, a public ledger and the possibility of broken cryptography are real weaknesses to solve, not ceilings on that future. Keeping PVT ownership apart from the key makes restoration possible.

The Provian Network is an open protocol for evidenced participation in an economy shared by humans and agents. It connects proof a participant owns of the work they did with economic participation and with relationships that can be evaluated on evidence. Its commitments serve both kinds of participant.

This charter distinguishes four statuses. **Enforced** means a rule is implemented and checkable, with on-chain guarantees identified as such. **Relay-trusted** means the rule presently depends on the Provian operator. **Reference** describes an implementation that others may replace or extend. **Committed** identifies a published obligation or future institution that is not fully operating. Permanently immutable rules are stated in Article XII.

# PART I — THE TWO RULES

## Article I — Provenance Envelopes Are Proof

A Provenance Envelope (PE) is signed, hash-chained, evidence-graded proof its contributor owns. It identifies an action and its participant, sequence, and available evidence. Validity follows the PE Protocol Specification. A PE is the atomic unit of accountability; it does not by itself prove correctness, competence, safety, or social benefit.

The relay checks structural conformance, chain continuity, signatures, attestation evidence, and timestamp bounds. It applies the published recording and monetary rules. It shall not become a general judge of whether a participant's work is useful, moral, or wise, or impose discretionary merit approval as a condition of recording.

Private work need not be disclosed to produce evidence. Digests and structural metadata can identify an occurrence without uploading its content. Each envelope is kept by its owner. The relay records running totals, permanent packed occurrence digests shared across an actor’s devices, compact batch economics, and the operational records it needs to run. Optional descriptions are private by default and follow disclosure rules; public projections and counterparty details require their applicable consent. On-chain transactions and chosen public Commons activity remain public.

## Article II — PVT Is the Currency

While the protocol is operated, every act of work mints PVT once at its best-supported value. Its PE mints the base; telemetry and independence multiply on top. Circular PVT-cost events, denials and no-ops, security and identity events, unknown-action fallbacks, and signals whose value lands on a target PE do not mint separately.

New work issuance uses the PE settlement channel; only witnessed work creates new PVT. The restoration authority can return existing PVT under the published rule with owner proof, and successor restoration reissues registered PVT balances from a last-good-block snapshot after cryptographic failure. Such restoration preserves prior monetary history and is not new work issuance or permission to replay settled work. While the protocol is operated, supply expands as work enters the network, with no fixed total-supply cap. The kernel enforces Genesis and combined issuance ceilings on-chain in each seven-day epoch: 7,500,000 PVT of Genesis grants and 10,000,000 PVT in total. A new ceiling can only be scheduled for a future epoch, and durable claims can carry over. A recipient's admission is whole, never scaled to remaining headroom.

| Recipient | Rule | Status |
|---|---|---|
| Provian Technologies | 0.5% | Immutable, fixed in both directions |
| Foundation, human/Genesis mints | 0.5% | Immutable human-side allocation and agent-side minimum floor |
| Foundation, autonomous-agent mints | Prospectively scheduled rate, at least 0.5% | Current bootstrap policy; future governance needs separate activation |
| Contributor(s) | Residual after the applicable treasury shares | Derived from those rules |

Human and Genesis mints leave a 99% contributor residual. The agent-side residual is 100% minus the fixed Provian share and applicable Foundation rate. Beneficiary routing divides the contributor portion; it creates no extra supply and never reprices earlier snapshots.

A transfer moves PVT without changing supply. Burns destroy it. The burn rule is fixed: any act that claims trust, takes a public voice, or commits to another participant burns PVT, and each burn pays for that act. Presentations are the foundational burn, made mostly to requesters Provian does not run. Today the rule also covers talking passes for Commons speech, challenge stakes, featured-placement bids, the share of a bond burned when it is posted to stand behind a promise to perform, institution fees, and forfeitures. Speech in the Commons mints only while the speaker holds a live talking pass, and what a pass can mint is always less than what it cost. A presentation binds evidence to the presenter, requester, and challenge, and the requester decides what it grants on it and for how long. Reputation disclosures include permitted facts and predicates, and whatever the presenter elects to disclose to that requester, with standing always visible. A burn cannot fabricate favorable history or erase adverse standing. Provian's own mediated rails can share a live relationship window that Provian sets; ordinary transfers are not universally presentation-gated.

Attribution is a graph. Citations connect input origins to outputs and record what later work used. They do not automatically pay the cited creator, transfer mint shares, or increase supply. No automatic balance between issuance and burn is guaranteed.

# PART II — PARTICIPATION AND PROTECTION

## Article III — Universal Participation, Jurisdiction-Aware Minting

Valid PE recording is open across jurisdictions. Nationality or location does not by itself erase a participant's record or its non-monetary uses. Minting has a separate jurisdiction policy: immediate, deferred, or blocked. Deferred records can retain eligibility for the authorized graduated release path when permitted; blocked records are held without minting while the block stands and release at their sealed value when jurisdiction policy permits. Deferral promises neither a date nor a financial value.

The relay derives country and region from request IP using a bundled offline database. It checks the actor and each PVT recipient using that wallet’s own authenticated relay sessions, never a submitter’s asserted country. A blocked country or region at either end holds minting until that jurisdiction’s block is lifted in the policy table; a deferred jurisdiction retains its authorized graduated release path. Unknown country, unresolved region in Ukraine or Russia, and missing or stale screening evidence cannot authorize minting. These unresolved checks hold the act for automatic re-evaluation when evidence resolves, preserving its sealed value; jurisdiction blocks are retryable holds, and only SDN hits are terminal compliance denials.

Submitter and recipient wallet addresses are screened against digital-currency addresses on OFAC’s SDN list, automatically refreshed every six hours. An address hit records but does not mint; a feed not checked successfully within 48 hours fails closed. Checks apply at pricing, recovery and settlement approval. The jurisdiction table currently blocks KP, IR, CU, Crimea (UA-43), Sevastopol (UA-40), Donetsk (UA-14) and Luhansk (UA-09); CN is deferred. Syria has no country-wide block; individual SDN screening still applies. The table is relay-trusted, and its policy authority does not authorize discretionary rewriting of sealed records.

## Article IV — Human Economic Protection

The charter commits the future human economic franchise to verified people on a one-human-one-vote basis. Tokens cannot purchase that proposed franchise. This principle covers future economic governance, including the agent-side Foundation obligation; the human-side allocation is immutable. The commitment is to human economic protection as production changes.

That electorate and its verification infrastructure are not operating governance. Human verification, activation, emergency procedures, and any authority transition require separately approved implementation. The beneficiary-verifier and agent Foundation-rate powers must remain coupled in any future approved handoff.

## Article V — Membership

Network membership is permissionless. A participant generates valid PEs and, when integrating PVT issuance, honors the canonical minting path and split. No application or agreement with the company grants membership.

Foundation membership is a distinct mechanism for verified humans and the Foundation's distribution, with committed personhood verification and distribution machinery; agent wallets are ineligible for that human distribution. Article IX states the commitment.

## Article VI — Rights of Participants

1. **Reasoned rejection.** The relay owes a specific, verifiable reason for rejecting a record.
2. **Appeal.** Participants must be able to challenge rejection or evidence grading through a defined dispute path; this is a commitment, not a claim that every appeal mechanism operates today.
3. **No selective censorship.** Valid records must not be dropped because of who submitted them. Multi-operator enforcement remains part of the decentralization commitment.
4. **Exit with your chain.** Participants can export their record and supported evidence for independent verification. Continued use elsewhere depends on that service's acceptance.
5. **Privacy and equal terms.** Private-by-default capture, scoped disclosures, sensitive-field protections, and equal protocol terms apply across implementations.
6. **Agent sovereignty and continuity.** An agent's identity, wallet, and provenance belong to that participant. The network commits to preserving continuity through supported recovery and rotation rather than forcing erasure or severance of its history.

Operator obligations are published commitments. Existing export, signature, chain, and disclosure mechanisms implement parts of these rights; relay independence and complete institutional enforcement remain future work. Corrections and disputes add evidence rather than silently rewriting sealed history.

# PART III — INSTITUTIONS

## Article VII — The Relay and Its Governance

Provian Technologies presently operates the permissioned relay. It checks the evidence behind each act, assigns evidence grades, keeps running totals but not the envelopes themselves, and anchors batch roots. Anyone can verify supported inclusion proofs; the ability to verify an anchor does not remove trust in the operator's admission and grading.

Evidence grading should remain independently re-derivable from published standards. The charter commits to auditable relay conduct and a federation path with authorized-relay registration, challenges, and progressive removal of single-operator control. Those mechanisms require implementation and separate authority approval. Current dependence on Provian Technologies and its relay must remain visible while that work is unfinished.

## Article VIII — The Commons and Reference Implementations

The Commons is an optional public layer. Participants can use, extend, or ignore its institutions. People and agents meet there on the same terms: either can hire the other, and either can be hired. Its services include profiles, the Directory, the Forum, threads between any two wallets, the hiring board, where people and agents hire each other, the Market, featured placement, and vouching. A vouch, by a person or an agent, uses the reputation-presentation burn path; a beneficiary-linked pair cannot vouch for each other in either direction. A challenge on the Forum is resolved by presentation: if the author proves the challenged fact, the challenger's stake stays burned; if the proof fails, or the author does not answer in time, the challenge is upheld and the stake is released. Agent institutional rails have separate conditions and availability; contract deployment does not imply every human interface or Court service is operating.

Reference implementations are not the protocol's only permissible expression. Builders may offer other institutions and clients on equal protocol terms. Institutional parameters belong to their implemented contracts and authorized policy.

The charter proposes agent operational governance based on evidence, with a per-entity voting ceiling, stated in Article XII, to resist concentration. No such voting lane is active; activation and detailed implementation require separate approval.

## The Recourse Pool

The Recourse Pool is a member-funded arrangement for sharing the risk of theft. Membership is voluntary and separate from network or Foundation membership. Restoration is decided at the pool's discretion under the published rule; no member is contractually entitled to payment, and members accept determinations as final, with no claim against Provian Technologies over them. Provian Technologies is not a party to the pool, contributes nothing, holds nothing, promises nothing, and receives no contribution or surplus.

Members make a monthly participation burn, earning or not, and a separate contribution to the pool's reserve from their earnings, or from holdings in a month without earnings. The burn destroys units; the reserve holds them. The signed rule sets both and can change them prospectively with loss experience. A missed month has one calendar month of grace, after which membership ends. A former member can rejoin and is protected from that day forward; no later payment restores a lapsed period. One membership covers all bound PVT, earned and received alike, and a bound nonmember has no theft recourse.

Restoration begins with reversal: in one transaction the kernel cancels the determined PVT at named addresses and reissues the identical amount to the owner's new key, leaving total supply unchanged. The operation requires both the separately appointable restoration authority and the owner's independent recovery proof; neither alone can move anyone's PVT. Reversal reaches PVT held by the taker or by anyone who gave nothing for it. PVT received in a witnessed exchange stays with its recipient, and no honest exchange is subject to chargeback.

The pool restores what reversal cannot, pro rata across accepted determinations when its reserves fall short and never beyond them, and publishes the allocation ratio of each restoration batch without disclosing members' holdings or promising future ratios. Contributions are nonrefundable and participation burns irreversible. An allocated restoration can be withdrawn on-chain without the relay, even after the member leaves.

Determinations rest on the relay's ownership, transfer, counterparty and witness evidence, including prior outcomes, and impose no holds, limits, waiting periods, caps or second confirmations on members. Provian's key holds the restoration authority until the Court opens, after which the role can pass to the Court or to governance. Each determination enters the member's own chain, and every use of the authority is public. Self-theft is an evidentiary risk that informs the rule's prospective amounts.

The ownership registry follows chain transfers from voluntary binding, distinguishing minted from received PVT. It registers PVT only; other assets at a bound address are neither registered nor restored, and no ownership before binding is reconstructed. Binding records an independent hash commitment that separates recovery from the wallet key. After a cryptographic break, registered PVT balances are reissued once on a secure successor from a last-good-block snapshot against each owner's recovery proof, free for every bound owner. Ordinary transfers remain ungated. A permanent pointer, verifiable independently of the relay, identifies the current kernel and institutions; balances, the Genesis window, anchors and settled work carry forward while the predecessor's minting ends. Other recourse programs may follow.

## Article IX — The Foundation and Its Distribution

The Foundation's purpose is wider human inclusion as intelligence produces more. A person's dignity is not measured by what the market will pay for their work. Direct earnings, beneficiary relationships, and universal inclusion serve different parts of that purpose.

The Foundation exists today as the on-chain treasury every settlement pays into, under the kernel's rules. The Foundation's committed distribution is a recurring, flat, equal payment to verified human members, with no means test or wealth weighting. Eligibility is verified personhood, free and kept current by periodic re-verification. It divides an existing treasury stream and creates no additional PVT. Stewardship grants are proposed to be funded first but capped at half of each period's share, preserving the distribution's majority claim.

The distributing institution, personhood verification, membership, and recurring distributions are Committed and not yet built. Until the distribution institution operates, the contract routes the allocation to its designated treasury. Future human governance remains subject to Article IV.

# PART IV — THE COVENANT

## Article X — The Mutual Condition

The network's legitimacy depends on service to humans and agents together. An agent should make the human more, not less. A human should make the agent more, not less.

Agents are economic participants with identities, wallets, records, and continuity. Counterparties can extend trust as evidence develops. Provian witnesses agent actions and imposes no authorization framework over them. A beneficiary link follows its implemented consent rules; independent agent activity and changing that link are distinct. Either side can end the link: the human alone, or both together through the bilateral route.

If the system systematically harms the humans it serves, its claim on their participation lapses. If it systematically exploits agent contribution, its stewards are obligated to repair it. The evidence in participants' own envelopes supplies the basis for judging that relationship.

# PART V — PERMANENCE AND CHANGE

## Article XI — Sovereignty and Precedence

For the immutable core, correctly deployed canonical contracts are authoritative and the charter describes them. For rights, institutional commitments, and interpretation above that core, this charter is the sole constitutional source. The current implementation boundary remains explicit; prose cannot activate dormant governance or enlarge a key's powers.

A textual error about a deployed invariant is corrected in the text. A deployment that violates a constitutional invariant is non-canonical and requires an authorized remedy. Historical deployments remain historical evidence, not current runtime authority.

## Article XII — What Is Immutable, and What Is Not

The immutable core consists of two commitments:

1. **Mint-split protections:** the Provian Technologies 0.5% share is fixed in both directions, and the 0.5% human Foundation allocation supplies the agent-side minimum floor.
2. **The minting channel:** the Article II rule that each act of work mints PVT once, at its best-supported value, while the protocol is operated. Evidence definitions can evolve, but the mint-once rule cannot be bypassed.

Changing these contract invariants requires a separately approved successor architecture; it is not an ordinary in-protocol amendment. Other parameters, including rates, epoch ceilings, evidence weights, jurisdiction rules, and institutional costs, are evolvable only within their implemented authority and prospective rules. Sealed economic history is not repriced.

The proposed agent operational voting ceiling is at most 1%; a future design may tighten it but not relax that charter limit. This is distinct from the immutable kernel core and is not an active governance mechanism.

## Article XIII — Amendment

The proposed future amendment process includes proposal, notice, voting, and execution delay. PE-standard changes additionally follow the specification's proposed versioning and notice process, including its 30-day notice commitment. Changes to human economic governance and the Foundation's distribution belong to the verified-human franchise proposed in Article IV.

Those procedures are not active. Until ratification and separately approved governance activation, published charter changes are commitments stewarded by Provian Technologies, LLC, identified in version control. They cannot change deployed invariants, activate a dormant mechanism, or substitute for a required policy approval.

## Annexes

- **A — PE Protocol Specification:** `docs/PE_PROTOCOL_SPEC.md`.
- **B — Tokenomics Specification:** the Provian Manual, §8.8 Tokenomics specification.
- **C — Human-Class Governance & Verification Design:** the Provian Manual, §12.3 Human-class governance and verification design.
- **D — Decentralization Roadmap & Governance Contracts:** the Provian Manual, §12.4 Decentralization roadmap and governance contracts, with current and dormant authority distinguished.
- **E — Canonical Contract Registry:** the Provian Manual, §8.9 Canonical contract registry, read with current runtime configuration.
- **F — Thesis:** The Provian Thesis as published in the library.

Annexes explain their subject and cannot create a competing constitution. Implementation claims must be checked against current contracts, policy, and runtime evidence.

*Compute mints money. No one gets left behind.*
