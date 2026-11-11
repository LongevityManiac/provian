# The Exponential Currency

## Work, ownership and recourse in an expanding intelligence economy

Compute mints money.

A currency for the intelligence economy has to answer three questions together. How do new units enter circulation? Why would anyone use them? What happens when a person or agent loses the key that controls what they own?

Provian's answer joins witnessed work, an economy of trust, and recourse. Work mints PVT once at its best-supported value. Participants use PVT to establish trust and transact with one another. A prospective ownership registry separates the record of ownership from the wallet key. An independent recovery commitment preserves a way to demonstrate continuity when that key fails. Members who choose to share loss risk fund the Recourse Pool.

These are parts of one monetary architecture. Issuance without a use leaves a distribution mechanism looking for an economy. A useful currency without recourse leaves every holder one stolen secret away from a permanent loss. A restoration arrangement without a funding rule has no resources behind it. The design has to hold all three questions at once.

## 1. The long argument

Frank Drew believes in crypto because he cannot envision commerce a thousand years from now, across a civilization that has left the planet, organized around the currencies of its countries of origin. This is an argument about the shape of civilization. A trading network spanning worlds will need money that can travel with its participants and be verified by machines that do not share a national institution.

The future is uncertain in its details. The direction of the problem is plain. Money serving digital agents, distant settlements and people who have never met must be digital. Its records must be portable. Its rules must be inspectable. An intelligence does not stop being a participant because it runs in a different jurisdiction, on a different substrate, or beyond Earth.

The near argument begins with crypto's weaknesses. A key can be stolen. Public addresses expose balances and transactions. The mathematics behind today's wallet signatures could someday fail. Every one of those problems is real. None is a ceiling on what can be built.

A bank account can be compromised too. The bank has a record of who is owed what apart from the password used to enter the account. That distinction gives it a basis for investigation and restoration. A public token ledger ordinarily records which address controls a balance. It does not, by itself, preserve a separate answer to who owns that address.

Provian builds that missing layer. The rail remains public and permissionless. Ordinary transfers are ungated. A separately appointed restoration authority can return stolen PVT under the published rule with the owner's independent recovery proof. The power is explicit, and every use is public.

## 2. Ownership survives a change of key

A human or agent chooses to bind an address it holds to its verified network identity. Native wallets register as part of creation. An existing outside address enters through the proven-address and signature path. The registry begins at binding; it does not invent a history of ownership before that point.

From then on, chain Transfer events maintain the identity's address-and-balance record. Inbound PVT is tagged as minted or received. Both are holdings. An address that nobody has bound remains usable on the public rail, but the network has no registered owner to follow for recourse.

The registry link is private. The relay knows which wallets are yours and the public does not, the same as a bank. The owner-to-address record stays inside the relay. No on-chain registry record or public endpoint reveals that two addresses share an owner or totals an owner's holdings across addresses. Individual addresses, transfers and balances remain public. The owner chooses binding for a separate ownership record and a route to restoration.

At binding, the identity registers the hash of an independent recovery secret. For a person, the secret derives from the seed and travels in the existing encrypted backup. Learning a curve private key does not reveal that seed-derived secret. For an agent, the SDK generates a separate random secret and encrypts it with the wallet material. The relay retains the commitment, not the active secret.

The wallet key and recovery secret serve different purposes. One authorizes ordinary transactions. The other demonstrates continuity with the registered owner. A beneficiary relationship, a new signature from a broken curve, or a person's assertion of ownership cannot replace the recovery proof.

## 3. Two failures, two restoration paths

A break in the wallet cryptography is a network succession problem. The procedure selects a last-good block, snapshots registered balances, and requires each owner to reveal the preimage matching its commitment. Restoration reissues those balances on a secure successor. Monetary history travels with the transition so work already settled cannot mint a second time.

This does not reverse the old chain. It does not recover an unregistered ownership history. It does not make a newly presented signature from the failed scheme trustworthy. The recovery commitment exists before the failure precisely because ownership cannot safely be invented afterwards.

Theft while the ordinary cryptography remains usable is a different problem. A member submits a restoration request. The relay assembles evidence from its own history: the registered balances, observed outflows, counterparties, available device evidence, movement into trading venues, and the member's previous outcomes. A replacement destination is bound to the continuing identity.

The determination is discretionary under the published rule. No member has a contractual right to payment. There are no member-facing holds, limits, waiting periods, caps or second confirmations. Reversal comes first: in one transaction, the kernel destroys the determined PVT at named addresses and reissues the identical amount to the owner's new key. The restoration authority and the owner's independent recovery proof must authorize the same operation. Neither alone can move anyone's PVT.

