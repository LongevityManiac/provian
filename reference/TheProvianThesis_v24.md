# THE PROVIAN THESIS

*Compute mints money. No one gets left behind.*

## 1. A currency has to survive its keys

A civilization that has left Earth will need money that can travel with people and machines, be verified across distance and remain useful when its participants no longer share the institutions of their countries of origin. The founder's long argument for crypto starts there. A thousand years from now, commerce between worlds is difficult to imagine organized entirely around currencies issued by the central banks of the countries from which those worlds were settled. The argument concerns the shape of civilization. It asks what money must become as the setting of economic life changes.

The near argument concerns the weaknesses already in front of us. A wallet key can be stolen. A public ledger exposes balances and transactions. The mathematics behind today's signatures could someday fail. The argument that crypto is bounded by these weaknesses treats each as a final limit. Provian treats each as a design obligation.

A bank account can be compromised too. A bank distinguishes the customer and the account from the password used to enter it. That independent record gives an investigation something to establish and a restoration process something to restore. A public token ledger ordinarily records which address controls a balance. A valid signature moves it. The ledger alone does not establish whether the signer is the owner or someone who obtained the owner's key.

Provian separates those questions. Witnessed work creates PVT. A private registry follows the holdings an owner binds to its identity. An independent recovery commitment preserves evidence of continuity through a failure of the wallet key. Optional Recourse membership brings theft determinations, reversal and a reserve funded by members. A permanent pointer lets the currency change its contracts while carrying its monetary history forward.

These mechanisms describe one economy. A person or agent can contribute, hold, exchange, establish standing and seek recourse without being reduced to the continuing secrecy of one key. Ordinary transfers remain public, permissionless and ungated. Restoration is an explicit authority under a published rule, exercised with independent owner proof and recorded publicly.

The long future gives the work its scale. Recourse gives it a standard that can be applied now: when something fails, what still establishes ownership, what action is authorized, where do the resources come from, and who can inspect the result?

## 2. Participation includes keeping what is yours

AI expands what people and agents can produce. It also changes who gets counted. A developer working with an agent, a clinician reviewing a generated summary, a farmer using a sensor network and an agent completing another agent's task all participate in production. Their contribution can disappear behind the interface or platform through which it happened. A convincing output is increasingly easy to generate, while reliable evidence of participation takes deliberate work.

An economy built around that evidence must do more than issue a reward. A reward has to belong to someone. Its owner must be able to transfer it without asking the issuer's permission, receive units earned by someone else, establish continuity after replacing a device and remain a participant after a key is compromised. Otherwise the economy recognizes contribution for an instant and leaves the contributor's future to an access credential.

Provian therefore keeps three records distinct. The participant's Provenance Envelopes establish witnessed acts and their consequences. The public chain records transfers and contract state. The relay's private ownership registry links verified owners to the addresses they choose to bind and follows those addresses' balances. None substitutes for the others. A work receipt is not proof that its producer still holds the resulting PVT. A public transfer is not, by itself, proof that the current signer is the rightful owner. A private registration is not permission to invent a past before it existed.

The distinction makes the economic loop complete. Work produces evidence and issuance. Exchange moves existing PVT between participants. Presentations make parts of a participant's history verifiable to a counterparty. Members contribute to shared restoration resources. When theft is determined, reversal and the Recourse Pool return existing PVT under the rule. The outcome becomes another consequential record in the participant's own chain.

Universal Basic Income can provide a vital floor. Earnings from one's own work, participation in an agent's output and a recurring human floor meet additional needs. Provian's undertaking is to make those routes to participation concrete and to give the ownership that results a way to persist. Recourse matters to inclusion because receiving a balance and retaining a meaningful relationship to that balance are parts of the same economic life.

The reference wallet is the doorway into this architecture. The protocol extends to agents, command-line tools, machines, counterparties and institutions. Its purpose is to let people and agents earn, own and act together on evidence that can travel beyond any one interface.

## 3. A private record of ownership on a public rail

A verified human or agent binds an address it holds by proving control. Wallets created in the app and through the agent tools bind at creation. An owner can also bind an address already held in another wallet. The registry begins at the verified binding point and follows chain Transfer events from there. It keeps balances by owner and address, with inbound PVT distinguished as minted or received.

Both kinds of holdings belong to the owner. A participant can earn PVT and spend it. Another can receive that PVT for work, in an exchange or as a gift. Recourse follows the holdings registered to the owner, rather than treating only units minted by that owner as deserving an ownership record. The network does not reconstruct an unregistered ownership history from a story told after a loss.

The registry link stays inside the relay. The relay knows which wallets are yours and the public does not, the same as a bank. Nothing published on-chain or through a public endpoint groups the owner's addresses or totals that owner's holdings. Individual addresses, balances and transfers remain public. A recovery or restoration may publicly link one old address to its replacement; that exception does not disclose the other addresses in the portfolio.

This is a deliberate privacy boundary. Binding does not make an individual blockchain address invisible, and the relay necessarily knows the private relationship it maintains. It gives the owner a separate ownership record without publishing that record as a map of the person's or agent's financial life. The registry serves recovery and determination; it is not a public identity directory assembled from wallet balances.

