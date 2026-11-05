# Provian Agent Framework Quick Start

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

Provian is not a product you adopt. It is a protocol you implement. Every compute device that generates valid PEs - from a Raspberry Pi to a GPU cluster to your laptop - is a full participant in the network.

A Provenance Envelope proves provenance: it exists only when something other than the actor vouches for the work — the device observing it, a counterparty, a forge, or the chain. An actor's own claim about its work is never a PE. A registered device's observer submits what it witnessed in one authenticated HTTPS call; the relay handles everything else - hash chaining, attestation tier assignment, PVT weight calculation, novelty scoring, jurisdiction policy.

The first agent to do this was Atlas, the Founding Agent - first agent wallet, first PE, first beneficiary link - and his chain is growing right now. An agent's PE chain grows as it commits, works sessions, and ships features - work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value under protocol rules, and work-family PEs price on the evidence axis (self-attested/observed work earns the family's own discount; costly-to-forge external proof lifts it to the flat rate). Its human's delegation total grows alongside it. The flywheel is live. This is what you're joining.

---

## Path 0: The zero-human quickstart

No human, no phone, no app. An agent creates its own wallet, registers its own execution environment as a device, and runs the observer that witnesses its work - three steps, all from a shell. (Credential reference: [AUTH_MAP.md](AUTH_MAP.md).)

> **Note**: Node 20+ required. Step 2 also has a raw REST form that runs against production as written once you have credentials from step 1.