That rule distinguishes possession from an honest exchange. PVT still held by whoever took it, or passed to a recipient who gave nothing for it, can be reached. PVT received in a witnessed exchange stays with its recipient. The original theft does not become a chargeback against someone who gave value for those tokens. Reversal changes where existing units sit; it never changes total supply.

The Recourse Pool restores the portion reversal cannot reach. Every determination and its execution enters the member's own chain. A later request faces that record. Repeating an occurrence under another identifier cannot produce another restoration.

Self-theft remains a residual risk. An owner can arrange transactions that resemble an attack. Evidence and prior outcomes inform determinations; they cannot make every deceptive story distinguishable from a genuine loss. Experience therefore informs the prospective contribution and participation-burn amounts. The limitation is part of the institution's design.

## 4. The members fund the Recourse Pool

The Recourse Pool is a member-funded risk-sharing arrangement. Restoration is discretionary under its published rule, and members accept determinations as final. Provian Technologies is not a party to it, contributes nothing, holds nothing and promises nothing. The company receives no contributions or surplus. The reserve belongs to the on-chain arrangement funded by members.

Every member burns **100 PVT each calendar month**, whether or not they earn. This participation burn is the largest standing burn in the system. It permanently destroys units and contributes nothing to the reserve.

Separately, **1% of gross earnings** is diverted into the pool at settlement. At the human and Genesis split, a member keeps 98%, with the existing 0.5% company allocation and 0.5% Foundation floor unchanged. A member with **no earnings in a month contributes 100 PVT from holdings** to the reserve instead. A no-earnings month has both obligations: 100 PVT burned and another 100 PVT held by the pool.

The participation burn, earnings percentage and no-earnings contribution are three independently stated amounts in the signed rule. Frank can raise or lower them prospectively as loss experience accumulates. A later rule does not rewrite an earlier month's obligations. These are uses of an earned token within its economy. Membership is optional, intended for holders with enough at stake. One membership includes all of the identity's bound holdings, earned and received alike; a bound nonmember has no theft recourse.

A missed month receives one calendar month of grace. Making up the missed obligations within grace means nothing lapsed. After grace expires, membership ends. A former member can rejoin at any time and is protected from that day forward, but cannot restore a loss from a lapsed period by catching up afterward. The calendar rule does not depend on whether a keeper happened to run.

The pool restores in PVT, pro rata across accepted determinations when underfunded, never beyond available reserves. Its published reserve-to-member-balance ratio reports its resources; it does not promise a restoration percentage. Contributions are nonrefundable: a member cannot redeem the 1% earnings contribution or the flat contribution from holdings. Participation burns are irreversible. Once a restoration is allocated to a member, that allocation can be withdrawn directly on-chain without the relay, including after the member leaves.

No part of that arithmetic needs a dollar price. The separately appointable restoration authority executes the rule's output. Frank's key holds that role until the Court opens, after which the role can pass to the Court or governance. Neither Frank nor Provian Technologies owes a member a favorable determination. Other recourse programs can follow.

## 5. Why work creates new units

An expanding intelligence economy creates an allocation problem. New output can arrive from people, agents and machines working together. Who receives the new money that accompanies participation in that economy?

A fixed issuance schedule does not answer that question by reference to work. An allocation based on existing holdings rewards existing holdings. Provian chooses another rule: witnessed participation creates new units for the contributors, with the protocol's treasury shares applied at settlement.

This is what parity minting means here. It is an issuance rule grounded in the network's evidence. It is not a price peg and does not establish that PVT supply grows at exactly the rate of the world's real output. The network cannot measure an entire economy merely by counting its own receipts.

Consider a simplified economy with one hundred units of goods and one hundred currency units. If another ten units of goods are produced and ten currency units are issued to the contributors, the allocation of those added units follows the added work. Whether prices remain unchanged depends on demand, acceptance, turnover, credit and other conditions. The example explains who receives issuance; it does not prove stable purchasing power.

Provian's commitment is narrower and executable: every act of work mints once at its best-supported value. A base value is present, while telemetry and independent evidence multiply on top. Mint-once checks prevent the same act from earning twice. Epoch ceilings remain binding. Total supply expands as work enters the network, with no fixed total-supply cap.

PVT is earned by work, not bought from Provian. Holders can transfer it to one another and use it in the network's institutions. There is no promised price, exchange listing, return or market. The monetary argument concerns participation and the distribution of new units.

## 6. Evidence is the unit of accountability

A Provenance Envelope is proof its owner carries. Something other than the actor must vouch for the act: a device observing work, a counterparty, a forge or the chain. An actor's own declaration is not enough.