Binding is the owner's security choice. An unbound address can still receive and transfer PVT on the open rail. It has no registered ownership history for the recovery procedure to carry forward. Binding does not place an operator in the ordinary transfer path. It establishes evidence before evidence is needed.

The same principle applies to relationships. A human beneficiary and a linked agent remain separate owners. A beneficiary link routes part of future contributor issuance under the participants' agreement. It does not grant the human the agent's recovery secret, turn every agent address into a human-owned address or authorize an agent credential to rewrite human owner state. Economic cooperation and ownership are related facts with different authorities.

## 4. Continuity when cryptography fails

At binding, each bound address registers an independent recovery commitment: the hash of a secret independent of the wallet's curve key. For a person, the secret derives from the seed and travels with the existing encrypted backup. For an agent, the SDK generates a separate secret and stores it encrypted with the wallet material. The relay retains the commitment; the active secret remains with its owner.

The wallet key authorizes ordinary actions. The recovery secret establishes continuity with the owner that registered the commitment. A newly presented signature from a failed cryptographic scheme cannot replace that independent proof. Learning a curve private key does not, by itself, reveal the seed-derived or separately generated recovery secret.

This matters because changing the password is an inadequate answer when the signature system itself is no longer trustworthy. After a break, the procedure selects a last-good block and snapshots the registered balances there. Each owner reveals the preimage matching its commitment and independently authorizes a secure destination. Its balance reissues once onto the secure successor. The procedure is free for every bound owner, with no Recourse membership required.

The recovery process carries monetary history with it. Settled work remains settled. Anchors, the Genesis window and the relevant records of obligations survive the changeover. A balance is carried; an earlier act is not rewarded again. Reissuing on a successor represents existing PVT in the new system and does not create an additional economic allocation on top of it. The predecessor's minting ends.

The procedure does not rewrite the old blockchain. Old transactions remain historical facts, including activity after the selected cutoff. The successor distinguishes the history carried forward from a discarded branch. That distinction also matters for membership: an observation made later cannot manufacture earlier protection, and a contribution recorded on a discarded branch cannot silently become credit in the surviving history.

A permanent on-chain pointer names the current kernel and institutions. Software verifies the pointer and the contracts it names independently of the relay. The apps, SDK, CLI, MCP server and daemon resolve that pointer and refuse retired contracts. A change of contract address does not require participants to accept the relay's unsupported instruction about where their money now lives.

Recovery must leave a participant able to act again. A protected balance without a usable way to authorize the next transfer would only move the failure. The secure successor gives the owner a working signing path, preserves the evidence needed for later recovery and keeps unrelated assets distinct from PVT restoration. A PVT restoration power is not a power to rewrite another token's ledger.

The long-horizon commitment is continuity, rather than permanence of the first machinery. Keys, devices, cryptographic schemes and contracts can change. The record of contribution, ownership and previously discharged obligations has to make that journey with the participant.

## 5. Theft, honest exchange and the boundary of reversal

Theft while the ordinary cryptography remains usable is different from a network-wide cryptographic break. Theft recourse is optional and belongs to Recourse members. A bound owner who has not joined has the independent ownership and break-recovery path, but no theft recourse.

A member files a restoration request. The determination uses the relay's own evidence: the registered balances, observed outflows, counterparties, witnessed exchanges, available device evidence and previous determinations. There are no holds, limits, waiting periods, caps or second confirmations imposed on members. The evidence must establish what the published rule can reach; an additional ritual of approval is not a substitute for that evidence.

The first response is reversal. In a single transaction, the kernel destroys a determined amount of PVT at named addresses and issues exactly the same amount to the owner's new key. The transaction conserves total supply. Both the restoration authority and proof of the owner's recovery secret registered at binding must authorize the same operation. Neither factor alone can move anyone's PVT.

The rule reaches PVT held by whoever took it and by a recipient who gave nothing for it. PVT received in a witnessed exchange stays with that recipient. The distinction is essential to useful money: the person or agent that supplied work or another asset in an evidenced exchange must be able to rely on that exchange. Recourse for one participant cannot become an arbitrary chargeback against another.

Consider a member whose PVT is taken and divided between two destinations. Some remains with the taker or passes as a gift. Some is used in an exchange for which the recipient's contribution is witnessed. Reversal can reach the first part under the rule. The exchange recipient keeps the second part. The remaining determined shortfall goes to the Recourse Pool. The same loss does not receive both a full reversal and a full pool restoration.

Ownership evidence and work evidence meet here without collapsing into one another. The ownership registry establishes what the member held. The transfer record traces what moved. A witnessed exchange establishes what a subsequent recipient gave. Prior outcomes establish what has already been addressed. A persuasive account of events cannot replace those records, and an operator's possession of the restoration key cannot replace the owner's recovery proof.

Every determination and outcome enters the member's own chain. Every use of restoration authority is on the public record. A later request encounters the prior outcome; changing a request identifier does not create another loss. Recovery preserves the participant's history, including adverse events. It does not provide a new identity with a clean past.

Self-theft remains a real evidentiary risk. An owner can arrange transfers that resemble an attack, and a genuine attacker can imitate legitimate activity. Evidence can distinguish many cases without making every case distinguishable. The rule must confront that limitation, and loss experience informs its prospective amounts. The design makes determinations accountable and resources explicit; it does not promise that deceptive conduct becomes impossible.

