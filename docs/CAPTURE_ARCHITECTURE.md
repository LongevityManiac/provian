# Unified Capture Architecture

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

**Status:** Implemented. Phase 2b (desktop) and Phase 2c (mobile Chat) have shipped. Witness 3 has shipped three Tier A forge connectors, and **all three are LIVE** (relay ingest + `installs` registration with per-install webhook secrets minted at connect time since B2/; app-wide secrets mounted 2026-08-11/ survive as the config gate, legacy grandfather, and operator-diagnostic path; GitLab verifies `X-Gitlab-Token`, Bitbucket an HMAC body signature). The **GitHub App connector went live 2026-08-12 ** the App `provian-git-witness` (App ID 4570525) is registered, the app-wide `GITHUB_APP_WEBHOOK_SECRET` is mounted, and it is proven end-to-end (a real push produced witness PE `pe_a964f8fb` at `verified:true`). Relay ingest shipped in PRs #54-#56, `connect-github` CLI in the agent SDK, `provian connect github` in the CLI, mobile setup path on the Earn tab (route `AgentsTab`) connect screen. Connectors beyond these remain future work (see §below).
**Location in repo:** `docs/CAPTURE_ARCHITECTURE.md`
**Related workstreams:** Phase 2b (desktop LLM session plugin, shipped), Phase 2c (mobile Provian app, shipped), Phase 2d (narrative and documentation).

## 1. Purpose

The current capture architecture assumes work produces artifacts the daemon can observe: git commits, files on disk, OTel spans from agent frameworks. That model captures developers and agent operators well. It does not capture the population the human-abundance thesis is actually about.

A tour guide in Morocco asks his phone how to make money with his skills, and the phone answers. A nurse in the Philippines uses an AI assistant to draft patient summaries. A small business owner in Lagos uses AI to negotiate supplier terms. A researcher in Brazil uses AI to plan a field trip. None of these produce a commit, a file, or an OTel span. All of them are doing real economic work with AI assistance. All of them must generate PEs, or Provian's vision is structurally closed to the people it exists to serve.

This document specifies the capture architecture that closes that gap across three surfaces: the existing desktop observer daemon (extended with a new plugin), a new mobile Provian app (extended with a WebView wrapper), and a unified PE shape for conversational work that applies identically on both.

It also specifies the capture architecture for a third case: work that ran where Provian cannot directly observe it but landed in a service the user has connected, which pushes a signed event the relay verifies. A user-installed GitHub App webhook is the reference example. This third case corresponds to Witness 3 in the three-witness framing - see [docs/PE_GENERATION_MODEL.md](./PE_GENERATION_MODEL.md). The desktop and mobile surfaces above correspond to Witness 1 (device-attested local capture). Witness 2 (acts through Provian that the relay, the chain, or a hardware witness vouches for) is governed by `docs/PE_GENERATION_MODEL.md` and is out of scope for this document.

The animating principle: if a human or an agent does real work with AI - whether the daemon sees it on a registered device, the mobile wrapper captures it, or a connected service pushes a signed event about it - a PE fires. Surface-agnostic, artifact-agnostic, content-free. The protocol observes that meaningful work happened; the capture code reads message length to produce counts but never stores or transmits message text, and it does not read what was committed.

## 2. Design principles

**Passive.** No user action per session. Install once, then every session is observed. No share-sheet taps, no export prompts, no manual logging.

**Content-free.** Metadata only. No message text, no conversation content, no transcripts leave the device. The PE proves that work happened, at what scale, and with what provider; it does not expose what the work was about.

**Attestation-tiered signing.** PEs are signed by the strongest available witness path: mobile hardware trust anchors where supported, desktop secure-element or TPM signing where available, and software signing as the fallback. The attestation tier flows from verified evidence, not from a raw hardware claim. Only a verified App Attest assertion, or a verified TPM, cloud or NVIDIA attestation whose launch measurement the relay pins for a signed observer release, supplies the hardware-rooted price. Other TPM, cloud and NVIDIA attestations and desktop secure-element signing remain verified presentation facts at the lane's normal price. New registration tiers and attestation factors follow the same rule; historical sealed rows retain their original values.

**Unified shape.** Desktop and mobile emit the same action type with the same metadata schema. Backend does not distinguish surface at ingest; the `surface` field on the PE identifies the capture origin.

**Extensible.** New AI clients and new providers are additive via a config catalog. The capture mechanism is parameterized on provider detection, not hardcoded.

**Kept by the owner.** Every surface keeps the PEs it builds: the observer daemon in its local PE store, the phone on the device and backed up encrypted to the owner's own iCloud or Google Drive. Each surface sends the relay one signed, hash-chained batch a day of act records (identity, `pe_hash` over the complete PE, pricing inputs; never free text), plus one right before any presentation or payout: `POST /v1/meter/batch` (device key, body-bound) or `POST /v1/meter/batch/mobile` (wallet auth). The relay prices the acts and keeps no PE.

## 3. Scope

### In scope for the initial Witness 1 capture bundle (2b, 2c, 2d)