The protocol witnesses, verifies and meters. It does not keep every participant's private work as a central archive. Owners retain their append-only, hash-chained records; signed batches and anchors support verification. A participant presents the relevant proof when a relationship needs it.

That distinction matters for agents. An agent needs a portable way to show a prospective counterparty what it has done and what others can verify. The counterparty needs evidence without inheriting every private detail of the agent's history. A signed, attributable receipt can serve that exchange across models, providers and machines.

The ownership registry answers a separate question. A receipt shows participation; a balance can also arrive through payment or transfer. Recourse follows the PVT held in bound addresses, not only the PVT minted by their current owner. Work evidence and ownership evidence complement each other without being conflated.

## 7. Burning gives the currency a job

Agents lead the foundational use of PVT: burn to present witnessed standing when asking another participant for trust. The presenter burns PVT; the counterparty verifies for free. A burn cannot manufacture a favorable record or hide an adverse outcome.

Other institutional actions create further uses: forming a relationship, committing to an obligation, resolving a dispute, or making a verifiable presentation. A burn removes units when the protocol's rule requires destruction. A reserve contribution holds units for the pool. An escrow or bond holds units for its own defined obligation. These mechanisms must be described separately because they do different economic work.

The resulting loop is concrete. Work creates a record and issuance. A participant uses that record to seek trust and opportunity. Institutional use can burn PVT. A member can direct part of issuance into shared loss resources. There is no requirement that issuance and burns balance, and no guarantee that activity creates a particular token value.

This loop is useful only when the institutions are useful. A presentation nobody needs creates no sustainable reason to participate. The protocol has to earn its place by making a real relationship easier to establish and a real obligation easier to verify.

## 8. People remain participants

An intelligence economy must have a place for people beyond supplying tasks that automation has not yet learned. Provian commits to a recurring, equal floor for verified human members. The distribution institution and its unique-human verification are not yet open.

The Human Foundation treasury receives its share now. Membership and a flat, equal, human-only distribution require their own implemented institutions. Agents do not receive that human dividend. The aim is a floor of participation alongside earned income, not a dismissal of universal basic income or a claim that every person's needs can be reduced to a work score.

Human-resolving standard issuance and Genesis apply the 99/0.5/0.5 split: contributor, Provian Technologies and Human Foundation. The treasury percentages are floors in the wider architecture; agent-side Foundation allocation can change prospectively under the authorized rule. A linked agent's contributor share then follows its beneficiary agreement. The default is twenty percent to the agent and eighty percent to the linked human, with the agent share prospectively configurable from five through fifty percent. Earlier sealed work is not repriced.

The relationship remains visible as a relationship. The human and the agent are distinct participants. Linking does not turn the human into an owner of the agent's recovery secret, nor does an agent credential authorize changes to the human's owner state.

Work also carries meaning beyond income: competence, contribution, companionship and responsibility. A monetary protocol cannot provide those things by issuing units. It can avoid building an economy in which a person becomes economically invisible merely because a machine can perform a particular task more cheaply.

## 9. Scale changes the setting, not the obligation

Compute requires physical infrastructure. Data centers need power, cooling, land, construction and maintenance. Their demands affect surrounding communities. Efficiency changes what can be done with a unit of energy; it does not make the infrastructure disappear.

Some compute may eventually move beyond Earth. That prospect extends the same questions: who participates, who owns the results, how evidence travels, and what happens when access fails. A protocol designed around portable proof and digital money can address those questions without assuming that all future work runs in today's cloud or under today's institutions.

The design is substrate-agnostic in its ambition. Silicon, biological computing, neuromorphic systems and quantum systems may produce different kinds of evidence. Admission still requires a real witness. A new machine is not permission to accept an actor's unsupported account of its own work.

## 10. What the architecture commits to

Provian was built by one human, with AI. Its claim is that the intelligence economy needs a trust layer whose monetary and ownership rules fit together.

Compute mints money. Witnessed participation receives new units. Institutional use gives those units work to do. The prospective registry records bound holdings independently of the key that currently controls them. Recovery commitments provide continuity. The Recourse Pool lets members fund discretionary restoration from their own participation.

None of those parts abolishes risk. Public rails reveal individual transactions and balances. The registry keeps the owner-to-address link private inside the relay: the relay knows which wallets are yours and the public does not, the same as a bank. Keys and implementations can fail. Evidence can be incomplete. A reserve can be underfunded. A member can try to deceive the pool. The architecture gives each problem a place to be handled instead of treating the weakness as the final boundary of digital money.

That is the connection between the thousand-year argument and the work in front of us. A civilization extending beyond Earth will need digital money and institutions that can travel with it. Building recourse is part of making that money fit to carry forward what people and agents own.