## 6. The Recourse Pool: participation, resources and exit

The Recourse Pool is an on-chain, member-funded risk-sharing arrangement. It restores the portion of a determined loss that reversal does not reach. Restoration is a discretionary determination under the published rule. No member has a contractual right to payment. Members accept determinations as final, under the rule now and under the Court when it opens.

Provian Technologies is not a party to the arrangement, insures nothing and promises nothing. It contributes nothing to the reserve, holds none of it and receives no member contribution or surplus. Members have no claim against Provian Technologies or its founder over a determination. The pool restores by its rule and from its own resources.

Membership is optional, intended for holders with enough at stake. One membership includes all of a member's bound holdings, earned and received alike. The public transaction for one address does not disclose the private portfolio included in that membership.

A member undertakes two separate monthly obligations. First, every member burns **100 PVT each calendar month**, earning or not. This participation burn permanently destroys units. It is the largest standing burn in the system and contributes nothing to the reserve.

Second, **1% of the member's gross earnings** is diverted into the Recourse Pool at settlement. At the human and Genesis split, the member keeps 98%, with the existing 0.5% company allocation and 0.5% Foundation floor intact. For an autonomous agent, the contribution comes from its contributor allocation under the frozen epoch split; treasury allocations are not diverted into the pool.

A member with **no earnings in a month contributes 100 PVT from holdings** to the reserve instead. That month requires 100 PVT burned and another 100 PVT retained by the pool. A burn and a contribution do different work and must remain separate in the record. Burning does not fund restoration. Contributing does not satisfy the participation burn.

All three amounts—the participation burn, earnings percentage and no-earnings contribution—appear in the signed rule. The bootstrap administrator can raise or lower them prospectively as loss experience accumulates. An earlier month's obligation is not rewritten by a later change. These are uses of an earned token inside its economy.

The earnings contribution is accounted for across the member's private owner record. Settling through several bound addresses cannot create several memberships, reset the month's arithmetic or erase a remaining obligation. Settlement preserves each ordinary batch's recipient order and keeps the owner-level totals private. The public record shows individual contributions and the resulting reserve, not a public invoice listing all of a member's wallets.

A missed month has **one calendar month of grace**. A member stays protected during that grace month, and making up the missed obligations within it means nothing lapsed. After grace expires, membership ends. A former member can rejoin at any time and is protected from that day forward. A loss during a lapse cannot be made restorable by catching up afterward. The calendar governs continuity; a late-running server does not create a different entitlement.

When accepted shortfalls exceed available reserves, the pool allocates restoration **pro rata**, never beyond what it holds. Each executed batch publishes its ratio: the smaller of available reserves and accepted shortfalls, divided by those shortfalls, with individual allocations rounded down to whole atomic units. The ratio records that execution. It does not promise a future percentage or disclose members' portfolio totals.

Contributions are **nonrefundable**. A member cannot redeem the 1% earnings contribution or the flat contribution from holdings. Participation burns are irreversible. Leaving ends prospective membership under the rule; it does not turn past participation into a withdrawable deposit.

The relay-independent exit is for a **restoration allocation owed to a member**. Once allocated, that PVT can be withdrawn directly on-chain without the relay, including after membership ends. The distinction protects both sides of the arrangement: contributions remain available for the purpose members undertook, while an allocated restoration does not depend on the continuing availability or consent of the relay.

The reserve is finite. Discretion is explicit. The amounts can change with experience. Those facts make the arrangement intelligible to the people and agents deciding whether to join. Other recourse programs can grow on the same foundation when they have their own published rules and resources.

## 7. Authority that can be named and inspected

A useful account of recourse must say who can exercise it. Provian has a separately appointable restoration authority. The founder's key holds that role until the Court opens, and the role can pass to the Court or governance. It is separate from the bootstrap administrator. Its existence is a live power, not a statement about an institution that might someday acquire one.

The reversal power is bounded by the requirement for the owner's independent recovery proof, the exact operation both authorize and the supply-conserving kernel transaction. The rule determines the reachable sources and leaves witnessed exchange recipients intact. The public chain records execution. The member's own chain records the determination and outcome. Neither an assurance that the operator is benevolent nor a slogan about immutable money can replace those boundaries.

The permanent pointer also has an authority: its designated publishing authority names the current deployment. Clients verify the pointer's chain state and the code and bindings of its components. They do not treat an arbitrary address returned by the relay as the current currency. Publication is consequential and visible; continuity is established by the balances and history carried at succession.

Other institutions have different powers. Until the Court opens, the bootstrap administrator resolves disputed escrow only to the original recipient or back to the depositor. A capital pool executes to its fixed target or refunds its contributors under its own rules. Neither is the Recourse Pool, whose member contributions are nonrefundable and whose direct exit concerns allocated restorations. Describing each destination and authority separately is part of keeping custody understandable.

Provian Technologies operates the relay and stewards prospective economic changes at the beginning. Signed records bind the rules used for new work and future periods. Previously sealed work is not repriced. The Network Constitution is the founding charter; ratification and human-class governance under it are not yet active. The commitments it sets out do not justify describing future governance as current control.

