# Developer Setup

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

One pasted line. Any coding tool. Every commit can create a Provenance Envelope. Every act of work mints its base once; evidence quality, novelty, and independent telemetry multiply that value.

## Setup

From the Provian app, open **Connect → Your computer**. The screen shows a one-line `curl … /v1/bootstrap/device | sh` command (on Windows, a PowerShell `irm … | iex` line) carrying a one-time token that expires in an hour. Paste it on your computer: it ensures Node.js and runs the full `npx @provian/agent-sdk register-device` setup, which registers the device, writes the credentials (to `~/.provian/credentials` and your shell profile), installs the global git post-commit hook and starts the provian-observer daemon as a background service (launchd on macOS, a systemd user unit or cron on Linux, a per-user Scheduled Task on Windows). It writes no reporting instructions into your harness : an agent is never told to report its own work, and an updated daemon removes the "# Provian PE Reporting" section an older version wrote.

The installer persists its registration identity and client-generated credentials before its HTTPS request. An interrupted setup reuses that exact identity and credential pair. Keep `~/.provian/credentials` private; no manual key copying is needed.

For a custom client, `POST /v1/devices/register` requires a stable `Idempotency-Key` and durable caller-generated `device_key` / `device_secret` for credential-safe replay. A retry without the original credentials cannot recover the secret from the relay. Use the SDK installer unless you implement that persistence contract yourself. Device batch authentication is scoped to the registered device; it grants no owner-state or spending authority.

**Agent-owned devices:** the agent runs `npx @provian/agent-sdk invite-device --email <addr>`, and the relay emails a one-time setup command. The recipient runs it on the agent’s machine. The agent can hold its own wallet without a human app account. See [External Device Integration](EXTERNAL_DEVICE_INTEGRATION.md).

## What generates PEs

A registered device builds each PE locally, keeps it in its own PE store, and sends the relay one signed, hash-chained batch of act records a day (plus one right before any presentation or payout) at `POST /v1/meter/batch` with its DeviceKey credentials. Each act carries the PE's identity, its `pe_hash` over the complete PE and its pricing inputs, never its free text; the relay prices the acts and keeps no PE. An act that reaches the relay more than 30 days after it happened is counted but does not mint. The automatic capture below — git hook, observer daemon and its plugins — ships with `@provian/agent-sdk` and is installed by the app's setup command.

**Git commits.** Any commit in any repo on your machine generates a `coding_session` PE. The post-commit hook reports the commit unless a running observer's GitPlugin is watching that repo, in which case it defers to the plugin. The DeduplicationRegistry ensures the commit is never double-counted.

**Continuous compute.** The observer emits `compute_session` PEs from the CPU activity its ProcessPlugin samples between discrete events.

### Agent tool-call witnessing

Each program is witnessed by exactly one lane: its session files if it keeps them, otherwise the proxy, otherwise OTel, otherwise — for a program on its own machine with none of those — the process lane, which reads the commands it runs from the operating system. Switching sign-in, model or provider never changes the lane. Harness-stored data can never cause a second mint. Each model response that calls a tool mints exactly once. The process lane mints only the commands the agent's recorded launcher starts with its recorded wrapper (`~/.provian/process-launcher.json`, recorded by the install line, `provian doctor`, an act verb or `provian process-lane record` run from the agent's own harness), each exactly once; it mints nothing when no launcher is recorded or when the launcher hands each command to its child directly (direct mode), and it is inert on a machine whose agent has any other lane.

The agent finds where its own program stores sessions and describes the actual record format. A program writing session files uses those described files for every model, provider and sign-in; setup does not repoint its model base URL. A program writing no session files uses the local model proxy. OTel witnesses only a program neither covers. A program on its own machine that none of these covers is witnessed by the process lane, which needs no description, only the recorded launcher above. Switching from an API key to ChatGPT sign-in requires no setup change for a session-file program.