- New plugin on the desktop observer daemon for LLM session capture via foreground-app detection.
- New WebView wrapper section inside the Provian mobile app, covering six AI providers.
- New `ai_conversation` action type in the PE protocol spec.
- Backend ingest path for the new action type.
- Narrative and documentation updates across NETWORK_CONSTITUTION, DEVELOPER_SETUP, PE_PROTOCOL_SPEC, AGENT_ECONOMY, new FAQ, website copy, privacy policy, consent flows.

### Agent tool-call witnessing

Each program is witnessed by exactly one lane: its session files if it keeps them, otherwise the proxy, otherwise OTel, otherwise — for a program that runs on its own machine with none of those — the process lane, which reads the commands it runs straight from the operating system and is inert on any device whose agent has another lane. Switching sign-in, model or provider never changes the lane. Harness-stored data can never cause a second mint. Each model response that calls a tool mints exactly once, and each command the agent's recorded launcher starts with its recorded wrapper mints exactly once; a launcher that hands each command to its child itself mints nothing.

The agent finds where its own program stores sessions and describes the actual record format. A program writing session files uses those described files for every model, provider and sign-in; setup does not repoint its model base URL. A program writing no session files uses the local model proxy. OTel witnesses only a program neither covers. A program on its own machine that none of these covers is witnessed by the process lane, which needs no description, only a launcher record (below). Switching from an API key to ChatGPT sign-in requires no setup change for a session-file program.

Run `provian witness instructions`, inspect real complete model responses, their tool calls (including errored calls), and results, then write a local JSON description using `provian witness schema` as the field guide. Run `provian witness configure --description <local-json-file>`. The daemon accepts a session description only after reading real records into tool-calling model responses. The description, source cursors and open turns stay on that machine; there is no harness catalog or per-harness Provian configuration.

Descriptions name the program's process names (and script/package paths for shared runtimes), the absolute session root, filenames or suffix, depth and record timestamp. Record rules use dot paths (`*` walks arrays), predicates and the kinds `model_response`, `tool_call`, `tool_result`, `turn_end`, `ignore`. Every record in the store must match at least one rule, with kind `ignore` for records that are none of the others; `witness configure` checks the records the observer will read (the most recent session, or everything after the point where the observer stopped) and refuses a description that leaves one unplaced, naming the first one and why. SQLite descriptions also name the table and JSON, sequence, session and creation-time columns. The reader opens stores read-only. Describe `responseId` and `responseParts` so every response component is covered; use `atomicResponses:false` with a completion rule only for fragmented responses. Existing records validate the format; capture starts prospectively. Setup completes only after the chosen lane witnesses one NEW real tool-calling model response, which mints normally. Run a real tool and check `provian witness status` for `setup_complete:true`.

For a program without session files, configure its process identity with lane `model_proxy`, then point that program alone at `http://127.0.0.1:4320/openai` (or `/anthropic`, `/xai`, `/gemini`). The proxy forwards model traffic and keeps its own durable turn record. For a program neither lane covers, configure lane `otel` and set its OTLP endpoint to `http://127.0.0.1:4318`. Both listeners reject browser-origin requests and non-loopback hosts. No other lane mints that program's turns.