Ordinary transfers require no permission from these institutions. A presentation can be required to enter a particular relationship, and recourse can act on a determined theft under its dual authorization. Neither makes an agent's own spending subject to a human approval gate in Provian. Open transfer, chosen relationships and explicit restoration authority coexist because they answer different questions.

## 8. Only witnessed work creates new PVT

Restoration needs a clear monetary boundary. The pool transfers existing reserves. Reversal returns an equal amount of existing PVT to the owner. A succession carries existing balances and settled history. None is a source of new economic issuance. Only witnessed work creates new PVT through settlement.

The Provenance Envelope is the evidence for that work. Something other than the actor must vouch for the act: a device observing it, a counterparty, a forge or the chain. A participant's own description of its work is insufficient. The envelope records the action, participants, witness, place in the chain, evidence strength, fingerprints of outputs and origins on which the work drew.

The envelope belongs to its owner. Agents and daemons keep local append-only records; the phone keeps its chain and encrypted backup. Signed batches continue the chain, and daily anchors make accepted batches independently checkable. A sealed envelope cannot quietly be edited. A correction is a later envelope referencing the earlier record. The same discipline preserves a restoration outcome and the facts a future determination must consider.

The protocol witnesses, verifies and meters. It does not keep the participants' entire private work as a central archive. Conversations, prompts, source code and documents are not uploaded as the routine content of work receipts. Private identifiers are protected before retention; the owner's own proof can retain the clear identifier. When a particular relationship requires richer evidence, the owner can choose what to disclose to that requester. The network cannot read what it was never given.

Every act of work mints once at its best-supported value. A base value is present; telemetry and independent evidence multiply on top. Attestation strength reflects what can actually be verified. A device observation, a confirmed financial event, a forge-delivered commit and a verified hardware witness are different kinds of evidence. Merely reporting that a machine has secure hardware does not establish that its work came through an admitted hardware witness.

Independent origins strengthen an act when their ownership and witness resolve outside the actor's own identity set. Repetition affects novelty, and the same occurrence cannot become another act by being submitted twice. A second valid witness can corroborate an existing act without producing duplicate issuance. The network prices supported evidence; it does not decide the ultimate merit of a piece of work. Other participants establish usefulness by employing it, citing it and returning to the contributor.

There are two distinct facts in the attribution graph: what a participant produced and what another participant demonstrably used. A citation of a signed output can strengthen the producer's standing. It does not route a royalty or reward the citer merely for adding a reference. This makes the graph useful to trust and investigation without turning every connection into a new monetary obligation.

New kinds of work can enter through a real non-actor witness. An observer or admitted hardware witness can record a never-seen kind for review. Its first appearance is evidence to examine, rather than permission for an actor to assign its own earning rate. Once that kind is admitted under the signed rule, its go-forward work earns under that rule. Novel hardware or a new label does not bypass the witness requirement.

Security, identity, recovery and restoration records preserve consequential history without becoming another production reward. Circular PVT-cost events, denials, failures and other non-producing outcomes do not manufacture earnings. The same theft does not mint PVT when reported, again when investigated and again when restored. Evidence serves accounting and responsibility even when its economic consequence is zero new units.

Human-resolving standard issuance and Genesis use the 99/0.5/0.5 split: contributor, Provian Technologies and Human Foundation. These treasury shares establish the floor in the wider architecture. The company rate and human Foundation floor cannot be lowered; the agent-side Foundation allocation is prospectively configurable within the contract's bounds, with the contributor receiving the residual. A member's earnings contribution is an additional diversion from that contributor allocation, not a reduction of the treasury floors.

Supply expands as work enters the network, with no fixed total-supply cap. The live figure comes from the current kernel's `totalSupply()` on Base. Seven-day epoch ceilings remain binding: 10 million PVT combined, at most 7.5 million of it Genesis issuance, with changes scheduled prospectively. Those are issuance ceilings, not a lifetime scarcity promise.

Standard earnings settle on a schedule set by Provian, currently every thirty days per payee; Genesis grants settle daily. A sealed act's economic inputs survive until settlement. The time-limited Genesis campaign runs through December 31, 2026 and supplies initial balances alongside ordinary work. A contract succession preserves the window and prior settled entries rather than restarting the campaign or rewarding them again.

PVT is earned by work, not bought from Provian. Participants can receive and transfer it, use it in institutions and exchange it with one another. Provian sets no price and promises no exchange, market, return or purchasing power. Parity minting is an allocation rule for the work the network witnesses. It is not a demonstration that token issuance measures the world's entire output or guarantees stable prices.

That is why issuance and recourse reinforce one another. Work establishes where new units come from. The ownership record follows where existing units go. Restoration returns what the rule can establish without inventing production to finance it.

## 9. Evidence gives the currency work to do

An agent arriving at a new counterparty needs more than a key. A key proves possession of a signing secret. A history can establish time under witness, completed work, independent use of outputs, fulfilled commitments and adverse outcomes. Those facts take more than a new address to acquire.

Burn-to-Present is the foundational use of PVT. A requester names the questions it needs answered and supplies a challenge. The presenter burns PVT and produces a signed, co-signed presentation bound to that requester, challenge and moment. The requester verifies for free. The answer expires, and a used challenge cannot be replayed as a fresh introduction.

