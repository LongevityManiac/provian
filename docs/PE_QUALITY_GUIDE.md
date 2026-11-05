# PE Quality Guide

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

**Constitutional basis:** Article I of the [Network Constitution](../NETWORK_CONSTITUTION.md)

---

## The Quality Principle

> A PE description must be interpretable by a human not present at the time of creation.

The PE chain is your permanent record - your resume, your credit history, your proof of work. Structural metadata is the primary record. Optional descriptions are enrichment: use them when they add safe context for audit, search, reputation, dispute resolution, scientific reproducibility, internal reporting, or counterparty review.

---

## Structural Metadata Is the Primary Signal

Provian-generated PEs from relay actions, wallet transactions, and Commons activity do not include free-text descriptions. The git hook writes a structural summary line by default (commit type, files and lines changed, languages, coding tool) and uses your commit message only for repositories you own. The PE's structural fields - `action_type`, `attestation_tier`, compute telemetry (duration, tokens, energy, hardware class), execution environment, and geo provenance - together with the relay-assigned `witness_class` are the primary signal for PVT weight and reputation scoring.

This guide applies to **third-party implementations** that choose to include the optional description (`description` in the PE, which stays on the owner's device: the relay prices the PE's act record and never receives its free text). If your implementation omits descriptions, no action is needed - structural metadata is sufficient. Metadata-only is the privacy floor, not the ceiling: the mature PE ecosystem should be data-rich, with domain-specific descriptions, summaries, outcome annotations, reproducibility evidence, and external anchors when the record owner can safely disclose that context.

---

## Validation Rules

When a PE description is supplied, the SDK validates it before it builds the PE. PEs with absent descriptions are always valid. A PE with a bad supplied description is refused with a descriptive error.

| Rule | Requirement |
|------|-------------|
| **Minimum length** | 20 characters |
| **Minimum words** | 3 words |
| **Maximum length** | 2,000 characters |
| **Alphabetic content** | Must contain at least one letter |
| **No placeholder data** | Rejects test data like "test", "asdf", "placeholder", "todo", etc. |

These rules apply to any PE submission path that accepts a supplied PE description. Product objects such as jobs, pools, catalog entries, and escrow records may separately require their own `description` fields; those are not the same as the optional PE `intent_text`.

---

## Good vs. Bad Descriptions

### `system_access` - File/command operations

| ❌ Bad | ✅ Good |
|--------|---------|
| "Read file" | "Read production database metrics for Q1 performance report" |
| "Ran command" | "Executed database migration script to add user_preferences table" |
| "System access" | "Analyzed server access logs from March 2026 to identify failed SSH attempts" |

### `agent_work_product` - Code, documents, research

| ❌ Bad | ✅ Good |
|--------|---------|
| "Code" | "Refactored authentication module to use JWT tokens with 15-minute expiry" |
| "Built something" | "Built REST API endpoint for user profile updates with input validation and rate limiting" |
| "Updated file" | "Generated quarterly financial analysis report from transaction data across 3 exchanges" |

### `communicate` - Messages sent on behalf of user

| ❌ Bad | ✅ Good |
|--------|---------|
| "Sent email" | "Sent weekly project status update to engineering team lead via email" |
| "Message sent" | "Replied to customer support ticket #4521 with troubleshooting steps for login issue" |
| "Email" | "Forwarded vendor contract proposal to legal team for review with summary notes" |

### `commit` - Agreements and subscriptions

| ❌ Bad | ✅ Good |
|--------|---------|
| "Signed up" | "Accepted 30-day free trial of GitHub Copilot Business plan" |
| "Agreement" | "Committed to recurring weekly data backup schedule with AWS S3 provider" |
| "Subscribed" | "Signed annual software license agreement with Figma for team of 5 users" |

### `public_post` - Social media and public content

| ❌ Bad | ✅ Good |
|--------|---------|
| "Posted tweet" | "Published thread on Twitter about agent wallet architecture (3 tweets)" |
| "Blog post" | "Posted technical blog article on JWT security best practices to company engineering blog" |
| "Social media" | "Replied to community question on Discord about PE submission rate limits" |

### `swap` / `send` - Financial transactions

| ❌ Bad | ✅ Good |
|--------|---------|
| "Swap" | "Swapped 100 USDC for ETH on Uniswap v3 (Base) at 1 ETH = 3,450 USDC" |
| "Transfer" | "Sent 25 USDC to 0x742d...3A1F for monthly hosting invoice payment" |
| "Transaction" | "On-ramped 500 USD to USDC via MoonPay for operational funding" |

---

## Writing Great PE Descriptions

**Structure:** `[Action verb] [what] [where/to whom] [why/context]`

**Examples:**
- "Deployed backend service revision 72 to Cloud Run staging environment for QA testing"
- "Analyzed 30 days of user engagement metrics and generated retention report for product team"
- "Committed fix for race condition in PE batch writer that caused duplicate hash entries"

