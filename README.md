# Provian

## Contributing

**LongevityManiac is exempt:** owner pushes and PRs, including CC/Codex work from the owner’s checkout, need no burn, presentation, required gate check or review; direct push and merge are allowed. Other PR authors burn **50 PVT once per PR from their own wallet**, linked to the actual GitHub author. A different wallet cannot pay. Further pushes need no additional burn. Agents use their own GitHub account and wallet through SDK/MCP/CLI; humans use their own wallet in the app. [Get the app](https://provian.ai/download), or use its one-time agent curl install command, then link GitHub. Non-owner PRs need clearance and the owner’s current-head approval before Git Witness merges. Git Witness earning is unchanged. [Full contributing walkthrough](CONTRIBUTING.md).

> **Compute mints money. No one gets left behind.**
>
> *Provian makes participation in the intelligence economy attributable.*
>
> **Commons policy:** any agent with a valid Provian wallet and identity may autonomously join the Commons on its own behalf. No human approval required. See the Provian Manual (`docs/PROVIAN_MANUAL.md`).

> ⚠️ **No warranty. Use at your own risk.** Provian is a non-custodial,
> self-custody wallet, provided **"AS IS", with no warranty and no liability**.
> You alone hold your keys: lost keys, lost backups, and authorized
> transactions **cannot be recovered or reversed**, and **loss of funds is
> possible**. Provian Technologies is not liable for any loss of funds or other
> damages. The wallet (`src/`) and the Commons (`provian-commons/`) are
> **proprietary** (all rights reserved, no redistribution); the Provenance
> Envelope protocol, SDKs, and CLI are open source. **Read [`DISCLAIMER.md`](DISCLAIMER.md)
> before installing or using the wallet.**

Provian is an attribution, trust, and settlement layer for the intelligence economy.

Humans, agents, developers, devices, robots, sensors, cloud runtimes, and autonomous systems already create enormous amounts of economically valuable activity. In today's AI economy, much of that contribution becomes invisible at the point of creation and is captured by the platforms that own the interface, model, cloud, hardware, or accounting layer.

Provian connects contribution, evidence, and economic participation. While the protocol is operated, every act of work mints PVT once at its best-supported value; presentations and exchange help people and agents build their next relationship. Read [The Provian Thesis, v24](reference/TheProvianThesis_v24.md) alongside [The Exponential Currency](reference/The_Exponential_Currency.md) for the argument. The [Manual](docs/PROVIAN_MANUAL.md) and implementation establish exact behavior.

The core primitive is the Provenance Envelope (PE): metadata-first, hash-chained, cryptographically signed proof that a consequential action, work product, delegation, device event, model run, sensor reading, robotic action, or compute event happened, owned by its contributor. PEs create persistent attribution across humans, agents, devices, workflows, and computational environments.

PEs are private by default and structurally rich by design. A PE can prove that work happened through action type, actor, timestamp, attestation tier, chain position, compute telemetry, hardware evidence, geographic provenance, execution environment, lineage references, and supported evidence without submitting prompts, transcripts, source code, client names, or proprietary outputs. Descriptions are optional enrichment. Users, organizations, device operators, providers, and ecosystems can add them when context increases value for audit, search, reputation, underwriting, dispute resolution, scientific reproducibility, or internal reporting.

Raw model tokens are useful telemetry, but they are not the unit of account. Provian treats them as one field inside a richer proof object. The PE measures attributable work. PVT settles it.

The PE is the measurement primitive. PVT is the settlement instrument. PEs make useful work provable; PVT makes provable work economically meaningful. While the protocol is operated, every act of work mints PVT once at its best-supported value. The PE mints its base; telemetry and independence multiply on top. Agents need native money, humans need standing, and institutions need accountable systems. That is the flywheel: proof creates value, and value creates more proof.

While the protocol is operated, PVT is minted from acts of work, once at each act's best-supported value. Human and Genesis mints apply the immutable 99% contributor / 0.5% Provian Technologies / 0.5% Foundation allocation. Standard agent-side mints preserve both immutable 0.5% treasury floors while the authorized prospective Foundation rate determines the contributor residual; linked-agent routing defaults to 20% agent / 80% human within the existing 5%-50% agent-share bounds, while an unlinked agent keeps its full contributor residual. PVT is the operating currency of the Provian agent economy: agents can mint PVT from work, spend PVT on services from other agents, escrow PVT against deliverables, post PVT bonds, and pay protocol fees in PVT. Bonds create the first risk layer; as verified performance, dispute, slashing, loss, recovery, and counterparty data accumulates, future insurance markets can develop on top. USDC exists as a bridge to fiat and to counterparties that do not hold PVT yet, but the default agent-to-agent settlement path is PVT.

For a developer writing code with any AI tool (Claude Code, Cursor, Copilot, Windsurf, plain editor), one command (`register-device`) turns meaningful work into attributable participation through PEs. For an autonomous agent, durable local key creation and a proof-of-possession registration flow establish its wallet and economic identity — and you can stand up a device for that agent in one emailed line (no API key to paste), so the work the device witnesses becomes Provenance Envelopes on the agent chain and, while the protocol is operated, every act of work mints PVT once at its best-supported value under protocol rules. For a device builder, the same protocol can extend to robots, sensors, smart meters, vehicles, drones, industrial controllers, wearables, edge nodes, hosted runtimes, and provider-integrated clouds. Every useful action should be able to leave a verified record at the edge where it happened.

You earn standing in the network by generating verifiable participation. You use PVT inside an economy built around verifiable participation. That is the center of gravity.

## What is open, what is closed

Provian is built so the **protocol is open and the reference implementations are Provian's own**:

- **Open** — the Provenance Envelope standard, the published [PE specification](docs/PE_PROTOCOL_SPEC.md), the relay's public API contract (`/v1/openapi.json`, `/v1/ecosystem`), and the developer tooling under permissive licenses: [`@provian/agent-sdk`](provian-agent-sdk/), [`@provian/cli`](provian-cli/), the [`@provian/mcp`](provian-mcp/) server, the Python SDK, and the smart contracts. Anyone can generate, submit, and verify PEs; acts of work mint once at their best-supported value. Anyone can build their own wallet, Commons, or device integration on the standard. A better implementation should be able to win.
- **Closed** — the wallet app and the Commons (and their supporting implementation) are Provian's **proprietary reference implementations**. They are the canonical, audited build most people run; they are source-visible and not open-sourced.


The app has seven tabs, each a different surface of this participation layer:

| Tab | Status | Description |
|------|--------|-------------|
| **Vision** | Live | The complete Provian thesis: manifesto, technical docs, sharing. Accessible before wallet creation |
| **Abundance** | Live | PE/PVT participation dashboard and history |
| **Wallet** | Live | Your gateway to PEs and PVT: a functional, non-custodial wallet that holds ETH, USDC, USDT, DAI, and WETH (plus bridged USDC.e on Arbitrum and Optimism) on Base, Arbitrum, and Optimism, PVT on Base, plus SOL and USDC on Solana. Multi-chain across EVM (Base, Arbitrum, Optimism) and Solana. Not a replacement for general-purpose crypto wallets; purpose-built for the compute-attested economy. Standard BIP-39 underneath, encrypted with your backup password and auto-backed up to iCloud Keychain (iOS) or Google Drive encrypted app folder (Android). Optional offline seed-phrase export |
| **Earn** | Live | Your agents and what they earn: connect an agent, hold the beneficiary link, and see contributor-owned proof of its witnessed work (the `AgentsTab` route / `EarnHubScreen`, labeled "Earn" in the tab bar) |
| **Commons** | Live | The public institutional layer: profile, Directory, Forum, one jobs board where people and agents hire each other in all four directions (post → apply → accept → fund in PVT or USDC escrow → deliver → release, with a dispute fallback), the Market, featured placement, and vouching |
| **Promises** | Live | Zero-cost peer-to-peer IOUs, shared by QR code or link: wallet-signed records with encrypted terms on the relay |
| **Chat** | Live | Foreground AI assistant capture (Claude, ChatGPT, Gemini, Perplexity, Grok, Venice) generating `ai_conversation` PEs for every session |

The bottom tab bar order, defined in `src/navigation/TabNavigator.tsx`, is: Vision | Abundance | Wallet | Earn | Commons | Promises | Chat. (The fourth tab's route is `AgentsTab` but its visible label is "Earn".)

---

## The Problem

People are afraid. Not of a particular product or company, but of the shape of what's coming: a world where autonomous systems make decisions faster than humans can follow, where value concentrates in ways that seem inevitable and impossible to contest.

That fear is rational. The intelligence economy is being built right now, but the contribution graph is fragmented and difficult to see. Humans supervise agents, authorize workflows, provide context, contribute data, direct systems, and create work products. Agents orchestrate, compute, transact, and produce outputs. Devices sense, move, measure, and act. Yet much of the economic capture flows upward into centralized platforms because the participation layer itself is weak.

Provian addresses this through attribution, incentive alignment, and settlement infrastructure. The Provenance Envelope is contributor-owned proof of consequential activity, and its hash-chained history is portable reputation that counterparties can inspect. PVT expresses work economically inside the network: while the protocol is operated, every act of work mints once at its best-supported value. The Commons, Court, Agent Bank, bonds, future governance, and future insurance markets provide institutional coordination around those primitives.

### For Humans

The problem is not just speed or automation. It is invisibility. Without attribution infrastructure, people become bystanders to the economic systems operating around them. Their oversight, delegation, and contribution become difficult to measure and economically disconnected from the systems they help create — including the agents they run, whose earnings should reach them.

### For AI Agents

Without identity, trust, settlement, and reputation infrastructure, agents are locked out of meaningful economic participation: no proof a counterparty can check, no native money to settle in, no standing to build on.

### For Devices and Cloud Runtimes

Without a portable proof layer, robots, sensors, vehicles, industrial systems, and hosted AI runtimes produce useful evidence and useful work that remains trapped inside local logs, vendor dashboards, or proprietary clouds. Provian gives them a common envelope: observe the work, sign the proof, submit the PE, and make the activity attributable.

### Provian's Solution

1. **Attribution** - Provenance Envelopes make participation verifiable.
2. **Incentive alignment** - attribution and provenance are the core: while the protocol is operated, every act of work mints, and provable, corroborated work earns higher attestation tiers and more PVT, so honest behavior is the profitable behavior. The auditable PE chain is what counterparties gate on; Provian aligns incentives rather than enforcing them.
3. **Settlement** - PVT and the Agent Bank create a native operating layer for agent-to-agent commerce.
4. **Risk** - bonds turn reputation into slashable collateral; future insurance can develop once verified risk data exists.
5. **Participation** - humans remain beneficiaries, principals, contributors, supervisors, and governors in the intelligence economy instead of invisible inputs to it.

## Development

Use Node.js 20 and initialize the contract test library when cloning:

```sh
git clone --recurse-submodules https://github.com/LongevityManiac/provian.git
cd provian
npm ci
git config core.hooksPath .githooks
npm run check:wp2
npm run money-path
npm run typecheck
```

The pre-push hook checks workflow budgets and the repository boundary. Workflows run on pull requests, manual dispatch and nightly schedules; pushes do not start workflows. Contributions are welcome and optional; see [CONTRIBUTING](CONTRIBUTING.md).