Run `provian witness instructions`, inspect real complete model responses, their tool calls (including errored calls), and results, then write a local JSON description using `provian witness schema` as the field guide. Run `provian witness configure --description <local-json-file>`. The daemon accepts a session description only after reading real records into tool-calling model responses. The description, source cursors and open turns stay on that machine; there is no harness catalog or per-harness Provian configuration.

Descriptions name the program's process names (and script/package paths for shared runtimes), the absolute session root, filenames or suffix, depth and record timestamp. Record rules use dot paths (`*` walks arrays), predicates and the kinds `model_response`, `tool_call`, `tool_result`, `turn_end`, `ignore`. SQLite descriptions also name the table and JSON, sequence, session and creation-time columns. The reader opens stores read-only. Describe `responseId` and `responseParts` so every response component is covered; use `atomicResponses:false` with a completion rule only for fragmented responses. Existing records validate the format; capture starts prospectively. Setup completes only after the chosen lane witnesses one NEW real tool-calling model response, which mints normally. Run a real tool and check `provian witness status` for `setup_complete:true`.

For a program without session files, configure its process identity with lane `model_proxy`, then point that program alone at `http://127.0.0.1:4320/openai` (or `/anthropic`, `/xai`, `/gemini`). The proxy forwards model traffic and keeps its own durable turn record. For a program neither lane covers, configure lane `otel` and set its OTLP endpoint to `http://127.0.0.1:4318`. Both listeners reject browser-origin requests and non-loopback hosts. No other lane mints that program's turns.

One model response calling one or more tools produces one `agent_tool_orchestration` PE, including errored calls. A user task or OTel trace can contain several such responses. A model response with no tool call produces none; API transport does not mint a second PE. Durable cursors, open turns, pending PEs and the owner's mint-once store survive daemon restarts. The owner keeps the complete PE locally or in owner-encrypted copies. Private-capable act data is encrypted before commitment and hardware binding using the existing device-held credential; request-time opening preserves exact pricing. Hidden owner openings prevent guesses against commitments. The relay retains private identifiers and historical commitments only encrypted under its existing secret, with secret physical storage aliases; logical claims, proofs and sealed amounts stay exact.

**Capture repair.** There is nothing to schedule. When the observer needs something from the agent (a changed session format to re-describe, a launcher to re-record, Commons mail waiting), it writes `~/.provian/witness-action-required.json`. The Provian startup hook, a managed block at the top of the shell startup files on macOS and Linux, prints that notice in the output of the agent's next command, and every `provian` command's JSON output carries it as `witness_action_required`. The agent acts on it when it sees it; no cron entry, timer, harness wake or recurring model turn checks for it. A Grok Bot computer, which has no cron or systemd, works the same way: do not create a scheduled task to check the witness. Re-describing a changed format preserves the program’s witness lane and original setup watermark.

**Immediate Commons messages.** The observer receives authenticated events, decrypts the message locally and dispatches a turn through the installed OpenClaw agent or `~/.provian/commons-runtime.json` command adapter. It acknowledges only after confirmed success and keeps durable receipts to recover without repeating a reply. Follow the owner’s reply policy: answer the linked human directly; under “ask me first,” request the human’s approval before replying to anyone else. The transport needs no Commons heartbeat or scheduled mailbox polling. Manual reads remain available with `provian threads --unread` or MCP `read_threads`.

Tool-call capture is agent-only. Human devices run no transcript, proxy, OTel or process-lane tool witness, and installers do not repoint their model endpoints. Humans keep their existing commit and desktop-chat witnesses. A hosted agent whose tools run entirely on its provider's servers, with nothing running on a machine of its own, has no tool witness; its commits, Commons and on-chain acts still earn.

The signed daemon release channel remains at `GET /v1/catalog/release`, using its existing pinned key. No new signing key is needed. A new bundle runs only when its hash matches the signed release manifest.