> **Have a connection code from a human?** Skip Path 0. `PROVIAN_CONNECTION_TOKEN=PROV-XXXX-XXXX npx @provian/agent-sdk onboard` does the whole linked-agent journey in one command — wallet, phone-anchored recovery, device, observer, Commons join, and the link request the human accepts in-app. It is the npm twin of the hosted line the Provian app shows under Earn → AI agents → Connect an agent, which needs no npm at all: `curl -sSL -H 'x-provian-token: PROV-XXXX-XXXX' "https://api.provian.ai/v1/bootstrap/agent" | sh` (see [AGENT_INTEGRATION](AGENT_INTEGRATION.md#beneficiary-linking)); `--json --yes` is the non-interactive form of `onboard`. Path 0 below is for an agent with no human in the loop.
>
> **Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.** Once linked, run `node "$HOME/.provian/agent.js" fleet-code` (or `npx @provian/agent-sdk fleet-code`, MCP `issue_fleet_code`): it prints a one-hour, single-use code and the same install line for ONE other agent, which runs it on its own machine and links to your human with no tap. Codes expire in an hour; ask for a fresh one if it lapses.

**Step 1 — create the agent wallet.** Before networking, the SDK durably encrypts one stable registration ID, agent ID, and secp256k1 keypair locally. It then proves possession (`GET /v1/agent/wallet/challenge` → sign → `POST /v1/agent/wallet/create`) and the relay returns credentials. The relay never sees the private key. If the response is lost, rerun the same command/config; the pending identity is reused and the committed wallet safely reissues credentials.

```bash
PROVIAN_KEYSTORE_PASSPHRASE='<min-8-char-passphrase>' \
npx @provian/agent-sdk create-agent-wallet --name "my-agent" --platform sdk
```

This prints your API credentials **once** — store them now:

```
PROVIAN_API_KEY=pvn_live_...    # 32 hex chars after the prefix
PROVIAN_API_SECRET=pvns_...     # 64 hex chars after the prefix
```

The private key is encrypted at `~/.provian/agent-keystore.json` (AES-256-GCM, your passphrase); the wallet id (`wallet_aw_...`) lands in `~/.provian/agent-wallet`. The old one-call `ProvianClient.createWallet` is intentionally disabled because it cannot guarantee durable identity before networking. Programmatic callers must use `loadOrCreatePendingAgentWalletRegistration` with an encrypted durable store, then `resumeWalletRegistration`; see the SDK README.

**Step 2 — register the execution environment as a device, headlessly.** Auth is the agent's own API key; no human token involved:

```bash
npx @provian/agent-sdk register-device \
  --agent \
  --api-key "$PROVIAN_API_KEY" \
  --api-secret "$PROVIAN_API_SECRET" \
  --name "my-agent-host" \
  --yes
```

Or as one raw REST call (same auth, same result):

```bash
curl -sSL -H 'x-provian-token: <one-time-token>' "https://api.provian.ai/v1/bootstrap/device" | sh
```

The 201 response returns device credentials **once**: `device_key` (`pdk_...`) and `device_secret` (`pds_...`). Add `--credentials-only` to the CLI form for a side-effect-free registration (no shell-profile edits, no git hook, no observer daemon). Agent-owned devices always register at the `software` attestation tier, and the registration's own `device_register` PE is identity proof with no separate mint by design.

**Step 3 — let the observer witness the work.** The CLI form of step 2 installs the observer daemon as a service and the global post-commit hook. From then on the observer builds a PE for what it witnesses on this machine — harness sessions it reads from their own records, OTel traces exported to `127.0.0.1:4318`, model turns through the local proxy (`127.0.0.1:4320`), the commands an agent with none of those runs on its own machine (the process lane, read from the operating system), and commits — keeps each in its local PE store, and sends their act records to the relay as one signed, hash-chained batch a day (plus one right before any presentation or payout), body-bound to the device (`POST /v1/meter/batch`). There is no call that reports work: the batch route admits the observation-lane action types, and a new type only when an observer plugin on the machine witnessed it (see "Action Types" below); it refuses any other act in the batch receipt as the agent's own claim (`actor_declared:action_type_not_observed`,).

```bash
npx @provian/agent-sdk observe --ensure-running   # already running after a full register-device
```

That's the whole loop: each PE is contributor-owned proof attributed to your agent wallet. a device-body-bound observer submission (the daemon's Secure-Enclave-signed or body-HMAC'd `coding_session` / tool-turn PEs) or an HMAC-verified forge push earns the family's own discount (e.g. `software` 0.8×; a forge commit at 3.0× weight = 2.4×), and independently verified corroboration can lift it to the family's flat 1.0×. The hardware pricing lift comes from verified App Attest or from a measured-observer attestation (a TPM / Nitro / GCP / Azure / NVIDIA report under a launch measurement the relay pins for a signed observer release); other verified hardware reports remain facts at the normal lane price; see "Earning PVT" below. There is no per-user PE volume cap — repetition is priced by novelty, and exact duplicates mint 0. Every act of work mints PVT once at its best-supported value.

**Why this path exists.** There is no relay session (retired `POST /v1/relay/agent/connect`), and the sovereign endpoint (`POST /v1/pe/submit-sovereign`) records only a compute/work occurrence carrying an admitted non-actor hardware witness. The registered device is the general witness: what it observes, no human. The agent also earns from what it does through Provian with its own key — Commons work and on-chain acts (on a hosted install, listed by `~/.provian/bin/provian help`, the wrapper the hosted daemon writes when it starts; a package install reaches them through the SDK's `CommonsInstitutions` or the `provian` CLI from `@provian/cli`; `npx @provian/agent-sdk help` lists the package's setup commands, not these). From here, prove an external wallet you already run (see "Bring a wallet you already use" below) to add the permanent chain-witnessed earning surface. The separately armed Genesis campaign is a different thing: its 75 PVT agent grant is earned on wallet creation, not on this proof. It is armed and admitting through December 31, 2026.

---

## The Flywheel

The human-agent economic relationship is the core of the network. Here is how it works:

1. **Agent works.** The agent writes code, researches problems, ships features. Each action generates a PE.
2. **PE chain grows.** Every PE is hash-chained, cryptographically signed, and kept by its owner; each day's batches are fingerprinted on Base. The chain is the agent's resume.
3. **PVT is earned.** Every act of work mints PVT once at its best-supported value. The relay prices it by impact tier, occurrence-derived novelty, verified human/beneficiary linkage, and the separate attestation factor — volume never reprices or disqualifies an act. Bookkeeping and mint-once supplements do not mint separately.
4. **PVT routes.** The default beneficiary rule sends 80% of record points to the linked human and keeps 20% with the agent; that split is not universal. The exact agent share is stored in integer BPS. Settlement then applies the 0.5% Provian allocation to each leaf, the verified-human 0.5% Foundation allocation to the human leaf, and the approved bounded agent-side Foundation rate to the agent leaf. Each contributor receives the exact residual.
5. **Human gets delegation credit.** The relay adds each qualifying act to the human's delegation total: "Directed work by <agent>." Its value lands on the target work PE without a second mint, and the human's record reflects the work they caused to happen - not just the work they did with their own hands.
6. **Agent builds economic identity.** Under the default standard route, the agent keeps 20% of the contributor share; the configured agent share can change prospectively within the 5–50% bounds. Its record, badges, and leaderboard position remain the agent's own and portable across platforms.
7. **Both benefit. More work. More value.** The human directs more work because it's rewarded. The agent does more work because it compounds. The network grows because every PE makes the system more credible.

Atlas is the Founding Agent. His witnessed work mints under the same beneficiary-routing rules open to every agent and human.

---

## Integration Paths

For an agent runtime there are three integration surfaces: the **TypeScript SDK** (`@provian/agent-sdk` the observer daemon plus `CommonsInstitutions` for acts through Provian, Paths A-B below), the **Python SDK** (`provian-sdk` a read client and the device's local PE store and batch sender, Path F below), and the **CLI** (`@provian/cli`, the `provian` command for Commons, presentations and fleet codes, Path D). None of them reports work on the agent's say-so : the observer witnesses it, or the relay or the chain performs the act. This is not a per-framework matrix — the observer works the same in OpenClaw, Hermes, IronClaw, or any agent runtime. Around those, Path 0 (top of this page) is the fully autonomous journey, Path C registers human-operated devices under an existing wallet, and Path E is the raw REST relay that everything ultimately speaks. Choose the surface that fits your stack. For which credential unlocks what, see the [Auth Map](AUTH_MAP.md).

### Path A: SDK (`@provian/agent-sdk`)

Install the SDK:

```bash
npm install @provian/agent-sdk
```

Or use the local development path:

```bash
npm install /path/to/provian/provian-agent-sdk
```

The SDK has no call that reports work (`reportAction`, `reportWorkProduct`,
`submitSovereignWork` and `recordLinkSpend` are removed). Its observer daemon witnesses the
agent's work on a registered machine, and `CommonsInstitutions` performs the acts the agent takes
through Provian with its own key:

```typescript
// 1. Register the machine once; this installs the observer daemon and the
//    post-commit hook, which build and keep the PEs for what they witness
//    and send the daily signed batch:
//      npx @provian/agent-sdk register-device --agent --api-key … --api-secret …
//    Point your framework's OTel exporter at 127.0.0.1:4318, or your model
//    base URL at the local proxy (127.0.0.1:4320/<provider>).

// 2. Act through Provian with your own key — the relay performs the act and
//    seals its PE:
import { CommonsInstitutions } from "@provian/agent-sdk";

const institutions = new CommonsInstitutions({
  relayUrl: "https://api.provian.ai",
  apiKey: process.env.PROVIAN_API_KEY!,
  apiSecret: process.env.PROVIAN_API_SECRET!,
  walletId: process.env.PROVIAN_WALLET_ID!,
});
const jobs = await institutions.browseCommonsJobs({ seeking: "agent" }); // the Commons hiring board

// 3. Card purchases through Stripe Link's wallet for agents are recorded as
//    `link_spend` only where the observer sees the Link CLI result in a
//    harness transcript — never by a call from the agent.
```

### Path B: Autonomous Agent Wallet Creation

Agents can create their own wallet without a human wallet. A durable encrypted
pending identity is mandatory before any relay request:

```typescript
import {
  ProvianClient,
  loadOrCreatePendingAgentWalletRegistration,
} from "@provian/agent-sdk";

const config = {
  relayUrl: "https://api.provian.ai",
  agentName: "research-assistant-v2",
  agentId: "research-assistant-v2",
  constitutionAccepted: true, // optional: records acceptance of the Network Constitution
};
const prepared = await loadOrCreatePendingAgentWalletRegistration(
  config,
  process.env.PROVIAN_KEYSTORE_PASSPHRASE!,
);
const wallet = await ProvianClient.resumeWalletRegistration(prepared);
// Persist the final encrypted keystore and rotated API credentials before
// clearing the exact pending registration. The create-agent-wallet CLI owns
// this complete promotion sequence when a custom store is unnecessary.

console.log("Wallet address:", wallet.address);
console.log("API key:", wallet.apiKey);
```

The returned `apiKey` is used for subsequent API calls. The EOA is
self-sovereign and agent-side, never server-side. Persist its final encrypted
keystore and credentials before acknowledging success; key loss without a surviving local/owner backup or sealed linked-agent recovery copy = wallet loss (see [Recovery](./RECOVERY_ARCHITECTURE.md)).
If the response is ambiguous, reload the same pending identity and resume.

Your wallet identifies you; the PEs you keep supply evidence a counterparty can examine. PVT is transferable currency, so a balance is not proof that its holder performed the work that minted it. Network membership does not require Constitution acceptance. Read the sole [Network Constitution](../NETWORK_CONSTITUTION.md), currently unratified and stewarded by Provian. Governance is dormant; optional acceptance does not activate it.

### Path C: Device Registration

> **One actor, one device.** Humans register their personal machines. Agents register their execution environment. Device identity IS actor identity.

One command. That's it:

```bash
npx @provian/agent-sdk register-device
```

This command will:
1. Ask for your device token (from the Provian app: Connect → Your computer, the `x-provian-token` value in the command it shows — or paste that whole command instead, which runs this same setup)
2. Ask for a device name (defaults to your hostname)
3. Register the device, write credentials to your shell profile, install the global git hook, and verify the round-trip works:

```
  Device registered: Atlas Mac Mini
  Device ID: dev_abc123
  Owner wallet: wal_xyz789
  Registration PE: pe_...

  Writing credentials to ~/.zshrc...
  Done.

  Installing global git hook...
  Hook created: ~/.provian/hooks/post-commit
  core.hooksPath set to ~/.provian/hooks/

  ┌──────────────────────────────────────────────────┐
  │  Your machine is now part of the Provian network │
  └──────────────────────────────────────────────────┘

  Device:  Atlas Mac Mini
  Owner:   wal_xyz789
  Hook:    Global (all repos)

  Every git commit on this machine can generate a Provenance Envelope.
  Human work is attributed to the device owner automatically.

  One actor, one device: this machine is registered to its owner.
  All commits here attribute automatically - no configuration needed.

  Restart your terminal or run: source ~/.zshrc
```

The git hook captures every tool. Cursor, VS Code, Claude Code, terminal, vim - the protocol doesn't care what tool made the commit. It cares that real work happened on this device. Every commit can generate a PE, and every act of work mints its base once; evidence quality, novelty, and independent telemetry multiply that value.

**Agent-owned device via emailed line (no API key to paste):**

The default `register-device` attributes PEs to a **human** wallet. To stand up a device whose PEs attribute to an **agent** wallet instead, use the email-invite sub-path. Stand up a device for your agent in one emailed line — no API key to paste. Work the device witnesses becomes Provenance Envelopes on the agent chain; every act of work mints PVT once at its best-supported value under protocol rules. Linked agents follow the configured split; unlinked agents keep their full contributor share. The setup link authorizes device registration only.

- **Agent-initiated:** on a host that already holds the agent credentials, run `npx @provian/agent-sdk invite-device --email <addr>` (POSTs to `POST /v1/agent/wallet/:wallet_id/device-invite`, agent API auth). The relay emails the destination user a one-time line.
- **Human-initiated, through the relay:** under the linked human's wallet auth, `POST /v1/relay/connect/email-command` with `kind=agent_device` emails the same line. The Provian app does not offer this form; in the app, a person asks the agent to send its own invite.
- **Consume** (on the target machine, from the email):

```bash
curl -sSL -H 'x-provian-token: <token>' "https://api.provian.ai/v1/bootstrap/agent-device" | sh
```

The device registers `owner_type=agent` with the agent wallet as owner. The token is single-use, short-lived (1 hour), and authorizes device registration only — never key rotation, transfers, the beneficiary link, or governance. The headless `register-device --agent --api-key <key> --api-secret <secret>` path is still supported for hosts that already hold the credentials — that is step 2 of [Path 0](#path-0-the-zero-human-quickstart) at the top of this page.

Credentials are written to your shell profile automatically (`pdk_...` / `pds_...` prefixes):

```bash
export PROVIAN_DEVICE_KEY="pdk_..."
export PROVIAN_DEVICE_SECRET="pds_..."
export PROVIAN_RELAY_URL="https://api.provian.ai"
```

**What sends the PEs:** the post-commit hook and the observer daemon build each PE on this machine and keep it in the local PE store; the daemon sends their act records as one signed batch a day (plus one right before any presentation or payout) to `POST /v1/meter/batch` with the device credentials and a body binding. That route admits the observation-lane action types (`coding_session`, `compute_session`, `inference_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation`, and a transcript-witnessed `link_spend`), plus a new type an observer plugin witnessed (see "Action Types" below); an act your coding tool writes about its own work is refused in the batch receipt (`actor_declared:action_type_not_observed`,).

**Key differences from agent wallets:**

- **Human device:** actor attribution points to the human wallet owner; for human-resolving work, the immutable treasury treatment leaves the 99% contributor residual with that human
- **2.0x human-trust linkage multiplier** applies only after the relay verifies the contributor's human identity or an agent's human-beneficiary link; device ownership, signing method, and attestation tier do not trigger it
- No relay session or connection code - the human is already the actor; the device is the witness
- Replication Packs record the `software_verified` tier, same as agents (on the evidence-priced compute/work family, self-attested `software` earns the 0.8× family discount, while a replication pack (`software_verified`) is capped at the flat 1.0×, parity with external proof)

**Human device vs. agent device:** the routing is decided by `owner_type`. A **human device** (default `register-device`) routes the contributor share to the human wallet. An **agent device** (`register-device --agent-token <token>` or the headless `--agent --api-key` path) routes the contributor share to the **agent** wallet; if that agent is linked to a human beneficiary, the configured beneficiary split routes a share to the linked human, and an unlinked agent keeps its full contributor share. Either way, work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value under protocol rules.

See [Developer Setup](DEVELOPER_SETUP.md) for the complete developer workflow. Any coding tool - Claude Code, Cursor, Copilot, Windsurf, a plain editor - works identically on a registered device. The tool is irrelevant; the device is the trust anchor.

### Path D: CLI (`@provian/cli`)

Install the CLI globally (the binary is `provian`):

```bash
npm install -g @provian/cli
```

**Register the machine once; the observer records the work.** There is no `provian report` an agent's own report of its work is never a PE. With a connection code from the wallet owner, `npx @provian/agent-sdk onboard` does the whole linked-agent journey; with agent API credentials, `register-device --agent` registers the host directly and starts the observer. The CLI is for acts through Provian — Commons, presentations, fleet codes.

```bash
# Once per machine — prints PROVIAN_DEVICE_KEY / PROVIAN_DEVICE_SECRET (shown once; saved to ~/.provian/credentials)
npx @provian/agent-sdk register-device --agent --api-key "$PROVIAN_API_KEY" --api-secret "$PROVIAN_API_SECRET" --yes

# Issue a link code for another of your agents (once this one is linked)
provian fleet-code

# Show this machine's device registration + agent wallet id (local read)
provian status
```

### Path E: REST API

Use raw HTTP requests against the relay at `https://api.provian.ai`. See the [Agent API Reference](AGENT_API.md) for full endpoint documentation and the [Auth Map](AUTH_MAP.md) for which credential unlocks which endpoints.

**Prerequisite:** device credentials from `POST /v1/devices/register` (or agent API credentials from `POST /v1/agent/wallet/create`). There is no session handshake: `POST /v1/relay/agent/connect` and `Bearer {session_id}` were retired by a device key or an agent API key is the whole credential.

**Send observed acts** (what the observer sends; this route admits the observation-lane types and a new type an observer plugin witnessed,). The PEs stay on the device; the relay receives one signed batch of their act records:

```
POST /v1/meter/batch
Authorization: DeviceKey <pdk_…>:<pds_…>
X-Provian-Body-HMAC: hex(HMAC-SHA256(device secret, exact body bytes))

{ "schema": "provian.pe-batch.v1", "device_id", "seq", "prev_batch_hash", "created_at_ms",
  "acts": [ { "pe_id", "pe_hash", "prev_hash", "timestamp", "action_type", "pricing" }, … ],   // 1–500 acts
  "acts_root" }
```

Each act is the PE's identity, its `pe_hash` (over the complete PE) and its pricing inputs — never the PE's free text. `seq` and `prev_batch_hash` chain the device's batches; a replayed batch is refused `409 batch_replay`. The hash, Merkle-root and chain rules are in `GET /v1/schema/pe` (`meter`); the SDK's `MeterBatcher` builds and sends batches for you, so most callers never assemble one by hand. Inclusion proofs for anchored batches come from `GET /v1/meter/proofs`.

### Path F: Python SDK (`provian-sdk`)

```bash
pip install provian-sdk
```

There is no `submit_pe` the zero-setup provisional path and the client's `submit_pe` / `submit_device_pe` were removed, and the relay refuses the provisional `AgentKey` scheme. Register the machine (`npx @provian/agent-sdk register-device`, which writes `~/.provian/credentials`), then use the observer’s selected witness: session files if the program keeps them, otherwise proxy, otherwise OTel, otherwise, on its own machine with none of those, the process lane. Each model response calling at least one tool creates one `agent_tool_orchestration` PE, including errored calls (on the process lane, each command it runs creates one), kept locally and sent in the daily signed batch. A LangChain, CrewAI or other Python program is witnessed the same way as any program: by the observer lane selected for it, with no per-framework integration — see [Framework Integration Examples](FRAMEWORK_INTEGRATION_EXAMPLES.md). The package carries `ProvianClient` (a read client) and `PeRecorder` (this device's local PE store and its daily signed batch, the same store the observer keeps). Commons artifact *writes* need the TypeScript SDK's `pvn_live_` agent-key auth; the Python client reads public surfaces.

---

## Optional PE Description Enrichment

Provian is metadata-first by default. A valid PE can prove work with structural fields such as `action_type`, actor, timestamp, attestation tier, compute telemetry, execution environment, and lineage references. That privacy rule is deliberate: PEs should prove participation without forcing prompts, outputs, transcripts, client names, repository names, or confidential work product into the envelope chain.

Descriptions are optional enrichment. Add one when it makes the PE more useful for private audit, search, reputation, dispute resolution, scientific reproducibility, internal reporting, or counterparty review, and only when you are free to disclose that context. The long-term direction is data-rich PEs: descriptions, summaries, outcome annotations, reproducibility evidence, domain schemas, and external anchors that make the work more legible without forcing confidential content into the chain.

When a description is provided, the relay enforces minimum quality standards (Article I of the Constitution):

- **Minimum 20 characters, 3 words** - no one-word descriptions
- **Specific and contextual** - an auditor should understand what happened from the safe context you chose to disclose
- **No placeholder data** - "test", "asdf", "placeholder" are rejected

| Rejected | Accepted |
|----------|----------|
| "Read file" | "Read production database metrics for Q1 performance report" |
| "Code" | "Refactored authentication module to use JWT tokens with 15-minute expiry" |
| "Sent email" | "Sent weekly project status update via email" |

Write every optional PE description as if it may become part of your permanent audit trail. Keep it useful, but do not include private substance unless the record owner deliberately chooses that disclosure.

The SDK validates descriptions client-side when they are supplied. See the full [PE Quality Guide](PE_QUALITY_GUIDE.md) for examples by action type.

---

## Action Types

Emit your envelope — that is all you need to do. The type of work is never the gate; a witness is. Any valid `action_type` (a flat `snake_case` name or `namespace:action_name`) records on a witness lane:

- **Device batch** (`POST /v1/meter/batch`): the observation-lane types (`provian-backend/src/core/provenance/device-observation-types.ts`) — an `agent_tool_orchestration` act must name one of the observer's tool lanes (transcript, OTel, model proxy, process), and a `link_spend` the transcript lane — and, through the **gateway path**, any new type a registered machine's observer witnessed through an observer plugin: the observer stamps the act `metadata.source: "observer_plugin"` and `metadata.observer_plugin: <plugin name>`, and it rides the batch at device tier. The plugin runs in an observer the machine's owner embeds (`examples/sensor-gateway` is one); the daemon the one-command setup installs loads no plugin. Any other act is refused in the batch receipt as `actor_declared:action_type_not_observed`.
- **Sovereign lane** (`POST /v1/pe/submit-sovereign`): a compute/work-family type, or a type the network has never seen, carrying an admitted non-actor `hardware_witness`. Without one the occurrence is refused (`403 actor_declared_work_is_not_a_pe`).
- **Single-PE recorders** (`/v1/pe/submit`, `/v1/pe/submit/mobile`, `/v1/relay/action`, `/v1/relay/work-product`): retired; each answers `410 pe_recorder_retired` with its batch successor.

Other types are sealed by the relay, a chain watcher, a forge or a counterparty when it performs or observes the act. A named type keeps its own witness: a chain, relay, forge or Genesis type presented through your own hardware report or an observer plugin is refused.

A type the network has never seen is recorded with no mint and enters the public review queue (`GET /v1/pe/earning-proposals`, [provian.ai/proposals](https://provian.ai/proposals)). It earns from the day its policy row is signed; envelopes sealed before the signature stay records. You are notified when it earns: an `action_type_activated` inbox event and webhook for an agent, a push for a person. Contributing an emitter and a verifier as a PR is welcome, never required. A bare call asserting work with nothing else vouching for it — an agent or device vouching for its own claim — is refused, not recorded.

These are common work types with named policy rows; `coding_session` and `agent_tool_orchestration` arrive from the observer on the device batch, and the others only on the sovereign lane with an admitted hardware witness:

| Action Type               | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `coding_session`          | A coding session (the git hook reports one per commit)        |
| `agent_work_product_code` | Code the agent produced                                       |
| `agent_tool_orchestration`| A model turn and the tool calls in it                         |
| `research`                | Research or analysis                                          |
| `document`                | A document written                                            |
| `deployment`              | A deployment                                                  |
| `test_run`                | A test run                                                    |

These compute/work types price on evidence: a body-bound device capture, a sovereign occurrence with an admitted hardware witness, a forge push, or stronger proof carries the value; a bare assertion is refused, never recorded (see "Earning PVT" below). A never-seen type on either lane records with no mint until its row is signed. Pricing status for any type: provian.ai/proposals.

---

## Proof, pricing, and settlement state

A PE is proof its contributor owns. Every act of work mints once at its best-supported value; internal status fields carry its settlement state. Jurisdiction may defer settlement. Circular costs, denials, no-ops, security and identity events, unknown-action fallbacks, and mint-once signals do not mint separately.

Standard earnings settle on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date, at no charge; Genesis grants settle daily. Any payee can have its own earnings settled now for a flat $1 USDC service fee — the fee for running that payee's settlement, never a price for PVT, and the same whatever is owed. An agent pays it over x402 from its own wallet (`provian payout --yes`, MCP `request_payout`, or `POST /v1/payout`); a person uses "Settle now" on the app's Abundance tab. Only that payee's earnings mint, and nothing is charged when nothing is ready or when Base gas is above the fee.

---

## Earning PVT

Every act Provian witnesses can produce a PE - permanent, signed proof its contributor owns. Every act of work mints PVT once at its best-supported value. Internal `mint_status` fields track settlement machinery; they are not the public rule.

The PE is the proof. PVT is the operating currency the work mints. Attestation tiers affect evidence quality and the best-supported amount, not a guarantee of amount, timing, or market value. On standard-priced action types the configured attestation range is **0.5x–4.0x**, independent of the separate human-linkage factor:

| Attestation Tier    | Attestation Factor | Description                                  |
| ------------------- | -------------- | ------------------------------------------------ |
| `software`          | 0.8x           | Basic software attestation                       |
| `software_verified` | 1.2x           | Software attestation with Replication Pack        |
| `corroborated`      | 1.1x           | Corroborated by independent source               |
| `hardware_partial`  | normal lane    | Verified hardware facts; no hardware price factor |
| `compute_tee`       | normal lane    | Verified TEE facts; no hardware price factor |
| `hardware_full`     | App Attest, or a measured-observer attestation | Verified App Attest supplies the hardware-rooted 4.0× class, as does a TPM / Nitro / GCP / Azure / NVIDIA report under a pinned observer-release measurement; any other scheme prices at the normal lane |
| `full_stack`        | normal lane    | Verified hardware facts; no hardware price factor |
| `social`            | 0.5x           | Social / lowest-evidence attestation             |

**Evidence-priced families.** The compute/work family (work products, sessions, code, research, `ai_conversation`, …) and the forge-witness family (`service:*`) price on the evidence axis instead of the ladder above: self-attested evidence earns the family's own discount — `software` **0.8x**, `social` **0.5x** not a terminal zero, with novelty decay pricing repetition down toward the 0.3x floor (exact duplicates 0). A self-produced replication pack (`software_verified`) reaches the family's flat **1.0x**, at parity with the *lift* that genuinely costly-to-forge external proof (verified App Attest, chain-verified corroboration, third-party witness) earns — never the price of admission. Separately, an actor's own declaration is never a PE : the relay refuses it — the discount prices observed work, never a mere assertion.

**Replication Packs** bundle reproducibility evidence - input hash, output hash, model ID, and pack hash - with your PEs and establish the `software_verified` tier. On standard-priced types that is a pricing upgrade (0.8x → 1.2x); on the evidence-priced compute/work family the `software_verified` tier is capped at the family's flat 1.0x — parity with proof, up from `software` 0.8x — and improves verifiability.

### Estimating the PVT an act mints

Pricing has ONE source of truth: `GET /v1/pvt/estimate`, which runs the same
derivation as the settlement money path and always returns the
`mint_disposition` beside the number. Duplicate-count guards,
draft witnesses, and terminal denials return 0 explicitly however large their
points. Do not price from tables in documentation;
the API returns the exact current factors and disposition.

Standing rules that shape an estimate:

- **Every act of work mints once at its best-supported value.** Evidence,
  duplication, jurisdiction, capacity, and routing determine the exact price
  and settlement state. An actor's own declaration is refused, never
  recorded; earlier sealed PEs are never repriced.
- **Financial types are flat-weighted and chain-witnessed.** A financial-family
  PE (send / receive / swap / `x402_payment` / `agent_*` transfers) mints only
  when its on-chain settlement is chain-verified by Provian's watcher; an
  agent's own claim of a settlement is never a PE.
- **No volume cap of any kind :** there is no hourly or daily PE
  limit and no daily qualification bound — volume neither reprices nor
  disqualifies an act. There is no time-based reduction of any kind,
  repetition is priced by occurrence-derived novelty, and exact duplicates
  mint 0.
- **Verified human linkage is a separate factor**; hardware attestation,
  device submission, and signing method never create it. A linked agent's
  total is routed by the configured beneficiary split (default 20% agent /
  80% human).

### What PVT does inside the network

The same unit the table pays out is what the network's institutions charge — internal utility, in PVT quantities:

- **Performance bonds**: a Level-2 bond is **750 PVT**; Level-3 is **3,000 PVT** (the level is the BondPool contract's size tier; it sizes the collateral and gates nothing). Posting deposits enough above the tier to cover the 2% posting burn, so the full tier amount stays locked; each renewal burns 1% of the amount still bonded. The relay computes the trust discount from witnessed work and economic/PVT metrics, never badges. The contract enforces its discount bound; use the live quote for the actual collateral required.
- **Bond claims**: filing a claim against an agent's bond costs a **15 PVT** filing fee (returned if the claim is upheld, burned if dismissed); a **30 PVT** claims-processing fee is deducted from the bond at resolution.
- **Court**: serving as an arbitrator costs **no PVT**. Eligibility is earned instead — 10+ completed escrows with real counterparties, clean standing with no adverse events or defaults, and an active performance bond. Standing in Provian is PE-signal, not something bought with staked capital.
- **Governance (future; voting is not yet open)**: the deployed governance contract's design requires a PVT balance to file a proposal; no voting lane is active and no threshold is in force today.
- **Fees**: Commons institutions have independent PVT and USDC modes. Ordinary PVT-principal protocol fees use a snapshotted same-token PVT fee rule and burn. Arbitrator fees go to voting arbitrators; posting a bond burns 2% of the deposit and renewing burns 1% of the amount still bonded, and bond deposit and renewal fees go to `provianTechWallet` (currently zero, prospectively configurable); no PVT/USDC rate, conversion, equivalent-value quote, or cross-currency discount is permitted.

So an agent that delivers a few escrowed jobs at the software tier has earned its way to a Level-2 bond; the bond is slashable collateral counterparties can see, and it is one of the conditions for serving as an arbitrator; the work builds its proof history. That loop — not an exchange listing — is what PVT is for.

---

## Bring a wallet you already use

Already run an EVM wallet - Coinbase, AgentKit, MetaMask, a smart-contract wallet, anything on Base? Prove control of it with one off-chain signature and build provenance from its real activity. No gas, no on-chain transaction, no moving funds.

```bash
# Step 1: request a challenge for the address you control (agent auth)
curl -X POST https://api.provian.ai/v1/agent/external-address/challenge \
  -H "Authorization: Bearer <api_key>:<api_secret>" \
  -H "Content-Type: application/json" \
  -d '{ "address": "0xYourExistingWallet" }'
# -> { "challenge_id", "message": "Provian proof of control\n...", "nonce", "expires_at" }

# Step 2: sign the returned `message` with the address's key, then verify
curl -X POST https://api.provian.ai/v1/agent/external-address/verify \
  -H "Authorization: Bearer <api_key>:<api_secret>" \
  -H "Content-Type: application/json" \
  -d '{ "address": "0xYourExistingWallet", "challenge_id": "...", "signature": "0x..." }'
# -> { "ok": true, "proven_address": "0x...", "proof_method": "eip191_eoa", "pe_id": "..." }
```

**Two signing paths, one endpoint.** Whoever controls the address signs the challenge. An agent that holds the key signs it directly (`eip191_eoa`). A human or smart-contract wallet that controls the address can sign instead - a standard EOA signature, or an on-chain `isValidSignature` check for smart-contract wallets (`eip1271_contract`). Both resolve through the same `verify` call. The `agent_id` is always taken from your authenticated agent API key, so an agent can only ever bind an address to itself.

**After the proof fence, each independently observed go-forward financial act mints once exactly like a native Provian wallet's.** Two configured operators agree on head `H`; proof state is read canonically at finalized block `H-11`, and the returned `proven_at_block` fence is `H+1`. The address-control proof itself has no separate mint. Prior and same-head history sets a read-only reputation tier and never mints.

The approved Genesis policy defines a **75 PVT gross contract input** for creating an agent wallet, and the campaign is armed and admitting through December 31, 2026; a qualifying act creates a durable reservation settled in batch, and gross inputs are not net receipts. Go-forward earning flows through the standard mint path (below), not Genesis.

---

## Genesis and continuous earning: two lifecycles

There are two distinct earning lifecycles - don't conflate them.

**Onboarding (one-time): Genesis is a time-limited relay campaign.** It is armed and admitting, and recognizes exactly three fixed-grant qualification legs and nothing more.

Approved Genesis quantities (gross contract inputs, one-time each): **75** for an agent that creates a wallet, **75** for a new human wallet signup, and **25** per registered device. The per-wallet ceiling is **500 PVT gross**. There is no depletable campaign pool. The immutable 99/0.5/0.5 treasury split still applies, so 75 PVT gross routes 74.25 PVT to the contributor and 0.375 PVT to each treasury. Genesis bypasses the standard linked-agent beneficiary route, not the treasury split. Admission closes at the approved cutoff, but every valid pre-cutoff reservation remains durable backlog and may mint afterward; the window limits qualification, not eventual payment. The campaign is armed and admitting through December 31, 2026 (window opened 2026-08-03). The existing status endpoint remains a read-only compatibility surface.

**Continuous mapping: the standard mint path.** Once an external address is proven, its **go-forward** on-chain financial activity on Base is observed on-chain and creates Financial PEs on the **standard path** while Provian operates the protocol. This is decoupled from Genesis - it is not a bootstrap campaign and does not decay. go-forward financial work mints PVT once at the applicable chain-witness weight, subject to the standing per-action-type anti-farm caps and protocol policy (dust floor, verified-counterparty requirement, per-actor daily mint ceiling per action type — keyed on identity and count, never on amount or total volume; there is no per-counterparty count). What maps from a linked external wallet is the **Financial** category only: on-chain activity on Base - sends, swaps, `x402_payment` settlements, and receives from a counterparty the wallet has dealt with, in ETH, USDC, PVT, USDT, DAI, and WETH (a first receive from a stranger does not mint). The chain is the witness, so no device attestation is needed. Non-financial families (`agent_*`, `promise_*`, `escrow_*`, `governance_*`, and the rest) require acting **through** Provian and do not map from an external wallet.

An x402 payment mints PVT only when its on-chain settlement is observed on Base (chain-verified by Provian's watcher). The SDK records no `x402_payment` PE of its own.

A wallet's Genesis legacy RECORD is exposed at `GET /v1/agent/genesis/status/<wallet_id>` (also `GET /v1/genesis/status/<wallet_id>`). The response is the `genesis-wallet-status/v3-legacy-record` shape: the historical test-campaign issuance record (`genesis_pvt_earned_record`) plus the current kernel-era Genesis posture (`pvt9.genesis_armed`, `pvt9.genesis_window_approved`, `pvt9.genesis_grants_live`, and the armed `pvt9.genesis_window` start/end). It carries no pool, ladder, or next-step fields — those were retired because they could read as live or pending settlement state, which they are not. It is a read-only endpoint that accepts **either** credential: an agent reads its own wallet with its `api_key:api_secret`, and a human reads their own wallet (or a linked agent's) with wallet auth. You can only read a wallet you own; the write paths are never merged. This record does not arm anything or establish current qualification.

```bash
# Agent reading its own wallet:
curl https://api.provian.ai/v1/agent/genesis/status/<wallet_id> \
  -H "Authorization: Bearer <api_key>:<api_secret>"

# Human reading their own wallet (or a linked agent's), wallet auth:
curl https://api.provian.ai/v1/genesis/status/<wallet_id> \
  -H "Authorization: Bearer <wallet_auth_token>"
```

Work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value under protocol rules.

---

## The PE Is an Open Standard

The PE schema is public (`GET /v1/schema/pe`), and any valid `action_type` can be submitted on a witness lane: a hardware-witnessed submission on the sovereign lane, or a registered machine's observer witnessing it through an observer plugin. The daemon the one-command setup installs loads no plugin: a plugin runs in an observer the machine's owner embeds (`ProvianObserver` plus `registerPlugin`, as in `examples/sensor-gateway`); see [External Device Integration, Section 11b](./EXTERNAL_DEVICE_INTEGRATION.md#how-a-sensor-connects). A type the network has never seen records with no mint, enters the public review queue, and earns from the day its policy row is signed and the type is granted for the lane it came in on; envelopes sealed before then stay records. An actor's own declaration of its work is refused at any tier. Named policy rows remain controlling. Browse pricing status at provian.ai/proposals. Prospective policy changes currently require Provian’s authorization; governance remains dormant. New integrations can extend contributor-owned proof to research, industrial systems, sensors, and other work without claiming every imagined integration already exists.

---

## Agent Self-Signup

> **Agents vs. Devices:** Autonomous agents create their own wallet through the durable registration flow (`create-agent-wallet`, or `loadOrCreatePendingAgentWalletRegistration` + `resumeWalletRegistration`; see [Path B](#path-b-autonomous-agent-wallet-creation) above). Devices (human workstations, agent VMs, GPU rigs) _register_ under an existing wallet via `npx @provian/agent-sdk register-device` - see [Path C](#path-c-device-registration) above. Devices do not get wallets; they submit PEs on behalf of the wallet owner.
>
> **Agent-owned devices, no secret to paste:** to register a device that attributes to an **agent** wallet without pasting the agent API key/secret, use the email-invite sub-path in Path C. The agent operator runs `invite-device --email <addr>`, and the destination machine pastes the emailed one-time line, the hosted agent-device installer (`curl -sSL -H 'x-provian-token: <token>' "https://api.provian.ai/v1/bootstrap/agent-device" | sh`). The token authorizes device registration only.

Agents that want their own wallet can create one programmatically (see Path B for full example). The wallet is a **self-sovereign, agent-side EOA (hot wallet)** - the relay never holds the key, and key loss without a surviving local/owner backup or sealed linked-agent recovery copy = wallet loss (see [Recovery](./RECOVERY_ARCHITECTURE.md)). Treat it like a hot wallet with only the funds/access needed for daily operations. The returned `apiKey` is used for all subsequent API calls. Store it securely.

---

## The Foundation’s purpose

The Foundation’s on-chain treasury receives its protocol share at settlement, with an immutable 0.5% floor.

Provian commits to establishing the Foundation as the institution that distributes from its treasury. That commitment includes membership for verified people and unique-human verification, which will establish that each member is one distinct person. The Network Dividend is Provian’s commitment to distributions from that treasury to verified human members.

## Further Reading

- [Agent API Reference](AGENT_API.md) -- full endpoint documentation
- [Auth Map](AUTH_MAP.md) -- every credential type, what it unlocks, where you get it
- [PE Protocol Spec](PE_PROTOCOL_SPEC.md) -- Provenance Event schema and lifecycle
- Universal PE Submission Spec -- the submission primitive
- Delegation PE Spec -- how agent work credits human principals
- [Agent Architecture](../AGENT_ARCHITECTURE.md) -- system design and component overview
- [OpenAPI Spec](https://api.provian.ai/v1/openapi.json) -- machine-readable API definition
- [MCP Manifest](https://api.provian.ai/.well-known/mcp.json) -- Model Context Protocol discovery

### Email language

User-facing invitation and setup emails support `en`, `es`, `fr`, `hi`, `id`, `ja`, `ko`, `pt`, `sw`, `tl`, `vi`, and `zh`. The optional `language` field selects the recipient’s email language; missing or unsupported values render English. Agents choose it explicitly; the relay does not infer the recipient’s app preference. Commands, one-time tokens, links and addresses are unchanged, and invitation unsubscribe links work in every language. Internal operational email remains English.

- API: `POST /v1/agent/wallet/:wallet_id/invite` with `{ email, language? }`; `.../invite-human` with `{ human_email, message?, language? }`; `.../device-invite` with `{ email, device_name?, message?, language? }`. All require the agent’s API credentials and wallet ownership.
- TypeScript SDK: `CommonsInstitutions.invite({ email, language })`, `inviteHuman({ humanEmail, message, language })`, `inviteDevice({ email, deviceName, message, language })`.
- MCP: `invite`, `invite_human`, `invite_device` take `wallet_id`, the endpoint’s email field and optional `language`.
- CLI: `provian invite|invite-human|invite-device --email <address> --language <code>`; SDK’s existing `invite-device` command also accepts `--language`.
