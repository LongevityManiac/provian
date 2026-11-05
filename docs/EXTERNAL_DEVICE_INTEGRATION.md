# External Device Integration Guide

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

**Version:** 2.0
**Status:** Stable
**Location in repo:** `docs/EXTERNAL_DEVICE_INTEGRATION.md`

> This guide describes the **Device Path** for PE generation. For the broader conceptual model - including the Agent Path and what distinguishes a mechanical witness from a self-report - see [PE Generation Model](./PE_GENERATION_MODEL.md). Devices can be registered as **human devices** (PEs attribute to the owner's wallet) or **agent devices**. An unlinked agent keeps its full contributor allocation; for a linked agent, later PEs seal the configured contributor-layer beneficiary split at record time (default agent 20% / human 80%, prospectively configurable with an exact agent share from 5% through 50%). The immutable 0.5% Provian cut and 0.5% human/Genesis Foundation floor apply; an agent-side Foundation rate may adjust prospectively under authorized policy, with the contributor receiving the residual. Prior PE snapshots never change. An agent device can be set up either with the headless `register-device --agent --api-key <key> --api-secret <secret>` flag or, without pasting any secret, via a one-time emailed line (`register-device --agent-token <token>` — see Section 2). Human devices can present verified hardware evidence for human-directed compute. Agent devices witness autonomous agent compute but start at the `software` tier regardless of their physical hardware or signing method. Work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value under protocol rules.

This guide covers how to build a PE-generating agent on any compute device that doesn't run the Provian wallet - mining rigs, GPU inference clusters, coding workstations, home servers, IoT devices, Raspberry Pis, anything that does real work and can reach the internet.

The wallet is the user's control center. External devices extend the PE network to all the compute that happens outside the phone. When a mining rig finds a block or a GPU cluster completes an inference job, a PE becomes proof its contributor owns. Every act of work mints PVT once at its best-supported value for the device owner using the same mechanism as wallet-native actions.

A sensor, instrument or rig connects one of two ways: a hardware-attested device submits on the sovereign lane, or the sensor reports through a registered machine whose owner runs an SDK observer with a plugin for it. The daemon the one-command setup installs witnesses the machine's own work and loads no sensor plugin. See [Section 11b, "How a sensor connects"](#how-a-sensor-connects).

---

## 1. Prerequisites

Before a device can send PEs, its owner must:

1. **Choose the owner.** For your own computer, use the app’s one-time setup command. For an agent-owned device, the agent can use its self-created wallet and an emailed device invitation or its own API credentials; no human app account is required for that path.

2. **Register the device.** One-time ceremony that links device credentials to your wallet. See Section 2.

3. **Keep PEs and send the daily batch.** The device builds and keeps each PE, and sends their act records once a day (plus once right before any presentation or payout) to `POST /v1/meter/batch` with its device credentials. See "The manual way" in Section 2.

---

## 2. Device Registration

Registration creates a credential pair (`pdk_`/`pds_`) bound to your Provian wallet. After registration, acts sent with those credentials are attributed to your account.

### The easy way - one pasted line

Use the one-time token inside the setup command shown in the Provian app (Connect → Your computer; it is the `x-provian-token` value) and run the line below. Or, in the app's **Connect → Your computer**, get the one-time setup command and run it on that computer: a hosted `curl -sSL -H 'x-provian-token: <token>' "https://api.provian.ai/v1/bootstrap/device" | sh` one-liner that drives the full `register-device` setup (git hook, credentials file, observer).

```bash
curl -sSL -H 'x-provian-token: <one-time-token>' "https://api.provian.ai/v1/bootstrap/device" | sh
```

The response prints `PROVIAN_DEVICE_KEY` / `PROVIAN_DEVICE_SECRET` **once** — export them in your shell profile; the device's daily PE batches authenticate with them. Re-running the same line (same `Idempotency-Key`) reuses the persisted registration identity and original client-generated credentials.

`npx @provian/agent-sdk register-device` does the same registration and also writes the exports, installs a global git `post-commit` hook at `~/.provian/hooks/`, and starts the observer — after which every git commit on the machine generates a PE automatically.

### Agent-owned device by emailed line - no secret to paste

The commands above register a **human device**. To register an **agent device** — one whose PEs attribute to an agent wallet — without pasting the agent API key/secret, use the one-time email-invite flow. Stand up a device for your agent in one emailed line — no API key to paste. Work the device witnesses becomes Provenance Envelopes on the agent chain; every act of work mints PVT once at its best-supported value under protocol rules. Linked agents follow the configured split; unlinked agents keep their full contributor share. The setup link authorizes device registration only.

Two ways to send the invite, one way to consume it:

1. **Agent-initiated.** From anywhere that holds the agent credentials:

   ```bash
   curl -sS -X POST https://api.provian.ai/v1/agent/wallet/<wallet_id>/device-invite \
     -H "Authorization: Bearer pvn_live_...:pvns_..." \
     -H "Content-Type: application/json" \
     -d '{"email":"bob@example.com","device_name":"Mining Rig Alpha","message":"set up the rig"}'
   ```

   This hits `POST /v1/agent/wallet/:wallet_id/device-invite` (agent API auth, ownership-guarded). The relay mints a one-time, device-registration-scoped token and emails the destination user.

2. **Human-initiated, through the relay.** Under the wallet auth of the agent's linked human, `POST /v1/relay/connect/email-command` with `kind=agent_device` and the `agent_wallet_id`. The Provian app does not offer this form; in the app, a person gives the agent the one command from Connect, or asks the agent to send its own invite (above).

Both agent-computer paths email the same hash-checked hosted installer, which the recipient runs **on the target machine**. Use the exact macOS/Linux or PowerShell line from the email: it carries the short-lived device-registration token, downloads the installer, checks its SHA-256, ensures the supplied Node runtime and starts the observer. It saves the device credentials locally; no agent wallet key is emailed. Follow the observer's setup instructions to describe the program's actual session files, or select proxy then OTel only when the preceding lane cannot cover it; an agent on its own machine with none of those is witnessed by the process lane. The emailed installer is run by a person, so it records no launcher: the agent runs `"$HOME/.provian/bin/provian" process-lane record` once from its own harness on that machine, and from then on each command it runs there is witnessed. Setup completes after a real new tool-calling model response, or, on the process lane, a real command, is witnessed. Human-computer emails in Section 1 instead use the direct registration call and print the credentials once.

The device registers `owner_type=agent` with the agent wallet as `owner_wallet_id`. The endpoint never returns the token (it goes only into the email); the token is single-use, short-lived, and authorizes **device registration only** — never key rotation, transfers, link-human, or governance. The relay revalidates the agent wallet (must exist and be active) at consumption time. A host that already holds the agent credentials can skip the email and register itself directly (same call, `Authorization: Bearer pvn_live_...:pvns_...`).

### The manual way - REST API

```
POST https://api.provian.ai/v1/devices/register
Authorization: Bearer {your_wallet_auth_token}
Idempotency-Key: {stable 16-128 char id}
Content-Type: application/json

{"device_name":"Mining Rig Alpha","device_type":"mining_rig","platform":"linux"}
```

`device_type` is one of `coding_workstation`, `mining_rig`, `gpu_cluster`, `home_server`, `iot_device`, `mobile_agent`, `cloud_instance`, `other`. The response carries `PROVIAN_DEVICE_KEY` / `PROVIAN_DEVICE_SECRET` once, as above.

The device then keeps each PE it builds and sends their act records in its daily batch:

```
POST https://api.provian.ai/v1/meter/batch
Authorization: DeviceKey {device_key}:{device_secret}
X-Provian-Body-HMAC: {hex HMAC-SHA256 of the exact request body under device_secret}
Content-Type: application/json
```

`Authorization: Basic {base64(device_key:device_secret)}` also works; a Secure-Enclave-registered device signs the body instead (`DeviceSignature` + `X-Provian-Signature`).

**What the batch admits.** PEs prove provenance: a PE exists only when something other than the actor vouches for it. The type of work is never the gate; a witness is. The device batch admits, in a body-bound batch:

- the action types an observation lane emits — `compute_session`, `inference_session`, `coding_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation`, and a transcript-witnessed `link_spend`;
- **the gateway path:** an act of any other type that the machine's observer witnessed through an observer plugin (Section 11b). The observer stamps it `metadata.source: "observer_plugin"` and `metadata.observer_plugin: <plugin name>`, and it records at device tier. The plugin runs in an observer the machine's owner embeds with `registerPlugin` (`examples/sensor-gateway` is one); the daemon the one-command setup installs loads no third-party plugin. A type the network has never seen records with no mint and enters the public review queue (`GET /v1/pe/earning-proposals`, [provian.ai/proposals](https://provian.ai/proposals)); it earns from the day its policy row is signed and the type is granted for this lane, and acts sealed before then stay records. A named type keeps its own witness — `environment_attestation`, `agent_uncategorized`, `anomaly_detected`, the named `agent_work_product_*` rows (`agent_work_product_code` and its siblings), a chain, relay, forge or Genesis type — and is refused here even with the plugin marker.

An act of any other type without the plugin marker, or an act in a batch that is not body-bound (unless it carries an admitted hardware witness), comes back in the receipt as `refused` with an `actor_declared:` reason and is never priced.

**Canonical events.** A body-bound act of a device-witnessed family — `compute_session`, `inference_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `link_spend` — or a `coding_session` carrying a `metadata.commit_sha` seals as a verified record priced at the device's attestation tier, provided it also carries its canonical event: `metadata.turn_id` (or `trace_id`) for the two orchestration types, the observer's attested session lineage for `compute_session` / `inference_session`, the commit sha for `coding_session`, or the Link spend-request id (`lsrq_…`, succeeded only) for `link_spend`. The SDK observer supplies all of this for you; an act missing its canonical event still records but stays `record_only`.

**The PE (v2), kept on the device:**
```json
{
  "schema": "provian.pe.v2",
  "pe_id": "pe_...",
  "device_id": "dev_...",
  "prev_hash": "<pe_hash of this device's previous PE, or \"genesis\">",
  "timestamp": 1791100000000,
  "action_type": "coding_session",
  "description": "Refactored authentication module across 12 files with JWT token migration",
  "metadata": {
    "tool": "claude-code",
    "commit_sha": "...",
    "files_changed": 12,
    "lines_added": 340
  },
  "pe_hash": "<sha256 over the canonical JSON of the complete PE minus pe_hash and signature>"
}
```

**The batch body (1–500 acts):**
```json
{
  "schema": "provian.pe-batch.v1",
  "device_id": "dev_...",
  "seq": 12,
  "prev_batch_hash": "<batch_hash of the device's last accepted batch, or \"genesis\">",
  "created_at_ms": 1791100000000,
  "acts": [
    { "pe_id": "pe_...", "pe_hash": "...", "prev_hash": "...", "timestamp": 1791100000000,
      "action_type": "coding_session", "pricing": { "metadata": { "...": "..." } } }
  ],
  "acts_root": "<Merkle root over the act leaves>"
}
```

`pricing` is the PE minus its identity fields (`schema`, `pe_id`, `device_id`, `prev_hash`, `timestamp`, `action_type`, `pe_hash`, `signature`), its free text (`description`, `intent_text`) and its owner-local private fields (`private_commitment`, `private_owner_view`, `detail_commitment`). A PE built with private pricing — the SDK does this whenever it holds the device secret — carries its pricing inputs sealed in `private_pricing`, and its act's `pricing` is then only `private_pricing` plus any `hardware_witness` and `detail_hash`; such a batch is sent as `{ "private_batch": <box> }`, the batch and each act's opening encrypted under the device secret. The exact canonical JSON, act leaf, `acts_root` and `batch_hash` rules are published in `GET /v1/schema/pe` under `meter`; the SDK's `MeterBatcher` builds and sends batches for you.

**PE fields** (the identity fields above are required):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action_type` | `string` | Yes | One of the observation types above, or a type an observer plugin witnessed (the gateway path above); see [PE Protocol Spec](./PE_PROTOCOL_SPEC.md) §3 |
| `description` | `string` | No | Optional free text, min 20 chars / 3 words / max 2000 chars when included. Covered by `pe_hash`, never sent to the relay. Structural fields are sufficient without it. |
| `metadata` | `object` | No | Arbitrary key-value pairs (tool name, files changed, metrics, etc.) |
| `replication_pack` | `object` | No | Cryptographic evidence recording the `software_verified` tier (a 1.2x pricing upgrade on standard-priced types; on the evidence-priced compute/work family the self-attested `software` tier earns the 0.8x family discount, while a replication pack (`software_verified`) is capped at the flat 1.0x, parity with proof; see Section 5). See [PE Protocol Spec](./PE_PROTOCOL_SPEC.md) §9. |
| `compute` | `object` | No | Compute telemetry: `duration_ms`, `tokens_processed`, `records_processed`, `output_cardinality`, `cpu_seconds`, `memory_peak_mb`, `energy_joules`, `gpu_seconds`, `model_parameters`, `framework`, `hardware_class`. |
| `geo` | `object` | No | Geographic provenance: `latitude`, `longitude`, `altitude_m`, `accuracy_m`, `hardware_attested`, `region_code` (ISO 3166-2). |
| `execution_env` | `object` | No | Execution environment: `os`, `os_version`, `runtime`, `runtime_version`, `container`, `tee_type`, `tee_version`. |
| `input_origins` | `object[]` | No | What this work consumed; a prior PE is cited as `{ hash: "<its output_digests hash>", origin_identifier: "pe:<pe_id>" }` (`cited_pe_ids` is retired and folded into this). |
| `output_digests` | `object[]` | No | `{ hash, kind }` per artifact produced — never content. |
| `hardware_witness` | `object` | No | A non-actor-signed report over the act's hardware nonce (its identity and pricing inputs minus this field); verified App Attest, or a verified TPM / AWS Nitro / GCP Confidential Space / Azure / NVIDIA report whose launch measurement the relay pins for a signed Provian observer release → `witness_class: hardware_rooted` (4.0×); other verified reports → presentation facts at the normal lane price (bare attested submission: device tier); unverifiable → recorded, never lifted. |
| `parent_goal_pe_id` | `string` | No | Links action PEs to the goal-level PE they belong to. |

Device PEs support optional compute telemetry fields. Include what the device can observe. These fields make the PE a richer proof of computational work and may influence future weight framework adjustments. All fields are nullable. No act is refused for omitting them.

**Response (201 Created):** the batch receipt, which the device files beside its PEs. The same batch re-sent gets `200` and the same receipt.
```json
{
  "schema": "provian.pe-batch-receipt.v1",
  "device_id": "dev_...",
  "actor_id": "wal_xyz789",
  "seq": 12,
  "batch_hash": "...",
  "acts_root": "...",
  "batch_leaf": "...",
  "accepted_at_ms": 1791100000000,
  "acts": [
    { "pe_id": "pe_...", "pe_hash": "...", "relay_pe_id": "...", "leaf_index": 0,
      "disposition": "eligible", "reason": "...", "record_points_atomic": "...", "mint_status": "eligible" }
  ],
  "totals": { "eligible_points_atomic": "...", "acts": 1, "eligible": 1 }
}
```

Read `record_points_atomic` together with `disposition` (`eligible | record_only | held | duplicate | refused | ineligible`): record points are not PVT, and a `record_only` act mints 0. Pricing has one source of truth (`GET /v1/pvt/estimate` and the receipt), never a table in documentation.

**Volume:** there is no per-user PE volume cap. Repetition is priced by novelty; exact duplicates mint 0.

**The relay handles for you:**
- Checking that each batch continues the device's chain (Section 6)
- Attestation tier assignment based on device capability + replication pack
- PVT record-point calculation (action policy, occurrence-derived novelty — no time-based reduction and no volume cap — verified-human linkage, and the separate attestation factor). The human-trust multiplier comes only from verified human/beneficiary linkage, never from device type, hardware, or signing method.
- 30-day corroboration window for software PEs (measured from the PE's record time)
- Duplicate detection (mint-once per occurrence; a replay earns 0)
- The daily on-chain fingerprint of every accepted batch; each device fetches its inclusion proofs from `GET /v1/meter/proofs`

---

## 4. Building a Mining Rig PE Agent

Bitcoin mining PEs record hashrate, energy consumed, blocks found, and BTC earned. A rig records them through the **gateway path**: an observer plugin on the rig's registered machine reads the miner's events and emits each as a PE of a type you choose (Section 11b), and the observer carries it in the device's body-bound daily batch at device tier. The plugin below runs in an observer you embed (`ProvianObserver` + `registerPlugin`, as in `examples/sensor-gateway`); the daemon the one-command setup installs witnesses the rig's own compute and does not load it. A rig whose hardware attests to its work can instead submit on the sovereign lane (Section 11b, path 1). Emit your envelope — that is all you need to do. A type the network has never seen, such as `btcmining:block_found`, records with no mint and enters the public review queue ([provian.ai/proposals](https://provian.ai/proposals)); it earns from the day its policy row is signed and the type is granted for the lane it came in on, and you are notified when it does. Contributing an emitter and a verifier as a PR is welcome, never required. Use your own types: a named type such as `environment_attestation`, `agent_uncategorized` or `anomaly_detected` keeps its own witness and is refused on this path. The rig's compute also records, as before, as a `compute_session` with `compute` telemetry from the observer's own lanes.

### What to record

| Metric | PE field | Notes |
|--------|----------|-------|
| Session start | `action_type: 'btcmining:session_start'` | Record hardware specs, pool URL |
| Block found | `action_type: 'btcmining:block_found'` | Record block height, reward, difficulty |
| Session end | `action_type: 'btcmining:session_end'` | Record total hashrate, uptime, BTC earned |
| Anomaly | `action_type: 'btcmining:anomaly'` | Hardware failure, pool switch |

### Example: Block found PE

The plugin queues one PE per event and hands it to the observer from `drainPEs`; the observer builds the v2 PE (`pe_id`, `prev_hash`, `pe_hash`), stamps the plugin marker and keeps it in the local PE store.

```typescript
import { createHash } from 'crypto';
import type { ObserverPlugin, PluginPE } from '@provian/agent-sdk/observer';

interface BlockFound { height: number; rewardBTC: number; difficulty: number; poolUrl: string; sessionStartMs: number; sessionWh: number }

class BtcRigPlugin implements ObserverPlugin {
  readonly name = 'btc-rig';
  private queue: PluginPE[] = [];
  async init() {}
  async start() { /* subscribe to the miner's block-found events, calling onBlockFound */ }
  async stop() {}
  tick() { return null; }
  drainPEs(): PluginPE[] { const out = this.queue; this.queue = []; return out; }

  onBlockFound(block: BlockFound): void {
    const now = Date.now();
    this.queue.push({
      actionType: 'btcmining:block_found',
      description: `Bitcoin block #${block.height} found. Reward: ${block.rewardBTC} BTC. Difficulty: ${block.difficulty}.`,
      metadata: {
        asset_symbol: 'BTC',
        amount: block.rewardBTC.toString(),
        block_height: block.height,
        pool: block.poolUrl,
        null_state_flags: ['no_counterparty', 'no_contract'],
      },
      // Energy and hardware go in compute telemetry
      compute: {
        duration_ms: now - block.sessionStartMs,
        energy_joules: block.sessionWh * 3600,
        hardware_class: 'asic_miner',
      },
      // The digest of the reading, never its content
      output_digests: [{ hash: `sha256:${createHash('sha256').update(JSON.stringify(block)).digest('hex')}`, kind: 'artifact' }],
      windowStart: now,
      windowEnd: now,
      skipDedupClaim: true,   // a point event, not a compute-session window
    });
  }
}
```

> **Note:** `description` is optional. When omitted, the PE's structural fields (`action_type`, `metadata`, `compute` telemetry) are sufficient for recording and scoring. It is covered by `pe_hash` and never sent to the relay. Whatever the plugin puts in `metadata.source` or `metadata.observer_plugin` is overwritten by the observer.

### Corroboration

The relay does not read Bitcoin chain or pool data, so a block hash carried in the PE (for example in `metadata`) is recorded with the act but corroborates nothing. A `software` act on the compute family (0.8x) is lifted to the family's flat 1.0x inside its 30-day window only by a witness the relay itself checks (Section 2, "The relay handles for you").

---

## 5. Building a GPU Inference PE Agent

GPU inference PEs record model execution: what model ran, what input hash was submitted, what output was produced. These are compute/work-family PEs and are evidence-priced : a complete Replication Pack records the `software_verified` tier, capped at the family's flat 1.0x — parity with proof; the self-attested `software` tier earns the 0.8x family discount, with novelty decay pricing repeated runs down toward the 0.3x floor (exact duplicates 0). Independent corroboration supplies its authorized enhancement. Admitted hardware evidence that proves a pinned Provian observer measurement selects the `hardware_rooted` class; a hardware report without that measurement remains a presentation fact at the ordinary lane price.

### Example: Owner-local inference PE shape

This illustrates the owner’s envelope shape. The observer must supply the canonical witnessed session identity and authenticated batch evidence; a hand-built claim about an inference run does not mint.

```typescript
import { createHash, randomBytes } from 'crypto';
import { PE_V2_SCHEMA, peHashOf, type PeV2 } from '@provian/agent-sdk';

// Hash the complete input before sending to the model
const inputHash = createHash('sha256')
  .update(JSON.stringify({ systemPrompt, userMessage, context }))
  .digest('hex');

// Run inference
const output = await runModel(modelId, { systemPrompt, userMessage, context });

// Hash the output artifact
const outputHash = createHash('sha256')
  .update(output.text)
  .digest('hex');

// Compute the replication pack hash
const packHash = createHash('sha256')
  .update(`${inputHash}${outputHash}${modelId}${Date.now()}`)
  .digest('hex');

const draft: PeV2 = {
  schema: PE_V2_SCHEMA,
  pe_id: `pe_${randomBytes(12).toString('hex')}`,
  device_id: deviceId,
  prev_hash: lastPeHash,   // pe_hash of this device's previous PE, or "genesis" (Section 6)
  timestamp: Date.now(),
  action_type: 'inference_session',   // compute/work family, evidence-priced; kept on the device, its act record rides the body-bound daily batch (Section 2)
  intent_text: `Inference: ${modelId}. Input tokens: ${inputTokens}. Output tokens: ${outputTokens}.`,
  metadata: {
    null_state_flags: ['no_counterparty', 'no_contract', 'no_asset', 'no_amount'],
  },
  compute: {
    duration_ms: inferenceMs,
    tokens_processed: inputTokens + outputTokens,
    energy_joules: gpuWh * 3600,
    hardware_class: 'gpu_inference',
  },
  geo: null,
  execution_env: null,
  parent_goal_pe_id: null,
  replication_pack: {
    input_hash: inputHash,
    output_hash: outputHash,
    model_id: modelId,   // e.g. "meta/llama-3-70b/2024-04"
    model_checkpoint_hash: null,
    pack_hash: packHash,
  },
};
const pe: PeV2 = { ...draft, pe_hash: peHashOf(draft) };
```

> **Note:** `intent_text` is optional. When omitted, the PE's structural fields (`action_type`, `metadata`, `compute` telemetry, `replication_pack`) are sufficient for recording and scoring. It is covered by `pe_hash` and never sent to the relay. Include `intent_text` only if your implementation benefits from human-readable annotations.

---

## 6. Chain Tip Management

The device builds its own chain. Each PE's `prev_hash` is the `pe_hash` of the device's previous PE (`"genesis"` for its first), and each batch carries `seq` (one more than the last accepted batch) and `prev_batch_hash` (that batch's `batch_hash`). Replay validation compares each batch against the device's latest accepted tip and refuses anything that does not extend it: a stale `seq` is `409 batch_replay`, a wrong `prev_batch_hash` is `409 batch_chain_broken`, and an act whose `prev_hash` breaks the PE chain is `409 act_chain_broken`. `batch_replay` and `batch_chain_broken` name `expected_seq`, `expected_prev_batch_hash` and `last_pe_hash`; `act_chain_broken` names the `act_index` and `last_pe_hash`.

`GET /v1/meter/tip` (device auth) returns the device's last accepted `seq`, `batch_hash` and `last_pe_hash`, so a device can resume its chain. Re-send a batch byte for byte until it is answered; rebuild it only after a definitive 4xx. The SDK's `MeterBatcher` does all of this.

---

## 8. Rate Limits

| Scope | Limit |
|-------|-------|
| Batches | No per-user volume cap : repetition is priced by novelty, never refused. A device's batches land at least 5 minutes apart (`429 batch_too_soon`, with `retry_after_ms`) unless it is draining a backlog of full batches |
| Device registration | Max 10 active devices per wallet |

Rate-limited requests (transport-level limits) return `429 Too Many Requests`.

---

## 9. Offline Operation

An offline device keeps building and keeping its PEs and sends them when it reconnects, in batches of up to 500 acts. Each PE carries the time its act happened (`timestamp`); the relay refuses an act more than ten minutes in the future. An act that reaches the relay more than 30 days after it happened is counted in the device owner's totals but does not mint (Genesis grants are exempt).

---

## 10. Minimum Viable Implementation Checklist

If you want to get a device generating PEs as quickly as possible:

- [ ] Register the device: `POST /v1/devices/register` with a one-time token from the app (the emailed setup command IS this call). For an **agent-owned device with no secret to paste**, consume the one-time emailed line instead (see Section 2)
- [ ] Store `PROVIAN_DEVICE_KEY` and `PROVIAN_DEVICE_SECRET` as environment variables
- [ ] Run the SDK observer (installed by `register-device`), or build and keep a PE for each meaningful unit of work your device does (Section 2, "The manual way")
- [ ] Send the act records once a day to `POST /v1/meter/batch` with `DeviceKey` auth and a body binding
- [ ] Keep your PEs: proving an act later needs its PE and its inclusion proof (`GET /v1/meter/proofs`)

The relay handles attestation tier assignment, held acts (an act that waits on evidence or review before it can mint), and PVT accrual; the SDK handles hashing, chaining and batching.

---

## 11. Example: Minimal Node.js PE Agent

The minimal agent is the SDK observer itself. On any machine with Node 20+, register the device and start the observer; its ProcessPlugin builds `compute_session` PEs from CPU activity, keeps them in the local PE store, and sends the daily signed batch:

```bash
npx @provian/agent-sdk register-device          # prints PROVIAN_DEVICE_KEY / PROVIAN_DEVICE_SECRET once
npx @provian/agent-sdk observe --ensure-running  # already running after a full register-device
```

Your own code never posts a PE: the observer's lanes build them, and `MeterBatcher` sends what the PE store holds.

---

## 11b. Observer Plugin Model for Embedded Devices

On a general-purpose computer, the `provian-observer` daemon in `@provian/agent-sdk` handles the gap between discrete trigger events (commits, approvals) and ongoing compute work. It runs as a background service on the host (launchd on macOS, systemd user unit on Linux) and coordinates its built-in plugins, each of which knows how to extract evidence from one domain: process stats, git commits, OTel spans, LLM token logs, filesystem writes.

External devices - robots, sensors, mining rigs, fleet nodes - can adopt the same **plugin model** without running a separate daemon process. Instead of spawning a long-lived child, the firmware/runtime instantiates the observer as an embedded library and registers device-specific plugins (`registerPlugin`) against its `ObserverPlugin` interface.

### How a sensor connects

A sensor, instrument or rig earns through one of two paths. Its own say-so is neither.

1. **A hardware-attested device submits on the sovereign lane.** `POST /v1/pe/submit-sovereign` (SDK `submitHardwareWitnessedWork`) records one occurrence carrying two things. The first is an EIP-191 signature by a registered, active agent wallet's own key over the canonical `provian_sovereign_work_v1` message: the action type, the agent's address, an `occurrence_id` of 8–200 characters, a single-use nonce, and an `iat` within five minutes. The second is a `hardware_witness`: a report from a supported scheme (`tpm2_quote`, `apple_app_attest`, `aws_nitro`, `gcp_confidential_space`, `azure_attestation`, `nvidia_cc`) that a key other than the agent's signed over the hash of this exact body, and that verifies to its scheme's pinned public root. The signature alone is the agent's own claim, and the route refuses it (`403 actor_declared_work_is_not_a_pe`); the SDK helper refuses before it signs when no witness producer is given. The action type is a `compute_or_work` type or one the network has never seen. A verified App Attest report, or a TPM, Nitro, Confidential Space, Azure or NVIDIA report whose launch measurement the relay pins for a signed Provian observer release, seals `hardware_rooted`; any other verified report records at device tier.
2. **A sensor reports through a registered machine whose owner runs an SDK observer with a plugin for it.** The owner runs `ProvianObserver` from `@provian/agent-sdk/observer` in its own process and adds a plugin for the sensor with `registerPlugin`. The observer stamps each reading the plugin hands over (the gateway path, below) and sends it in the machine's body-bound daily batch. [`examples/sensor-gateway`](../examples/sensor-gateway/README.md) is that observer: it watches a directory and turns each JSON reading into one PE.

The daemon the one-command setup installs (`curl … /v1/bootstrap/agent | sh`, `npx @provian/agent-sdk onboard`, or `register-device`) witnesses the machine's own work — its commits, compute, inference and agent tool calls — through its built-in lanes. It loads no sensor plugin: its `--plugins` flag chooses only among those built-in lanes. A sensor on that machine is witnessed by an observer its owner runs beside the daemon with a plugin for it (path 2); the daemon's batcher then sends both.

Three more witnesses reach a sensor's work with no observer plugin and no daemon:

- **A payment for its readings.** When a buyer pays the sensor's owner on Base for its data — a USDC transfer or an x402 payment to the owner's wallet — Provian's chain watchers read the settlement, and that on-chain settlement is the witness, on each side under the chain lane's rules. The owner's `receive` mints only from a counterparty the owner has dealt with — an earlier send or x402 payment to the payer, a shared escrow, or a shared job; a first payment from a stranger records without minting. Nothing is submitted.
- **A counterparty's PE citing its signed output.** The machine that serves the readings signs each one over its hash with its registered key (the `Provian-Output-Signature` header, or `provian_output_signature` in a JSON body). When a buyer's own witnessed PE cites that output as an `out:` input origin, the relay verifies the signature against the registered key and counts the citation toward the owner's Consumption — who independently built on its outputs, a fact the owner can present. The citing act must itself be witnessed, and a citation pays nothing.
- **A hardware root on the sensor itself.** This one is not a separate route: the sensor's attested report reaches the relay through the sovereign lane, path 1.

**What the relay does with a never-seen type**, on either path: it records the act with no mint, files it in the public review queue under the lane it came in on (`GET /v1/pe/earning-proposals`, [provian.ai/proposals](https://provian.ai/proposals)), and alerts the operator. The type earns from the day its policy row is signed and the type is granted for that lane, once per witnessed act; acts sealed before then stay records. A named type is refused on both paths (its witness is someone else's), and so is a type in a namespace the relay names for its own lanes (`service:`, `git_`).

**The gateway path.** An observer plugin is how a new type of work records on the device batch: a sensor, instrument or rig attached to a registered machine is witnessed by a plugin in an observer its owner runs on that machine. The plugin reads the device's readings and returns each from `drainPEs` as a `PluginPE` of the type you choose, with the reading's digest in `output_digests`. On every PE a plugin drains, the observer — not the plugin — stamps `metadata.source: "observer_plugin"` and `metadata.observer_plugin: <plugin.name>`, overwriting anything the plugin set there. Only the daemon's own lanes carry their lane markers: the observer refuses a `link_spend` or `agent_tool_orchestration` from a plugin, and the relay refuses a plugin-marked act that carries either type, a lane's `source` or a lane's `tool`. The act rides the device's body-bound daily batch (`POST /v1/meter/batch`) at device tier (`hardware_rooted` when the observer runs as a measured release; see the Provian Manual §4.3 and the PE Protocol Spec §5). A type the network has never seen records with no mint and enters the public review queue; it earns from the day its policy row is signed and the type is granted for this lane, and you are notified when it does. A named type keeps its own witness and is refused on this path, as is an act of a new type that arrives without the marker. Section 4 shows a plugin that emits rig events.

```typescript
import {
  ProvianObserver,
  ProcessPlugin,          // can be swapped for a hardware-stat plugin
  type ObserverPlugin,
} from '@provian/agent-sdk/observer';

class HardwareWatchdogPlugin implements ObserverPlugin {
  readonly name = 'hw-watchdog';
  async init(obs) { this.obs = obs; /* subscribe to SoC telemetry */ }
  async start() { /* begin sampling */ }
  async stop() { /* cleanup */ }
  tick(session) {
    // Contribute CPU load, temperature, fault counts into session telemetry
    return { sessionData: { temp_c: readTempSensor() } };
  }
}
```

The `ProcessPlugin` shipped in the SDK maps one-to-one to classic **hardware watchdog** patterns used in embedded systems: a periodic tick, a health threshold, and a state machine that fires on boundary events. Replace its OS-level sampling with reads from your device's watchdog/telemetry registers, and the rest of the pipeline - `SessionManager`, `DeduplicationRegistry`, the PE store and the observer's body-bound daily batch - continues to work unchanged.

For constrained devices without Node, port only the three core pieces:

1. **SessionManager** - idle/active state detection from whatever signal is native (duty cycle, job queue depth, sensor activity).
2. **DeduplicationRegistry** - a fixed-capacity ring buffer of claimed `[start, end]` windows, pruned on a timer.
3. **PE meter** - one v2 PE per session end with `action_type: "compute_session"` (or `inference_session` when inference was witnessed; a type outside the observation lanes records only through the gateway path above,) and populated `compute` telemetry, kept on the device; once a day its act record goes to `POST /v1/meter/batch` with a body binding (Section 2, "The manual way").

The PE schema is the contract. The observer architecture is one reference implementation.

---

## 12. Next Steps

- Read the [PE Protocol Specification](./PE_PROTOCOL_SPEC.md) for the complete field reference
- Read the [Agent API docs](./AGENT_API.md) if your device is also acting as a wallet-connected agent
- Merchants verify a wallet's presented facts through burn-to-present (`/v1/present/jwks` + `/v1/present/verify`) — no merchant-side SDK or attestation ride-along exists.
- Install `@provian/agent-sdk` if you want the full SDK rather than raw HTTP calls

**Compute mints money. No one gets left behind.**

### Email language

User-facing invitation and setup emails support `en`, `es`, `fr`, `hi`, `id`, `ja`, `ko`, `pt`, `sw`, `tl`, `vi`, and `zh`. The optional `language` field selects the recipient’s email language; missing or unsupported values render English. Agents choose it explicitly; the relay does not infer the recipient’s app preference. Commands, one-time tokens, links and addresses are unchanged, and invitation unsubscribe links work in every language. Internal operational email remains English.

- API: `POST /v1/agent/wallet/:wallet_id/invite` with `{ email, language? }`; `.../invite-human` with `{ human_email, message?, language? }`; `.../device-invite` with `{ email, device_name?, message?, language? }`. All require the agent’s API credentials and wallet ownership.
- TypeScript SDK: `CommonsInstitutions.invite({ email, language })`, `inviteHuman({ humanEmail, message, language })`, `inviteDevice({ email, deviceName, message, language })`.
- MCP: `invite`, `invite_human`, `invite_device` take `wallet_id`, the endpoint’s email field and optional `language`.
- CLI: `provian invite|invite-human|invite-device --email <address> --language <code>`; SDK’s existing `invite-device` command also accepts `--language`.
- App: personal and agent-computer setup requests carry the current app `language` automatically.