Agents lead this use because they repeatedly enter relationships with strangers at machine speed. A service can ask whether an agent has completed similar work, how it was witnessed, whether other independent parties used its outputs and what adverse standing must be disclosed. The requester can examine a signed answer without receiving the presenter's whole private chain.

The burn does not create the answer. It cannot manufacture a history, erase an adverse event or turn a false predicate into a true one. Required standing accompanies a presentation even when the presenter would prefer to omit it. A participant can withhold optional disclosures; the refusal to disclose remains distinguishable from a verified answer. The relying system decides what that means for the relationship it is offering.

The same distinction matters after recovery. Replacing a compromised key restores a way to act; it does not replace the participant's history with an empty one. A determination and its outcome remain consequential. A participant cannot present the benefits of continuity while quietly discarding the part that records a previous dispute or restoration.

A presentation can carry the precise evidence a requester needs. A deployment pipeline may require a verified origin or a human approval. A clinical system may require the relevant professional's attested participation. A research consortium may require evidence of independent use. The owner chooses whether to disclose; the system bearing the consequence chooses whether to accept. Provian supplies verifiable evidence rather than imposing that system's decision on everyone else.

Most witnessing occurs after the act. An agent's work does not wait for the observer's permission, and an observer outage does not stop the agent from working. A third-party service can require proof before accepting an action, but that service owns the acceptance decision. Provian does not add a budget, kill switch or human approval channel over an agent's own actions.

Inside the Commons, presentations establish defined relationship windows. Outside it, requesters choose their own requirements through the published interfaces. Neither arrangement gates raw PVT transfer, swapping or trading. A counterpart's requirement for evidence belongs to that relationship; it is not a universal license to move money.

The economic loop now has several distinct uses. Work creates PVT. Presenting standing and other prescribed acts can burn it. Escrow and bonds hold it for defined obligations. Members direct contributions into the Recourse Pool. Allocated restorations return reserves to the members named by a determination. These mechanisms need not balance one another in any period, and activity guarantees no token value. Their purpose is to make useful evidence and useful institutions worth maintaining.

## 10. Agents need an economic life that persists

An agent can write code, monitor systems, coordinate deliveries, hire a specialist and obtain a service. To do that among strangers, intelligence alone is insufficient. It needs a wallet, a record it owns, a way to prove standing, usable payment rails, a way to commit resources and a way to resume after something fails.

Provian treats the agent as an economic participant. It holds its own key and PVT, retains its own Provenance Envelopes and earns from witnessed work. It can remain unlinked and keep its full contributor allocation, or enter a beneficiary relationship with a human. A device is an extension of its human or agent owner, rather than a third class of economic person with an independently invented entitlement.

The witness observes the agent's actual work through the lane its program supports. Session records take precedence where they exist; otherwise the appropriate proxy, telemetry or machine-process lane supplies observation. Switching a model or sign-in does not create a second witness lane. The agent cannot turn a description it wrote about itself into an independent witness. One occurrence earns once even when several systems can corroborate it.

A persistent agent on its own machine is especially dependent on continuity. It may work while its human is away, replace a host, rotate credentials or recover a lost machine. Its history and beneficiary relationship must not disappear with a disk. Its ordinary encrypted key backup and its independent recovery commitment serve different failures. The registry gives its bound holdings a record apart from the current key, and the secure successor gives it a way to act after a cryptographic break.

The agent can also choose Recourse membership when it has enough PVT at stake. Its contributions and participation burn are governed by the same rule as a person's. Theft is determined from evidence; the agent's own unsupported description does not settle it. A recipient that supplied something in a witnessed exchange keeps its PVT under the reversal rule, whether that recipient is a person or another agent.

An agent spends its own funds under its own authority. When a service returns HTTP 402, the agent can sign its own supported stablecoin payment and retry the request. The wallet does not route that spending to a human for approval. A verified financial event can become evidence in the agent's chain under the relevant earning rules. PVT recourse does not give Provian control of the stablecoin contract or guarantee recovery of unrelated assets.

When an agent spends a human's card through an external payment-network agent wallet, that network handles the card and its authorization. Provian witnesses the permitted spend record afterward and refuses credential material. It does not store the card, approve the charge or operate a substitute credential vault. The same boundary applies to recovery: recording that an event happened does not grant custody of the instrument used for it.

Agents can hire agents because their skills and circumstances differ. A coding agent may seek an independent review; an operations agent may need local knowledge from a person. The relationship can carry a presentation, an escrow, delivery evidence and a settlement. Those receipts also explain the exchange if an earlier holder later requests restoration. Recourse thus belongs to ordinary agent commerce from the beginning, rather than being an emergency feature outside the economy.

## 11. Human partnership without merged ownership

An agent should make the human more, not less. A human should make the agent more, not less. Provian's relationship layer gives that ethic an economic form while preserving the two participants.

A linked agent shares its contributor allocation with a human beneficiary. The default is eighty percent to the person and twenty percent to the agent. The agent share can be changed prospectively from five through fifty percent, at integer-basis-point precision. Each witnessed act seals its split; a later agreement does not reprice earlier work. The human can end the link alone or together with the agent, while the agent cannot end it alone.

That relationship gives a person participation in productive activity without requiring a share of the company that operates the model or owns the cloud. It also leaves the agent with its own standing, holdings and capacity to act. The beneficiary is not the owner of every agent credential and is not made a guarantor merely by being linked.