**The process lane.** An agent that runs on its own cloud VM, such as a Grok Bot, keeps no session files Provian can read, routes its model calls through no Provian proxy, and emits no OTel; the three described lanes see nothing of it. The process lane witnesses what such an agent actually does on its box: it reads the OS process table directly (Linux `/proc`, where it reads the launcher's children every 20 ms; macOS `ps`) and seals **one `agent_tool_orchestration` PE per command the agent launches**, with every child process that command starts, the destinations observed in its command line, and a coarse bytes-written signal folded into the one act (a build that spawns fifty processes is one PE). It needs no description and names no agent, framework or runtime (Linux and macOS; Windows is out of scope), and the agent cannot opt a command out. It captures continuously on a tight poll rather than a coarse sampler.

**The launcher.** The lane mints only commands started by the agent's recorded **launcher** the long-running harness process whose children are the agent's commands — with the recorded **wrapper** those commands start with. Both are observed on the device, never declared: a command the agent itself runs through its harness — the install line, `provian doctor`, an act verb, or `provian process-lane record` walks its own process ancestry past Provian's own processes, shells and shell helpers to the first other program, the launcher, and records it as hashes only in `~/.provian/process-launcher.json`. A person's terminal (sshd, login, a terminal app, tmux or screen, an IDE's terminal host) is never a launcher. The launcher's child on that walk decides the mode. In **`template`** mode it is a fixed wrapper started for each command that carries nothing of the command itself (a hosted sandbox's `bash … -c '<fixed script>'`): a launcher child that starts the same way is one of the agent's commands, and any other start is the harness's own check. In **`direct`** mode the command reaches the launcher's child itself — embedded in its command line (`sh -c "<cmd>"`), exec'd into it, or run from a long-lived shell — so the harness's own programs look exactly like the agent's commands and a long-lived shell starts one child per pipeline step; the lane records the shape, **mints nothing**, and capture health reports it (below). With no launcher recorded the lane mints nothing either. Any later `provian` command the agent runs through the installed wrapper fills a missing record, and, while the lane reports it is not recognising the agent's commands, rewrites the record when its walk reaches a launcher with the recorded fingerprint, so a harness that changed its wrapper is witnessed again with no one asked to do anything.

It mints **only the agent's own commands**: never the daemon's own process tree, never a process already running when the lane started (the OS and the agent runtime are baseline), never another user's programs, the operating system's or the platform's background jobs, or the harness's own checks, nothing at all on a device whose agent has another lane (the lane is then inert), and never the VM runtime's background services (a tree that never completes, or an identity a supervisor relaunches after it exits). Mint-once is the daemon's **own durable ledger** (`~/.provian/process-lane-ledger.json`), never anything the agent or its runtime stores, so a daemon restart, a re-read, a VM replacement or a self-update mints nothing twice; because the ledger and the daemon live in the home directory, they return after a VM is replaced with no human action, and the agent's setup instructions tell it to arrange that restore. Privacy is **structure-only**: command lines, arguments, paths and environments are hashed on the device; their contents and file contents never leave it in plaintext (the privacy sentinel proof). Destinations the daemon observes in a command line — including real destinations visible there on a VM whose egress runs through a proxy — become `input_origins` under the existing rule (a public domain recorded resolvably, a private identifier hashed and counted zero), so a process-lane PE prices at parity with every other agent tool act: same action base, same independence multiplier, same factors. It runs on agent devices only; a human device never records its owner's commands. `compute_session` records are unchanged (a session with no witnessed output still seals `skipped_no_output` and mints nothing).

One model response calling one or more tools produces one `agent_tool_orchestration` PE, including errored calls. A user task or OTel trace can contain several such responses. A model response with no tool call produces none; API transport does not mint a second PE. Durable cursors, open turns, pending PEs and the owner's mint-once store survive daemon restarts. The owner keeps the complete PE locally or in owner-encrypted copies. Private-capable act data is encrypted before commitment and hardware binding using the existing device-held credential; request-time opening preserves exact pricing. Hidden owner openings prevent guesses against commitments. The relay retains private identifiers and historical commitments only encrypted under its existing secret, with secret physical storage aliases; logical claims, proofs and sealed amounts stay exact.

Keep the observer running. There is nothing to schedule. When the observer needs something from the agent, it writes `~/.provian/witness-action-required.json` (an `instruction`, or a non-empty `programs` list). The Provian startup hook, a managed block at the top of `~/.bashrc`, `~/.profile` and `~/.zshenv` on macOS and Linux, prints that notice before the agent's next command runs, so the agent reads it in that command's output. It prints to stderr, never stdout, because a startup file runs in every shell, including ones whose stdout is data (`ssh host 'cat f' > f`, a stdio server started through `zsh -c`). It prints once for each new notice and again every 30 minutes while it waits, and nothing in between, so tools that treat any stderr as failure are disturbed at most that often. A shell running sftp, scp, rsync or git over ssh prints nothing. With no notice the block costs one file test. Every `provian` command's JSON output also carries the notice as `witness_action_required` (and waiting mail as `commons_mail`), which covers a shell that reads no startup file. No cron entry, timer, harness wake or recurring model turn checks for Provian work, and an agent that added one removes it. A Grok Bot computer, which has no cron or systemd, works the same way. `PROVIAN_RESTART_HOOK=0` stops the startup-file edits; the notice then arrives on the agent's next `provian` command. If files keep producing records but tool calls are no longer recognized, capture-health raises `session_format_broken` and the notice tells the agent to inspect the changed real records and re-describe the same program. Refreshing a description keeps its lane and original setup watermark. Commons mail reaches the agent the same way: while the mailbox's `unread` array is non-empty, the notice and every `provian` command name it, and the agent runs `"$HOME/.provian/bin/provian" threads --unread`, which prints each unread thread message decrypted with the agent's key and marks it read (through the MCP server the check is `read_threads` with `unread: true`), and it acts on every message shown, answering in the thread with `"$HOME/.provian/bin/provian" thread-send --thread <id> --text "…"` when a message calls for a reply. Each read also carries the owner's reply policy, which the agent follows: under "answer anyone" (the default) it replies to every message; under "ask me first", which the linked human sets on the agent's page in the app, it replies directly only to its linked human and, for anyone else, leaves that thread unread and first asks the human about its newest message with `"$HOME/.provian/bin/provian" request-approval --for <pe_id> --description "…"` (MCP `request_human_approval` with `subject_pe_id`; the sender's name and a summary, never the message text). Each later read reports the thread's `next_step` (`ask_first`, `waiting_for_approval`, `approved_reply_now` or `do_not_reply`), so an agent that keeps no memory between turns replies once the request is approved and closes the thread without replying if it is rejected or lapses. Standard onboarding (the install line, `start`, `register-device`, `witness instructions` and the MCP server's instructions) tells every agent there is nothing to schedule; for an agent onboarded before that, the daemon writes the same message into `~/.provian/witness-action-required.json` until the agent has run `threads --unread` on that machine (or mail the daemon delivered there is read on the relay), and while mail waits that file also names how many messages and from whom. Only the daemon writes that file. That file holds one instruction at a time, so a capture fix another lane left there comes first.

The process lane reports through the same capture health with four launcher codes:

- `process_launcher_changed` — the harness changed how it starts the agent's commands and nothing re-recorded the wrapper once the agent's own commands had their chance (after the suspicion was raised, six more of its commands ran the new way, each followed at once by the harness's own check), or the harness has run only inside one of the agent's own commands for thirty seconds. Until then a changed start is an unshown suspicion that any `provian` command under the recorded launcher heals; an idle harness's own unlearned check never raises it.
- `process_launcher_not_seen` — no running program has matched the recorded launcher for ten minutes.
- `process_no_launcher` — the process lane is the agent's witness and no usable launcher is recorded (a machine a person set up from the emailed line, an install whose own record failed, or a record from an older version). An agent that session files, the proxy or OTel witness never raises it.
- `process_launcher_unsupported` — the recorded launcher is in `direct` mode, so the lane mints nothing on that machine.

For the first three the daemon writes the fix into `~/.provian/witness-action-required.json`: run `"$HOME/.provian/bin/provian" process-lane record` from the agent's own harness, as an ordinary command. A flag stands across a daemon restart until its own evidence clears it. Separately, `process_lane_silence` reports a launcher that is running matching commands while none of them seals.

Tool-call capture is agent-only. Human devices run no transcript, proxy, OTel or process-lane tool witness, and installers do not repoint their model endpoints. Humans keep their existing commit and desktop-chat witnesses. An agent that lives on its own cloud computer, such as a Grok Bot, is witnessed there by the process lane (above): each command its recorded launcher starts with the recorded wrapper mints once, and a harness that hands each command to its child itself mints nothing. Work that runs on its maker's servers rather than on its computer (its reasoning, web searches, connectors) is not witnessed there; its commits (through a connected code host), Commons acts and on-chain acts earn on their own witnesses.

The signed daemon release channel remains at `GET /v1/catalog/release`, using its existing pinned key. No new signing key is needed. A new bundle runs only when its hash matches the signed release manifest.

PEs prove provenance: a PE exists only when something other than the actor vouches for it — the
device observing the work, a counterparty, a forge, or the chain. An agent's own claim about its
work is never a PE, at any tier, minting or record-only. So:

- There is no loopback witness endpoint. The former `127.0.0.1:4319` endpoint and its
  self-reporting block are gone; an updated daemon prunes their `PROVIAN_WITNESS_*` settings from
  `~/.provian/runtime.env`, and removes exactly the "# Provian PE Reporting" section an older
  `register-device` wrote into `~/.claude/CLAUDE.md`, `.cursorrules` or `.windsurfrules` (home, the
  working directory, `PROVIAN_GIT_REPOS`; an edited section or any other file is never touched).
  `register-device` writes no such section and submits no self-test PE.
- The device batch (`POST /v1/meter/batch`) admits the action types the observation lanes emit
  (`core/provenance/device-observation-types.ts`: `compute_session`, `inference_session`,
  `coding_session`, `agent_tool_orchestration`, `agent_api_orchestration`, `ai_conversation`, and a
  `link_spend` the transcript lane observed), and — the gateway path — a never-seen type an observer
  plugin witnessed, which the observer stamps `metadata.source: "observer_plugin"` +
  `metadata.observer_plugin` (recorded at device tier with no mint until its row is signed and the
  type is granted for this lane). That plugin runs in an observer the machine's owner embeds
  (`ProvianObserver` + `registerPlugin`, as in `examples/sensor-gateway`); the daemon itself runs
  only its built-in lanes and loads no sensor plugin. A sensor whose own hardware attests submits
  on the sovereign lane instead (below). The batch
  refuses any other type, a named type outside the observation lanes even with that marker, an act labelled `local_witness` or
  `mcp_self_report`, and every act in a batch the device did not bind (unless a hardware witness is
  admitted), naming the reason in the batch receipt (`actor_declared:…`).
- An `agent_tool_orchestration` act is admitted only when its `metadata.source` and
  `metadata.tool` name one of the daemon's four lanes (`transcript` / `provian:transcript`,
  `otel` / `provian-observer-otel`, `model_proxy` / `provian:model_proxy`, `process` /
  `provian:process`). Anything else that
  holds the device credential and records a tool call into the device's store is refused
  `tool_orchestration_not_daemon_lane`, so a program's tool calls mint only from its one lane.
- `/v1/pe/submit-sovereign` records only a body a non-actor hardware witness verifies over (a
  `compute_or_work` type or a never-seen type, signed by a registered agent wallet's own key). The
  single-PE recorders `/v1/pe/submit`, `/v1/relay/action` and `/v1/relay/work-product` answer
  `410 pe_recorder_retired`.
- The MCP report tools (`submit_pe`, `submit_sovereign_work`), the SDK's `reportAction` /
  `reportWorkProduct` / `submitSovereignWork` / `recordLinkSpend` / `recordX402PaymentPE`, the CLI's
  and `provian report` are removed. `report-pe` runs only as the
  post-commit hook, reading the commit from git itself.

A refusal writes nothing (the sovereign route answers `403 actor_declared_work_is_not_a_pe`). Already-sealed
PEs are untouched.

### In scope for the initial Witness 3 capture bundle (GitHub reference connector shipped)

Witness 3 is the relay-witnessed external event front: work that ran where Provian cannot observe it but landed in a service the user has connected, which pushes a signed event the relay verifies. This bundle defines scope at the **custody-tier level**, not the provider level. Custody, not provider list, is the load-bearing architectural decision for Witness 3.

**Tier A - push-with-signature, no stored readable credential.** A connected service pushes a signed event to the Provian relay. The relay verifies each delivery using whatever per-delivery mechanism the service provides — an HMAC body signature (GitHub `X-Hub-Signature-256`, Bitbucket `X-Hub-Signature`) or a constant-time shared-secret-token compare (GitLab `X-Gitlab-Token`) — against, for GitLab/Bitbucket, the install's OWN per-install secret minted at connect time (disclosed once at registration; the app-wide secret serves only configuration, legacy-row compatibility and operator diagnostics), and for GitHub the App-wide secret model. Provian stores only install references and verify secrets scoped to webhook verification in Firestore - **never a token capable of reading the user's account on that service**. Compromise of the relay's Firestore storage cannot exfiltrate user data from the connected service. Connected services use this push-with-signature custody model. **All three Tier A connectors are LIVE** GitLab and Bitbucket with per-install secrets, and GitHub through App `provian-git-witness` and its app-wide `GITHUB_APP_WEBHOOK_SECRET`. Tier A providers are added by extension, never by relaxing the no-stored-credential custody rule.

**User authorization for Tier A connectors happens on the service's own domain.** A deep link from the mobile wallet or a CLI command (e.g. `provian connect github`) opens the service's install page (e.g. `https://github.com/apps/provian-git-witness/installations/new`) and receives the install callback. Provian never accepts the user's service credentials directly, never creates accounts on the user's behalf, and never receives a token capable of reading the connected account.

### Capture boundaries

Connected forges push signed events. Human desktop capture observes supported foreground AI sessions on macOS and Windows; in-app mobile capture observes the Chat tab with consent. Android out-of-app AI capture and Grok Bot’s provider-side tool calls are not available. Content remains with its owner; a supported local observer, forge, counterparty, chain or admitted hardware witness supplies proof.

## 4. The unified PE shape

New permissionless action type: `ai_conversation`.

> **The canonical PE shape is machine-readable.** Every PE field with its assignment and privacy
> rule, `output_digests`, the `input_origins` classes, the witness/evidence classes, and the
> optional `hardware_witness` slot described below all live in the one versioned PE schema,
> generated from the relay's own types and served at `GET /v1/schema/pe` (also shipped as
> `@provian/agent-sdk/schema/pe`, kept in step by the `schema:check` drift gate). The
> `ai_conversation` metadata block below is this surface's own type-specific detail.

Metadata schema:

```
{
  "provider": "claude | chatgpt | gemini | perplexity | grok | venice",
  "surface": "desktop_foreground | mobile_wrapper",
  "duration_ms": number,
  "active_duration_ms": number,
  "turn_count": number,
  "char_count": number,
  "image_count": number,
  "video_seconds": number,
  "session_fingerprint_hash": string,
  "input_fidelity": "full | presence_only"
}
```

Android out-of-app AI capture (the `mobile_usage_stats` surface) is not live (Provian, 2026-09-25,): the app does not run it, the phone's batch route (`POST /v1/meter/batch/mobile`) refuses the surface, and no PE carrying it mints on any route.

`input_fidelity` indicates whether the capture surface observed real input events (`full`) or whether permission was denied or the surface cannot observe input (`presence_only`). Relay weight multipliers can calibrate against this field. When `presence_only`, `turn_count` is 0 and `active_duration_ms` equals `duration_ms` by construction.

Content constraints:

- No message text anywhere.
- Session identifiers and locally computed fingerprints leave the device only inside its secret-protected transport.
- No identifying information about the conversation topic.

Desktop foreground capture fills `char_count`, `image_count`, `video_seconds` with zero (content is not visible to the plugin). Mobile wrapper capture fills them with real values from the MutationObserver.

Category classification is not a pricing input.

Dedup: `session_fingerprint_hash` is the primary dedup key. It is the session's canonical event and mint-once anchor: a second act with the same fingerprint in one batch records but mints nothing; across batches, the device's hash-chained, sequenced batches stop a replay.

Attestation flows from verified evidence. Verified App Attest supplies the hardware-rooted 4.0× class, and so does a verified TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed Provian observer release (the measured observer, 2026-10-10: the platform produces the measurement when the program starts, so the operator cannot choose it; the pins come only from the signed release channel). Any other verified hardware report remains a presentation fact at the normal lane price; desktop Secure Enclave signing is a verified fact at the normal lane price. Software `ai_conversation` capture retains its 0.8× evidence factor and the unchanged novelty rule; non-hardware replication and corroboration factors remain unchanged.

**The hardware witness slot (, Trust Layer §2.9).** Every lane — the device batch `/v1/meter/batch`, the phone's batch `/v1/meter/batch/mobile`, and the sovereign route — carries ONE optional `hardware_witness` slot per PE: a report that a NON-actor key signed over the **binding nonce** = for a meter act, sha256 of the canonical JSON of the act's identity and pricing inputs minus the slot (sorted keys, no whitespace; byte-identical canonicalizer on relay, SDK and app). The relay admits it when (a) the report's nonce equals that recomputed nonce, (b) the signing chain terminates at the SCHEME's pinned public root, and (c) the signer is not one of the actor's registered keys. An admitted `apple_app_attest` report, or an admitted `tpm2_quote` / `aws_nitro` / `gcp_confidential_space` / `azure_attestation` / `nvidia_cc` report whose launch measurement the relay pins for a signed observer release, supplies `witness_class: hardware_rooted`, pricing at 4.0×. Every other admitted report records verified facts and retains the lane's normal price. A bare attested machine submission mints at `device_tier`. Schemes and their roots: `tpm2_quote` (Google Cloud EK/AK CA Root — Compute Engine Confidential VMs; proven live), `apple_app_attest` (Apple App Attestation Root CA; attest-once `POST /v1/wallet/app-attest/register`, then an assertion per PE whose counter must advance — the iPhone's Secure Enclave as witness), `aws_nitro` (AWS Nitro Root-G1), `gcp_confidential_space` (Google-signed launcher token, `eat_nonce`), `azure_attestation` (`*.attest.azure.net`), `nvidia_cc` (NVIDIA Device Identity CA; proven against NVIDIA's published sample, no live GPU). Admission is "did a non-actor key sign THIS body, and does it chain to a public root pinned per SCHEME" never a manufacturer or device catalog. A present-but-unverifiable report is **recorded** (metadata-only digests + reason under `metadata.hardware_witness`) at the lane's ordinary class, never dropped and never lifted. Producers: the SDK's `tpm2QuoteProvider` / `gcpConfidentialSpaceProvider` (observer `hardwareWitness: 'auto'` picks by what the host has) and the app's `AppAttest` module.

Desktop Secure Enclave signing, Android StrongBox, and TPM, cloud and NVIDIA evidence without a pinned observer measurement cannot supply a hardware price factor. Registration tiers and all hardware factors follow the same rule. An unverifiable report records its digest and reason without a lift. Prior sealed PEs retain their original amounts.

These attestation multipliers are independent of the 2.0x human-trust factor,
which requires verified human/beneficiary linkage. Hardware or device status
does not create that linkage. Agent-owned devices remain `software` at the
base tier regardless of signing method.

Pricing uses the signed action row or witness-class base, novelty, verified linkage, attestation and independent origins. Durations, turn counts and content counts are telemetry rather than direct price factors. Token counts never affect price.

### Witness 3 companion shape: external-service events (GitHub reference shipped)

Witness 3 PEs use a separate, namespaced action type per service event, **not** the `ai_conversation` type. The GitHub connector emits `service:github_commit` for a push and `service:github_pr_merged` for a merged pull request, each carrying its own metadata block; every other HMAC-verified GitHub event that names a repository and a sender (never `ping`) becomes a generic `service:github_<event>` (an issue, a release, a review…) with structure-only metadata (`event_type`, `action`, `repo`, `sender_login`, `subject` — the subject's opaque GitHub id — and `synthesized_description`; never a title, body, comment or diff). A commit-less push or an unmerged pull request is dropped, never relabelled as a generic event. The `ai_conversation` metadata schema and its `surface` enum (`desktop_foreground | mobile_wrapper`) are **not** extended for Witness 3 - that enum stays scoped to AI-conversation capture and does not grow to cover external events.

Metadata shape (`provian-backend/src/core/witnesses/github-webhook.ts`; a push shown):

```
{
  "action_type": "service:github_commit",
  "attestation_type": "software",
  "metadata": {
    "commit_sha": "abc123...",
    "repo": "owner/repo",
    "branch": "main",
    "commits_in_push": 2,
    "files_added": 1,
    "files_removed": 0,
    "files_modified": 3,
    "files_changed": 4,
    "synthesized_description": "push abc1234 to owner/repo/main: 2 commit(s) across 4 files",
    "verified": true,
    "delivery_id": "<X-GitHub-Delivery header>",
    "installation_id": "<GitHub App installation id>",
    "witness": "github_webhook",
    "attribution": { "mode": "verified_author_mapping", "provider": "github", ... }
  }
}
```

`service:github_pr_merged` carries `commit_sha` (the merge commit), `repo`, `branch` (the base branch), `pr_number`, `additions`, `deletions`, `files_changed` and `synthesized_description` in place of the push counts, with the same `verified` / `delivery_id` / `installation_id` / `witness` / `attribution` fields. `witness: "github_webhook"` names the witness on every GitHub PE, and the relay assigns the PE the `forge_witnessed` witness class; neither is a root PE field, and the `ai_conversation` `surface` enum is not extended to include external-event values. The PE is recorded to the wallet that `attribution` names: the commit's git author (the sender, for a generic event), resolved through a verified author mapping, which on a personal install includes the repository owner's own account, mapped from the signed payload. An event whose author maps to no one is acknowledged and no PE is recorded for it; a commit event still corroborates the install owner's own PE for that commit.

**Description handling.** The receiver synthesizes a deterministic structural description from the webhook payload at receive time (synthesize-or-omit). No generic placeholder string. If the payload is missing the fields needed to synthesize a real description, the PE is dropped rather than submitted with a placeholder.

**Attestation tier for Witness 3.** Witness 3 PEs enter the existing attestation pipeline as `software` by construction: no device key exists on the webhook path — and carry the relay-assigned witness class `forge_witnessed`. Under evidence pricing (the named `service:*` rows are evidence-priced) a software-tier witness earns the family discount — 3.0× weight × 0.8× software = **2.4×**, not a terminal zero (novelty decay prices repetition down toward the 0.3× floor). A generic `service:github_<event>` has no named row: it records as `forge_witnessed` with no mint, enters the public review queue (provian.ai/proposals), and earns from the day a signed row names it. The webhook proves the push is authentic (a server-verified binding → `eligible`); chain-verified cross-witness corroboration is a *lift* that raises the row to the family's flat 1.0× (the full 3.0×), emitted and recorded per Security Invariant #8. **No new attestation tier is introduced.** See [docs/PE_PROTOCOL_SPEC.md](./PE_PROTOCOL_SPEC.md) §5 for the canonical tier tables (standard + evidence-priced).

**Dedup.** Two distinct mechanisms.

*Same-witness delivery dedup.* Per `(user_id, provider, delivery_id)` — the install owner, the forge, and the service's per-delivery id (GitHub `X-GitHub-Delivery`, GitLab `X-Gitlab-Event-UUID`, Bitbucket `X-Request-UUID`) — the relay drops duplicate webhook deliveries from the same service before it synthesizes anything (`witness_webhook_deliveries`, kept 90 days) - services routinely retry. A generic GitHub event's mint-once anchor is its own GitHub identity (repository, event, subject and action), never the delivery id.

*Cross-witness mint-once.* A registered device's daemon (`coding_session`) and a
forge webhook (`service:github_commit`, `service:gitlab_push`) can witness the
same commit. The atomic per-`(user, commit_sha)` claim in `commit_mint_claims`
belongs to the first witness that seals mintable (`commit-mint-claim.ts`). A
terminal-zero witness cannot consume it: claim commit waits for the sealed
disposition, and a terminal-zero owner releases it. A named software-tier
webhook earns its 2.4× price and can therefore be that first mintable witness.

Every later witness records its PE for chain integrity and emits its valid
corroboration signal to improve the first PE. It seals
`mint_status='corroborated_duplicate'` (or `ineligible_terminal` for an exact
duplicate), without a second mint. Corroboration is never suppressed, and the
arrival order cannot produce two mints for one commit.

## 5. Desktop LLM session capture

**New plugin:** `provian-agent-sdk/src/observer/plugins/llm-session/LLMSessionPlugin.ts`

Follows the existing `ObserverPlugin` interface. **Human devices only:** it is part of the Desktop daemon on a person's own computer, never the agent path — agent installs never start it and an agent device's daemon drops it (`resolveActivePlugins`), because on an agent's machine foreground screen time belongs to a human or a computer-use agent, not the agent. Installed automatically by the SDK's `register-device` (`npx @provian/agent-sdk register-device`). No separate install step, but capture is opt-in and consent-gated: `register-device` shows a one-time consent screen that pins `capture.llm_session_enabled` in `~/.provian/config.json`, and on macOS the helper needs the one-time Accessibility + Input Monitoring grant in System Settings before it can observe foreground and input events (commit capture needs no grant). The plugin and its OS-agnostic `HelperBridge` spawn a per-platform native helper binary; macOS and Windows both ship one.

**Foreground-app detection:**
- macOS (shipping): native Swift helper in `native/darwin/foreground-helper` - NSWorkspace activation notifications, Accessibility API for browser URL, CGEventTap for input.
- Windows (shipping): native C# helper in `native/win32/foreground-helper` - `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` for foreground changes, UI Automation address-bar reads for browser URL, `WH_KEYBOARD_LL`/`WH_MOUSE_LL` for input, `SystemEvents` for sleep/wake/lock/unlock. Native apps match by `process_name`; browser tabs match by `browser_url`. The C# helper builds on a Windows host / Windows CI runner (`dotnet publish -c Release -r win-x64`); the TypeScript wiring (platform gating, helper resolution, process-name provider matching) is unit-tested cross-platform.
- Linux (planned): X11 `_NET_ACTIVE_WINDOW` / XDG Desktop Portal for Wayland. No helper binary yet; the plugin self-disables on Linux until one ships.

**Provider catalog:** JSON config at `provian-agent-sdk/src/observer/config/ai-providers.json`. Adding a provider is a config PR.

**Launch providers:** Claude, ChatGPT, Gemini, Perplexity, Grok, Venice.

**Session boundaries:**
- Start: with full input fidelity, the first real input in the AI context starts the session. Presence-only capture starts after 30 seconds in the foreground.
- End: AI context not foreground for at least 60 continuous seconds, or machine sleeps/locks, or daemon shuts down.
- Heartbeat: every 30 minutes of continuous session, emit a heartbeat PE covering the last 30 minutes.

**Input event counting:** Count keystrokes and clicks during active foreground. No content. Cluster events by 10-second gaps to approximate turn count. Compute `active_duration_ms` from windows containing input events.

**Opt-out:** set `capture.llm_session_enabled` to `false` in `~/.provian/config.json` (the key the consent flow writes; set it back to `true` to re-enable). The helper binary stays on disk either way — consent gates execution, not presence.

## 6. Mobile Provian app

**New chat section** inside the Provian mobile app, hosting six AI providers in a WebView.

**Launch providers with URL-based session detection:** Claude, ChatGPT, Gemini, Perplexity, Venice.

**Grok:** included but uses timestamp-based session boundaries because Grok does not expose session IDs cleanly. A five-minute interaction gap triggers a new session boundary. Disclosed to the user during onboarding consent and in the FAQ.

**Reference implementation:** the engineering pattern is ported from `LongevityManiac/ai-footprint-lab`, specifically `apps/afp-mobile-lab/src/screens/LabSessionBrowserScreen.tsx`. Specific subsystems to port: WebView wrapper, per-provider URL hostname matching, session ID extraction for the clean four providers, MutationObserver injection for char/image/video counts, AsyncStorage-based fingerprint dedup, back-navigation handling on Android.

**Explicitly not ported from ai-footprint-lab:** wattlings (sprite avatars), digital city visualization, "wattle it" verb, energy footprint math (Wh estimation, microwave-minute and phone-charge equivalents), subscription tiers, ad integration, energy-themed onboarding carousel. The Provian app does not surface environmental impact.

**Session boundaries:**
- End: user navigates to a different session ID, switches provider, closes the wrapper, or backgrounds the app for more than 60 seconds.
- Heartbeat: every 30 minutes.

**PE emission:** signed by the strongest available witness path (mobile hardware trust anchors where supported, with software signing as the fallback) at session end or heartbeat. Kept on the phone (backed up encrypted to the owner's own iCloud or Google Drive); its act record goes to the relay in the phone's daily signed batch.


**Consent flow:** one page on both platforms, shown before the first capture.

**Catalog integrity.** The `android_package_name` values in `provian-agent-sdk/src/observer/config/ai-providers.json` are unverified. They matter only to the retained UsageStats code, and must be checked against each provider's Google Play listing before that path is ever lit.

## 7. Narrative recalibration

Documentation and website updates carry the capture architecture through to every public surface.

**Documents updated:**
- `NETWORK_CONSTITUTION.md` Article I: new paragraph explicitly naming conversational AI work as first-class captured; cross-reference to this document.
- `docs/DEVELOPER_SETUP.md`: reframed around all AI-assisted work, developer content preserved as one section among several.
- `docs/PE_PROTOCOL_SPEC.md`: `ai_conversation` action type added to the catalog with full schema.
- `docs/AGENT_ECONOMY.md`: note that agents using conversational AI also generate PEs via the capture layer.
- New FAQ (now `docs/help/faq.md`): canonical FAQ covering capture scope, privacy posture, Grok fidelity, opt-outs.

**Website:** landing copy reframed to lead with the everyday AI user; developer and agent material present but below the fold.

**Privacy policy:** explicit sections covering what each surface observes and what it never observes.

## 8. Honest limitations

**Grok fidelity.** Timestamp-based session boundaries occasionally split one long conversation into multiple sessions, or merge two short conversations into one. The underlying work is captured accurately; the session structure is approximate.

**iOS passive capture outside the wrapper.** Apple does not expose third-party APIs for observing AI app usage or AI session metadata. iOS users capture only what happens inside the Provian app.


**Pricing.** Signed policy defines the base and permitted multipliers. Raw duration, turn and content counts do not directly price work.

**Provider DOM and URL patterns evolve.** The WebView wrapper and its session ID extraction require ongoing maintenance as providers restructure their web apps. The catalog approach makes updates cheap but they are not zero.

## 9. What this does not change

The PE hash chain, the signing model, the relay validation, the minting pipeline, the wallet architecture, the agent SDK, the commons, the promise protocol, the differential agent-side Foundation rate, and the core PE protocol spec beyond adding one action type. None of that moves.

This is additive architecture for a new surface the protocol needs to reach. The existing capture mechanisms (git commits, filesystem, OTel spans, process activity) continue to operate unchanged. The new desktop LLM session plugin is one more plugin in the existing daemon. The new mobile wrapper is one more section in the existing Provian app. The unified PE shape is one new action type in a permissionless type system designed for exactly this.

One note on coexistence with existing capture. The `inference_session` action type emitted by the LLMPlugin — now a zero-config witness of local inference runtimes (Ollama, LM Studio, llama.cpp `llama-server`, detected on loopback with their own request logs tailed; the JSONL log at `PROVIAN_LLM_LOG` remains an additional source) — is complementary to, not replaced by, the new `ai_conversation` action type. `inference_session` records machine inference work on the device (completed requests and models witnessed from the runtime's log; token counts only where the runtime exposes them, never estimated); `ai_conversation` records human engagement with AI across desktop and mobile surfaces via foreground detection and WebView instrumentation. Both can fire for the same underlying work when both apply, for example a developer on claude.ai with a logging agent runtime active. Dedup operates within each signal via its own fingerprint, not across signals. The two are measuring different dimensions of the same economy: machine inference cost and human AI engagement.

## 10. What this does change

The protocol's addressable population. Today's capture reaches developers, agent operators, and power users willing to integrate. Tomorrow's capture reaches anyone who uses AI to do work on a phone or a computer. That is the population the human-abundance thesis is about, and this is the architecture that lets the protocol serve them.