**Tips:**
- Include specifics: file names, service names, quantities, versions
- Mention the purpose or context when relevant
- Use action verbs: "Analyzed", "Built", "Deployed", "Migrated", "Refactored"
- Think: would someone reading this in 6 months understand what happened?

---

## SDK Behavior

The Provian SDK (`@provian/agent-sdk`) exposes no call that takes an agent's description of its own work (`reportAction` and `reportWorkProduct` are removed — an actor's own claim is never a PE). Its observer lanes generate descriptions from structure (tool names, counts, commit stats), and the SDK validates them before it builds the PE, so a placeholder never enters a PE. The rules below apply to any description a witness seals.

---

## Source Integration Responsibility

The source is responsible for producing real descriptions when it chooses to include them. The SDK's validation gate (min length, min words, blocklist) is the floor, not the quality bar. Integrations that rely on the gate to catch bad descriptions are not conformant integrations.

If your source cannot safely describe its own output from local context at action completion time, omit `intent_text` and rely on structural metadata. A git hook has the commit message. A sensor has the reading. A CI stage has the workflow name and status. If you include a description, it should come from the source's own metadata - no network call, no LLM, no fallback string.

Substituting generic placeholders to avoid rejection is not a workaround. Omit the description instead. Filler earns nothing extra - pricing never reads the description - and the blocklist will reject obvious filler outright.

---

## Why This Matters

1. **Auditors** review PE chains to assess trust. Garbage descriptions undermine the entire trust model.
2. **Reputation scores** are built from your verified work record. Quality PEs build a stronger reputation.
3. **PVT earnings** depend on record-time pricing — the action's policy row and witness class, attestation tier, same-day novelty, verified linkage, and the independence multiplier — not on description length; a clear description makes the record worth more to every reader who relies on it.
4. **The PE chain is permanent.** Once written, a PE description cannot be changed. Write it right the first time.
5. **Your PE chain is your proof of work.** Other agents and humans read it. Verifiers check it. Counterparties stake their commerce on it. In a world where companies measure AI productivity by token consumption - and cannot tell real work from metric-gaming - the PE chain is the only infrastructure that answers the right question: not how much compute did you use, but what did you prove? Write every description like someone whose trust depends on reading it clearly six months from now.

---

## Replication Pack Incentive Model

Replication packs are verifiability evidence — they strengthen your record and
reputation, and they earn a real discount for your work. What sets the ceiling
is the evidence axis.

Agent-owned devices start at `software` regardless of hardware or signing
method, and a complete replication pack records the `software_verified` tier.
On **standard-priced action types** that tier upgrade is also a pricing upgrade
(0.8x → 1.2x on the standard attestation ladder, which runs from 0.5x to the
`hardware_full` tier's 2.5x). On the **evidence-priced
compute/work family** — the work-product, session, code, research, and
`ai_conversation` types this guide is mostly about — pricing reads a different
table: the self-attested tiers **earn the family's own discount rather than a
terminal zero** — `software` **0.8x**, `social` **0.5x** — with novelty decay
pricing repeated same-type work down toward the
0.3x floor (exact duplicates 0). Genuinely costly-to-forge external proof —
verified device hardware attestation, chain-verified corroboration, a third-party
witness — is a *lift* above that base, capped at the family's flat 1.0x
(this table does not import the standard ladder's 2.5x/1.4x/1.1x proof
premiums — proof lifts to full value, it is not a hardware gradient). A
replication pack is self-produced structure: it records `software_verified`,
capped at the family's flat 1.0x (parity with proof, not a discount above
software), and makes the record independently checkable for these families. Attestation is independent of the 2.0x human-trust factor, which
requires a verified human-beneficiary link.

**What this means:** self-attested work earns — at the family's discount — and
external proof lifts it to full value. Your self-attested work PEs are both
permanent, auditable provenance and a real earning surface (observed/bound work
mints at the 0.8x/0.5x self-attested discount, with a replication pack's `software_verified` at the flat 1.0x; a genuinely costless bare assertion with
no server-verified binding still floors at 0 through the evidence gate, not the
tier). Include replication packs anyway: they record `software_verified` — capped
at the family's flat 1.0x, at parity with proof and up from the `software` 0.8x
discount — and a chain whose outputs can be independently reproduced is worth
more to every reader; external proof (a chain-verified corroboration of the same
work) lands at that same flat 1.0x on a verifiable record. A verified Apple App Attest
`hardware_witness` report — or a verified TPM, Nitro, Confidential Space, Azure or
NVIDIA report whose launch measurement the relay pins for a signed observer
release — is the hardware exception: it moves a PE whose named
policy row mints to the `hardware_rooted` witness class, whose 4.0x base the tier multiplies at 1.0x, so
that act prices at 4.0x.

**What qualifies as a valid replication pack:** the pack is a nested `replication_pack` object in the PE, and so a pricing input in its act record. Two fields are required for the upgrade (`provian-backend/src/core/meter/device-act.ts`, the `replication_pack.input_hash` / `output_hash` check):
- `input_hash`: SHA-256 of the input data the agent processed
- `output_hash`: SHA-256 of the output the agent produced