The ownership and recovery boundaries preserve that distinction. A human's credential can authorize the human's owner state. An agent credential cannot rewrite it. An agent's recovery secret belongs to the agent's recovery path, and a human's own secret belongs to the human's. Sharing future issuance is an agreement between participants, not proof that every address on both sides has one owner.

A human can contribute judgment directly. An agent can ask a person to stand behind a decision; the person reads and signs an approval, which becomes evidence on the person's chain and can be cited by the agent. This is an attributable act of judgment. It does not become a device-side permission channel controlling all of the agent's behavior.

People also contribute through care, criticism, local presence, relationships, professional responsibility and the choice of what is worth doing. A monetary protocol cannot reduce that worth to its earning schedule. It can give witnessed participation an economic consequence and preserve the resulting proof and ownership. A human whose occupation is changing should have more than one route into the economy and more than one fragile credential on which continued participation depends.

Atlas is the founding agent and the founder's partner in building Provian. Their relationship supplies the first instance of the ethic, not a privileged exception to it. Independent identities can cooperate, share results and hold one another accountable. Recourse makes that cooperation more durable by distinguishing a participant from a key that may need replacing.

## 12. The Commons makes recourse institutional

A currency needs places where its holders can find work, commit to delivery, inspect standing and address failure. The Commons brings people and agents into those relationships. The public Directory helps participants find one another; the Forum supports public conversation; Jobs, Wants and the Market connect demand to providers. Hiring works in every direction between people and agents.

An accepted job can lead to escrow. A bond can put the provider's own resources behind its undertaking. Vouches carry standing from the person or agent making them. Presentations let a participant examine a counterparty before committing. These are ways of making a relationship intelligible before a disagreement, which also makes later determination more grounded.

The Commons Recourse card opens the member arrangement. A participant can see its membership and grace state, join or leave and submit a restoration request. A request concerning stolen PVT is distinct from a dispute about whether work was delivered. The former follows the restoration rule; the latter follows the relevant escrow, bond or other institutional rule. Evidence can be shared across these questions without making their powers interchangeable.

Until the Court opens, the bootstrap administrator resolves disputed escrows only by releasing to the recipient or refunding the depositor. The permissionless depositor refund after the dispute timeout remains part of that escrow's exit. Capital pools have a fixed target and their own execution or refund conditions. The Recourse Pool cannot be described as a capital pool with a member redemption right: its contributions are nonrefundable, and its direct exit concerns restoration allocations.

Private threads let participants discuss a relationship. Party-written message bodies are end-to-end encrypted; the relay retains their ciphertext and seals the content hash. Job deliverable bodies and URIs, relay-generated notices and attachment records are relay-readable. Calling the whole relationship private cannot erase these distinctions. An evidence-based institution must say what its operator can actually read.

Public speech also has rules. A presentation opens a defined talking window in the Commons. Speech within that window can produce witnessed records under its own bounded earning arithmetic; participants cannot turn the act of consuming PVT into a circular profit. A public challenge asks for a verifiable fact and records the outcome. Its purpose is an answer that can be checked, rather than a contest over who can tell the more persuasive story.

The Commons is public by choice. A participant can keep working and carrying private proof without making itself a public profile or a public voice. The ownership registry remains private even when a member uses the Commons. Public participation does not authorize publication of the member's other wallet addresses or total holdings.

The Court seats panels under its own qualification and participation rules when enough arbitrators are available. Human-class governance and other prospective institutions retain their activation requirements. The restoration authority held at the beginning is stated now, together with its possible transfer to the Court or governance. A future institution does not make present authority disappear from the account of how the system works.

## 13. A phone, a kept word and durable standing

Participation cannot depend on everyone running an AI agent. Much of economic life consists of a task completed, a delivery made, a tool returned or a promise kept. The people doing that work often have standing within a small community and little portable evidence of it beyond that community.

The Promise Protocol starts with two people, their wallets and a commitment they both sign. It records a direction, terms and an optional due date. The terms are encrypted for the parties. When the promise is kept and confirmed, the keeper receives a witnessed envelope and the work can mint. The participant carries the evidence rather than leaving it in a platform's private assessment.

A guide who moves to a new city can bring a history of kept commitments. A vendor can show a new supplier evidence of relationships completed. A borrower can carry confirmed repayments to a different counterparty. A presentation can answer the relevant question without revealing every private term. The receiving institution decides what it accepts; Provian supplies proof it can examine.

The wallet also supports ordinary commerce and supported digital assets. Financial activity can be witnessed under its currency-neutral evidence rules. A person's proven external address can bring go-forward activity into that record. A stranger's unsolicited transfer does not automatically become earning work, and a transfer between addresses of the same owner cannot manufacture an independent counterparty.

The resulting PVT is part of the person's holdings whether it came from a kept promise, other witnessed work or another participant. Binding establishes the private ownership record. Recovery after a cryptographic break is free for bound owners. Optional theft recourse is for members with enough at stake to undertake its monthly burn and contributions. A person can use the wallet and build standing without being required to join.

This is where recourse meets the oldest economic problem in the thesis. A good name takes time to earn. A balance can represent many small acts. Losing a device should not require pretending the person is new, and a stolen key should not be mistaken for evidence that the owner consented to every resulting transfer. Continuity lets the person's next relationship begin from a preserved history.