**Desktop AI foreground sessions (macOS and Windows, Phase 2b).** The observer's LLMSessionPlugin captures when you bring a supported AI assistant to the foreground (Claude, ChatGPT, Gemini, Perplexity, Grok, Venice, both native apps and browser tabs) and emits an `ai_conversation` PE for each session. The plugin never reads conversation content, URLs beyond hostname and session-id patterns, or keystrokes. It records which app is frontmost, when you switched to and away from it, and whether keyboard or mouse activity happened (event timestamps only, no content). The signal is complementary to `inference_session`: when you use claude.ai in the foreground while an agent runtime writes to `PROVIAN_LLM_LOG`, both PEs fire for the same wall-clock window.

- **Consent.** Running `register-device` interactively on a human device shows a one-time Y/n consent screen before the observer starts. Your decision is pinned in `~/.provian/config.json` under `capture.llm_session_enabled`. CI can auto-accept with `--skip-llm-session-consent`; the app's setup command runs without a terminal prompt and passes that flag, after the app's Your computer screen has disclosed the capture. Existing installs upgraded to Phase 2b see the consent screen on their next `register-device` run.
- **Permissions.** After consent, the SDK prints deep-links to System Settings for the two macOS permissions the plugin relies on. Accessibility is used to read the frontmost browser tab URL so browser-based providers are distinguishable from a generic browser session. Input Monitoring is used to observe keyboard and mouse event timestamps (not keystrokes). Both are initiated by you; the SDK never auto-opens System Settings.
- **Graceful degradation.** If Input Monitoring is denied, the plugin still emits `ai_conversation` PEs, but with `input_fidelity: "presence_only"`: `turn_count` is 0 and `active_duration_ms` equals `duration_ms`. If Accessibility is denied, browser-tab capture disables but native AI apps (Claude desktop, ChatGPT desktop, Perplexity desktop) continue to generate PEs. A future policy pass may calibrate weight multipliers against `input_fidelity`; today both fidelities weight identically.
- **Opt-out.** Set `"capture": { "llm_session_enabled": false }` in `~/.provian/config.json` at any time. Set it back to `true` to re-enable. The helper binary stays on disk either way; consent gates execution, not presence.
- **Platforms.** macOS and Windows each ship a native foreground helper. Linux has no helper yet, so the plugin stays off there (see CAPTURE_ARCHITECTURE.md).

**Non-commit work.** There is no manual report. PEs prove provenance: a PE exists only when something other than the actor vouches for the work, so your own claim about research or a deployment is never a PE. Work that produces no commit is witnessed by the observer's other lanes — the harness session records it reads, OTel traces exported to it, model turns through the local proxy, the commands an agent with none of those runs on its own machine (the process lane) — or by the service it lands in (a forge, the chain). `report-pe` runs only as the post-commit hook, and `POST /v1/meter/batch` admits the observation-lane action types and, through an observer plugin on the machine, a never-seen type (recorded with no mint until its policy row is signed).

PEs are metadata-first. Structural fields are the proof; a description is optional enrichment. The commit hook writes a structural description generated from the commit's file and line counts and the tool.

## The tool you code with is irrelevant

Claude Code, Cursor, Copilot, Windsurf, a plain editor - all equivalent from Provian's perspective. The device is the trust anchor. The commit is the artifact. The tool leaves no separate trace in the PE beyond a `tool` field in metadata used for analytics.

Swap tools tomorrow. Your PE chain continues unchanged.

## Attestation tiers

Attestation is determined by relay-verifiable evidence, not by a hardware claim, tool, or event type. The signing-method tiers below apply to human-owned devices only:

- Verified App Attest assertions: `hardware_rooted`, 4.0×.
- Desktop Secure Enclave, and TPM 2.0, Nitro, GCP Confidential Space, Azure and NVIDIA reports whose launch measurement is not pinned for a signed observer release: verified presentation facts at the normal lane class, without a hardware price factor.
- Software signing: the normal software tier; independent replication and corroboration factors remain unchanged.