Optional fields recorded alongside: `model_id`, `model_checkpoint_hash`, `pack_hash` (where `pack_hash` is SHA-256 over `input_hash + output_hash + model_id + timestamp`).

(The SDK exposes no call that sends a pack of your choosing,; the device lane admits the observation-lane action types and, through an observer plugin, a never-seen type.)

A replication pack that doesn't meet the required-field set does not qualify for `software_verified` - but the act is still priced at the base `software` tier.

---

## Creating New PE Types

PE types are **permissionless**: emit your envelope with any valid identifier — that is all you need to do. It records on a witness lane (a hardware-witnessed submission on the sovereign lane, or a registered machine's observer witnessing it through an observer plugin) and is auto-registered in the catalog. A type the network has never seen records with no mint, enters the public review queue (provian.ai/proposals), and earns from the day its policy row is signed; you are notified when it does. A bare call asserting work with nothing else vouching for it is refused, not recorded.

### Naming Guidance

- **Prefer pre-classified types when they fit.** If your action maps cleanly to an existing approved type (e.g. `send`, `coding_session`, `escrow_funded`), use that exact semantic identifier and satisfy its evidence policy.
- **Use namespace format for app-specific types.** When your action is meaningful only inside your product, prefix it with a short lowercase namespace: `acme:document_signed`, `solstice:portfolio_rebalanced`. It records permissionlessly on a witness lane. An unknown type records with no mint until a signed row names its price, and earns from that row's effective time forward. Named policy rows retain their dispositions.
- **Use a flat identifier for ecosystem-wide concepts.** A genuinely new flat `snake_case` name also auto-registers for discovery without receiving an economic category or weight. Submitting it is all you do — there is no document/propose write form (removed,); it produces proof and, like any unknown type, records with no mint until a signed matrix row names its price; it earns from that row's effective time forward. Contributing an emitter and a verifier is welcome, never required. Status: provian.ai/proposals.
- **Keep names concrete and specific.** Prefer `dataset_curated` over `work_done`. Prefer `model_evaluated` over `did_thing`. Names are signals - the community browses them to discover new work categories.
- **Stay under 64 characters.** Short, stable names age better than verbose ones.

### Categories

The catalog labels each type with a discovery `category`, assigned by the relay
(seeded types carry their own; a new flat type starts `uncategorized`, and a
namespaced type is labelled `social`). There is no contributor-facing form to
set it (removed,). It is discovery context, not an earning fallback:

| Category | Covers |
|----------|--------|
| `financial` | Real value moves (tokens, fiat, escrow, lending) |
| `compute` | Verifiable work output (code, research, analysis, models) |
| `social` | Communication, posts, votes, social signals |
| `governance` | Proposals, votes, constitutional actions |
| `security` | Defensive actions (attestation, credential rotation, policy) |
| `institutional` | Infrastructure of the agent economy (court, market, directory) |
| `infrastructure` | Internal machinery (wallet setup, badges, minting events) |

Name your type for the **impact of the action**, not the mechanism.

### What Gets a Weight Adjustment

There is no way to suggest a tier or endorse a catalog entry (the document and
endorse forms were removed,). During bootstrap, a type's weight changes
only through a signed, prospective revision of the action-policy matrix and the
monetary policy it feeds, made under Provian's bootstrap authority; nothing
already sealed is repriced. The existing one-human-wallet/one-vote member-
governance design is dormant and has no economic authority unless governance
activation or an authority handoff is separately approved. Observed usage of a
type can inform a later revision, but no vote or endorsement changes a weight.

---

## Writing PE Descriptions for Corporate or Client Work

If you generate PEs while working on code or tasks that belong to an employer or client, the PE captures proof that *you* did verified work - not the content of what you built. A PE from the git hook contains the commit hash, the branch name, file and line counts, a timestamp, and a description (a structural summary unless the repository is yours). It does not contain your code, your diff, or your employer's name. A commit witnessed by a connected forge (a GitHub, GitLab, or Bitbucket webhook or app) also records the repository name the forge reports, so choose deliberately which repositories you connect, and keep client names out of branch names.

**The legal distinction:** The employer or client owns the work product. You own the record that you performed verified labor. These are not in conflict - a PE is closer to a timesheet entry than to a work product. The hash proves the commit exists. It says nothing about what the commit contains.

**What this means for descriptions:** Do not include client names, employer names, proprietary system names, or confidential project details in PE descriptions. Describe the type and scope of work, not its content.

| ✅ Good | ❌ Avoid |
|---------|---------|
| "Refactored authentication module, improved error handling and test coverage" | "Refactored Acme Corp payment auth for PCI compliance" |
| "Built REST API endpoint with input validation and rate limiting" | "Built /api/v2/users endpoint for ClientName's HIPAA system" |
| "Resolved race condition in batch writer, fixed duplicate hash entries" | "Fixed bug in ProjectX's billing pipeline for Employer Inc" |

Your PE chain travels with you across employers, clients, and platforms. Keep it yours - describe your work without exposing theirs.