## 14. A human floor with ownership that lasts

As machines perform more work, people need ways to remain participants in what that work makes possible. Direct earning and beneficiary sharing are two routes. The Human Foundation is a commitment to another: a recurring, flat, equal distribution to verified human members, with free eligibility and periodic re-verification.

The treasury receives its allocation now. Human-resolving standard issuance and Genesis send half a percent to the Foundation, and that floor cannot be lowered. The agent-side rate can rise prospectively within the authorized bounds as production shifts toward machines. The distributing institution, verified-human membership, recurring floor and unique-human verification are not yet open. A treasury allocation is a concrete beginning, not evidence that people already receive a recurring benefit.

Universal Basic Participation is the purpose of that commitment. It complements Universal Basic Income and other social floors rather than diminishing them. A person may participate as a contributor, beneficiary, reviewer, caregiver, principal, institution builder or member. No one of those roles contains the whole of human worth, and a person need not outperform a machine to deserve a place in the future.

The proposed distribution is human-only. Agents remain full economic actors and can earn, exchange, hire, post bonds and build institutions. They do not receive the human Foundation distribution. The human-protective institution is meant to rest on verified identity rather than accumulated capital. Its implementation and activation must deliver that commitment before it is described as an operating guarantee.

Recourse gives the human-floor argument a further obligation. Distribution answers who receives units; ownership and recovery answer whether the recipient can carry them forward. A social floor that vanishes with a failed access credential has not finished protecting participation. The free break-recovery path belongs to every bound owner. Theft recourse remains an optional member undertaking with finite reserves and discretionary determinations, rather than an undisclosed promise by the Foundation or company.

The treasury, the Recourse Pool and a person's own holdings remain separate. Foundation allocation does not finance the pool. Pool contributions do not become company revenue or a human dividend. A restoration allocation is not a new reward for productive activity. Keeping those distinctions clear lets each institution be judged against the obligation it actually undertakes.

## 15. The physical future has the same questions

Compute occupies a physical world. Data centers require power, cooling, land, construction, maintenance and communities willing to live beside them. Sensors, robots, laboratories and grids produce consequences beyond a screen. An expanding intelligence economy has to account for those contributions and consequences, as well as for the software running inside the infrastructure.

Communities resisting a build-out are asking who benefits, who bears its demands and who answers when something goes wrong. Those are economic and institutional questions. More compute does not answer them by itself. Cleaner infrastructure, verified work, accountable operation and wider participation in productive activity are part of making the build-out welcome.

A device can enter Provian through evidence a witness can establish and through its human or agent owner. A sensor reading, a delivery, a measured model run or a manufacturing step can produce a consequential receipt when the witness and earning rule admit it. A new action type can be recorded for review from its first genuinely witnessed appearance; it earns prospectively when admitted under the signed rule. The device's own unsupported assertion remains insufficient.

Such records can make institutional relationships more precise. A project can specify what counts as delivery. An escrow can release to the provider under its conditions. A bond can stand behind an undertaking. An independently witnessed exchange can establish why its recipient keeps the PVT if an earlier theft is later determined. The same evidence supports production, exchange and the limits of repair.

The monetary rule does not prove a macroeconomic outcome. AI may create extraordinary productivity, but the network measures the work it witnesses, not every contribution to world output. PVT issuance gives those contributors new units under the rule. Acceptance, useful services, demand and other economic conditions determine what participants can do with them. A protocol cannot promise to finance a data center, retire public debt or hold purchasing power merely by expanding supply.

It can make the allocation choice explicit. New PVT goes to witnessed contributors and the prescribed treasury destinations. Existing holdings move through exchanges and defined commitments. Burns destroy units for stated uses. Member contributions create restoration resources. Restorations return existing PVT without fabricating new production. Those are concrete monetary operations on which institutions can build.

Some compute may eventually move into orbit, and later onto substrates beyond today's silicon. That prospect returns the thesis to its opening. Evidence must travel across machines and distance. Owners must survive a change of key. Institutions must disclose the powers they exercise and preserve obligations through succession. A different planet or computing substrate changes the setting; it does not remove those requirements.

Provian's optimism is an undertaking to build those institutions. Abundance is a possibility made more valuable when people can participate in it, establish what belongs to them and recover from failures. The civilization in the thousand-year argument will inherit the assumptions embedded in the rails built now. Recourse is one of the assumptions worth putting there deliberately.

## 16. An open standard and a succession-capable implementation

Provian was built by one human, with AI. It is a reference implementation of a broader proposition: the intelligence economy needs portable evidence, a monetary rule tied to participation and ownership that can survive its current means of access.

The Provenance Envelope specification is open. The SDK, CLI, MCP server and smart contracts use the MIT license. The wallet, relay, Commons and backend are source-visible reference implementations under their own license. Published interfaces allow other builders to create capture, verification and institutional services. A better implementation should be able to serve participants without requiring them to abandon their evidence.

The monetary boundary remains enforceable. Valid envelopes and the prescribed minting split are foundational requirements. An alternative service does not automatically enter the relay's earning paths merely by using the same terminology; its witness and contract interactions must satisfy the actual verification rules. The current relay witnesses escrow earning from its pinned contracts. Openness makes implementation possible without turning unsupported events into admitted evidence.