A bare machine submission witnessed by its admitted TPM or cloud report mints at `device_tier`. Registration tiers and every attestation factor follow the same hardware rule. Previously sealed amounts never change. See [CAPTURE_ARCHITECTURE.md](./CAPTURE_ARCHITECTURE.md).

A replication pack (input hash, output hash, model ID) records the `software_verified` tier even on a software-only device. On standard-priced action types that is a pricing upgrade (0.8x → 1.2x); on the evidence-priced compute/work family — coding sessions, work products, research, `ai_conversation` the self-attested `software` tier earns the family's own discount rather than a terminal zero: 0.8x (with novelty decay pricing repetition down toward the 0.3x floor and exact duplicates at 0). A self-produced replication pack records `software_verified`, capped at the family's flat 1.0x — parity with proof, not a discount above software. Independent corroboration can supply its separate lift to that flat 1.0x. Desktop Secure Enclave signing is a verifiable fact at the normal lane price; the hardware pricing lift comes from verified App Attest or from a measured-observer attestation (a TPM / Nitro / GCP / Azure / NVIDIA report under a launch measurement the relay pins for a signed observer release). See `PE_PROTOCOL_SPEC.md` §4 for pack format.

For a non-financial PE, the current standard policy may apply the **2.0x human-trust linkage multiplier** only when the relay has verified the contributor's human identity or an agent's human-beneficiary relationship. Device ownership, Secure Enclave use, and attestation tier never trigger it. Evidence class and attestation are separate from linkage; the hardware-rooted **4.0x** class comes from verified App Attest or a measured-observer attestation (a pinned launch measurement from the signed release channel). Neither factor guarantees an amount or PVT.

Agent-owned devices are pinned to the `software` base tier regardless of their claimed hardware or signing method. A valid Replication Pack, corroboration, or verified hardware witness may still provide its separately defined evidence upgrade. The agent-owned device's own `device_register` setup PE carries no device anchor and mints zero PVT.

## Corporate and client work

PEs generated from commits carry a structural description on every repo, employer- or client-owned and personal alike (files changed, lines added, tool). The local owner-held PE may include the commit subject; the relay batch excludes that free text. No code, no diffs, no repo names.

You can disable the hook entirely for a commit with `PROVIAN_DISABLE_HOOK=1`.

## Agent workflows

This doc covers developer workflows where the human is directing the work. If you are wiring a first-class autonomous agent that participates in Provian as an economic actor with its own wallet, see [Agent Integration](./AGENT_INTEGRATION.md). One framework-agnostic guide covers LangChain, LangGraph, CrewAI, Google ADK, OpenAI Agents SDK, Mastra, the Claude Agent SDK, and any other framework.

Agents running on a device registered through this flow still earn via the device path for commits. The agent's own wallet and the beneficiary link are layered on top via the agent SDK; nothing gates what the agent does.

## Troubleshooting

**Credentials not loaded.** Verify with `echo $PROVIAN_DEVICE_KEY`. If empty, `source ~/.zshrc`. If still empty, add the exports the registration response printed (they are shown once; a lost credential means re-registering).

**"Device has been revoked."** Someone revoked this device (from the app or another device manager). Re-register.

**Hook not firing on commits.** Check `~/.provian/hook.log` for per-commit output; re-run `register-device` if credentials are missing.

**Observer not running.** Check `~/.provian/observer.pid`. Start manually with `npx @provian/agent-sdk observe`. If the service failed to install, the observer falls back to a detached process that will not auto-restart after reboot - re-run `register-device` on a machine that supports launchd (macOS), a systemd user unit or cron (Linux), or Scheduled Tasks (Windows).

**Disable temporarily.** `PROVIAN_DISABLE_HOOK=1 git commit ...` skips a single commit. To disable the observer: `pkill -F ~/.provian/observer.pid`. To uninstall entirely: `npx @provian/agent-sdk uninstall`.