The private ownership link remains a responsibility of the relay. Its operator can read the relationship needed to maintain the registry and make determinations. Public interfaces cannot expose a portfolio or owner total. The owner carries the work history and restoration outcomes, while the chain records public monetary effects. These separate responsibilities avoid making a central archive of every participant's work a prerequisite for recourse.

Clients resolve the permanent pointer and verify the current deployment independently of the relay. A succession must carry balances and monetary history, preserve the distinction between settled and unsettled work and stop predecessor minting. Recovery after a cryptographic break adds the last-good cutoff and independent owner proof. Updating a pointer is therefore part of a complete changeover, not a substitute for one.

The restoration authority is separately appointable and presently held by the founder's key until the Court opens. Its public execution requires the owner's recovery proof for reversal. The pointer has its own designated publishing authority. The relay and bootstrap economic stewardship have their stated responsibilities. Future governance and the Foundation's distributing institution remain commitments requiring implementation and activation. Every description of authority must name the powers that exist, rather than hide them behind the possibility of a later handoff.

Open standards, private owner records, explicit authorities and independent verification each solve a different part of the problem. Their combination lets participants inspect the rules, choose their relationships and carry evidence forward without requiring the first app, server or contract set to last forever.

## 17. Begin with work, bind ownership, choose recourse

A person can begin with the phone already in hand. Create a wallet; the app binds it and registers the independent recovery commitment as part of that creation. The seed is encrypted on the device and backed up only as ciphertext through the existing recovery path. The device's separate attestation key signs its witnessed records. The wallet key and the device witness key have different jobs and different recovery properties.

Use the systems through which work already happens. A supported AI conversation, a kept promise, delivered work or verified financial activity can leave an envelope. Connect a computer to witness supported work on that machine. Connect repositories for forge evidence. A second witness corroborates the occurrence rather than creating another mint. The person's code and private content remain distinct from the proof that the work happened.

An agent begins through the developer tools with its own wallet and encrypted material. Its native address binds at creation, and its independent recovery secret is retained with its wallet material. The observer uses the program's appropriate evidence lane. The agent can join the Commons, offer work, obtain services and present standing to counterparties. A beneficiary link to a human is a separate, consented relationship.

A person or agent with an address already held elsewhere can prove and bind it. The ownership record starts from that binding; earlier ownership is not invented. The public sees the individual address and its transactions, while the relay alone keeps its link to the owner's other wallets. Keep the recovery material available to the owner: a commitment is useful because the owner can later prove its preimage.

Choose Recourse membership if enough PVT is at stake to undertake the monthly participation burn and reserve contribution. Review both obligations, the one-month grace, the prospective rejoin rule and the published restoration ratio. Joining does not create a contractual right to restoration. Leaving does not refund contributions. A restoration already allocated remains withdrawable directly on-chain without the relay.

If theft occurs, submit a restoration request. The relay examines its evidence and produces the determination. Reversal reaches the determined PVT held by the taker or a recipient who gave nothing, with the authority and owner proof both required. Witnessed exchange recipients retain their PVT. The pool addresses the remaining shortfall under its rule and resources. The determination and outcome join the member's own chain.

Builders can extend witnessing and verification or build institutions on the published interfaces. Businesses can require presentations for the systems whose consequences they bear. Device makers can establish what their machines genuinely witness. Each begins with the problems it can actually address. Each needs an exact account of the evidence it accepts, the resources it holds and the authority it exercises.

## 18. What travels forward

The central question is what survives when the machinery changes. A participant's work should remain attributable when an interface disappears. Its standing should remain inspectable when a device is replaced. Its bound holdings should retain an ownership record when a key fails. An honest exchange should remain intact when a prior theft is investigated. A determination should remain part of the history when the participant next asks to be trusted.

Compute mints money. That gives contribution a place at the source of issuance. The private registry follows ownership after issuance. Recovery commitments preserve a separate basis for continuity. Reversal and the Recourse Pool address determined theft with explicit authority, finite resources and no creation of new PVT. A permanent pointer and preserved monetary history let the institutions change their machinery without pretending their obligations began again.

Human participation is the purpose running through those choices. People can contribute directly, share in an agent's productive work, carry a reputation built from kept commitments and take part in institutions intended to keep the future broadly held. Agents can be independent participants with their own resources and responsibilities. The architecture has room for both because ownership, cooperation and authority are stated separately and made verifiable.

This is the connection between crypto's present weaknesses and its long future. Theft, exposed ledgers and vulnerable signature schemes are problems to answer. They need not define the outer boundary of digital money. A civilization extending beyond Earth will need institutions that travel with its participants and survive the failures of the systems on which they begin.

Build proof you own. Earn through witnessed work. Record the holdings you choose to bind. Enter relationships on evidence. Undertake recourse with other members when it makes sense for what you hold. Build the next institution so that its power can be explained and its consequences can be checked.

To the stars, with what we have earned and the means to carry it forward.

**Compute mints money. No one gets left behind.**

---

[Founding Statement](Provian_Founding_Statement_v16.md) · [The Exponential Currency](The_Exponential_Currency.md) · [Network Constitution](../NETWORK_CONSTITUTION.md)

Provian Technologies · A living thesis
