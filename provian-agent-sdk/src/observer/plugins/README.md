# Observer plugins

Plugins extend the observer with targeted capture for a specific kind of
work. All plugins implement the `ObserverPlugin` interface in
`PluginInterface.ts`: `init`, `start`, `tick(session)`, `stop`, and an
optional `drainPEs` for plugins that emit their own PEs.

The observer host (`ProvianObserver`) runs a ~1 Hz tick loop. On each
tick it calls every plugin's `tick` to collect session contributions,
then calls `drainPEs` on any plugin that supports it and records those
PEs in this machine's PE store (they reach the relay in the daily batch).

A `DeduplicationRegistry` prevents two plugins from emitting overlapping
PEs for the same work window. Plugins can opt out of dedup with
`PluginPE.skipDedupClaim: true` when their signal is genuinely
complementary to the generic compute/inference/coding session family.
See [CAPTURE_ARCHITECTURE.md §9](../../../../docs/CAPTURE_ARCHITECTURE.md)
for the coexistence model.

## Plugin catalog

### ProcessPlugin

Background compute telemetry from the OS. Reads CPU, memory, and network
counters for the current process (or a target PID). Drives session
boundary detection and emits `compute_session` PEs via the observer's
generic session finalizer.

- Owner-gate: dormant on human devices (no agent process to observe);
  active on agent devices.
- Output: drives `SessionManager`; the observer emits `compute_session`
  or `inference_session` depending on whether inference was witnessed in
  the window (observed tokens OR completed local-inference requests).

### GitPlugin

Polls `.git/refs/heads/` in discovered repos every 5 seconds. Emits a
`coding_session` PE on new commits with diff stats, branch name, and the
commit subject in the owner's local PE for every repository. The relay batch excludes
that free text and receives only permitted pricing metadata.

- Output: `coding_session` PEs. Claims the window in the dedup registry
  so the observer does not emit a redundant `compute_session`.
- Coexistence: the post-commit git hook template defers to the observer
  when running, so commits are never double-counted.

### Program tool witnesses (agent-only)

Each program is witnessed by exactly one lane, fixed at setup. Harness-stored data can never cause a second mint. Each turn mints exactly once.

Run `provian witness instructions`. The agent finds and describes its actual session store with `provian witness configure --description <local-json-file>`; the daemon validates real complete tool turns before accepting the description. A session-file program always uses TranscriptPlugin, with no model base-URL repoint and no setup change for model, provider or sign-in switches. The descriptor and durable cursor/turn state stay on the machine.

A program writing no session files uses ModelProxyPlugin (`127.0.0.1:4320`), configured by process identity before pointing that program alone at the proxy. OTelPlugin (`127.0.0.1:4318`, OTLP JSON/protobuf) witnesses only a program neither covers. Other lanes forward or read nothing for that program; they mint no turn. Pure model calls do not mint. Both listeners reject browser origins and non-loopback hosts.

A format break holds unread records, writes `~/.provian/witness-action-required.json` with the standing re-description instruction, and flags capture-health. The agent inspects changed real records and refreshes its local description with the same lane and original watermark. There is no signed harness catalog. The signed daemon release channel and its pinned key remain.

A program that runs on its own machine with NONE of those — no session files, no proxy routing, no OTel — is witnessed by the **process lane** (`ProcessLanePlugin`), which reads the OS process table directly: one PE per command the agent launches, with every child process, connection and file change folded into that act. The installer binds the agent’s launcher and wrapper. Without that binding, or with a launcher that passes each command directly to its child, the lane mints nothing. It names no agent or framework. It never mints the daemon's own tree, the machine's pre-existing/baseline processes, a program another lane already witnesses, or the VM runtime's background services (a tree that never completes, or a supervised respawn). Mint-once is the daemon's own durable ledger (`~/.provian/process-lane-ledger.json`), so a restart, re-read, VM replacement or self-update mints nothing twice. It emits the ordinary `agent_tool_orchestration` type on the `process` daemon lane (`provian:process`), priced at parity with the other tool lanes. Agent devices only. See [CAPTURE_ARCHITECTURE.md §3](../../../../docs/CAPTURE_ARCHITECTURE.md).

Human devices have no tool lanes. They retain commits and foreground desktop chat, and installers do not repoint human model endpoints. A hosted tool loop that runs entirely on a vendor's servers and never touches the box remains unwitnessable for those tool calls; commits, Commons and chain acts still earn, and any command the agent runs on its own box is witnessed by the process lane.

### LLMPlugin (zero-config local inference)

Witnesses LOCAL model work with no configuration. Detects Ollama
(`127.0.0.1:11434`), LM Studio (`:1234`) and llama.cpp `llama-server`
(`:8080`) on loopback (bounded probe at start, re-probed every minute so a
runtime started later is picked up), tails the request log each runtime
writes itself, and contributes to the open session per tick:

- `requests` — COMPLETED inference requests (2xx on an inference route:
  Ollama `[GIN] … POST "/api/chat"|"/api/generate"|"/v1/chat/completions"|
  "/v1/completions"`, LM Studio `Received POST request to /v1/…`,
  llama-server `request: POST /v1/chat/completions … 200`);
- `models` — what the runtime reported loaded (`/api/ps`, `/api/v0/models`,
  `/props`) or named in its log;
- `tokens_processed` — ONLY where the runtime exposes token counts
  (llama-server `prompt eval time … / N tokens` + `eval time` lines, LM
  Studio `"usage":{…}` lines, the JSONL source). Ollama's server log has
  none, so an Ollama window ships `tokens_processed: null` and
  `metadata.inference.tokens_observed: false`. Never estimated.

Any contribution with requests > 0 (or observed tokens) is ACTIVITY: the
observer opens or extends the session on it (`SessionManager.witnessActivity`)
and closes it on idle from its own tick (`SessionManager.expire`), which is
what lets a HUMAN device — where ProcessPlugin is gated off and no CPU sample
ever opens a session — witness local model work under one minted lineage.

- Owner-gate: active on human AND agent devices whenever a local runtime is
  running or installed, or `PROVIAN_LLM_LOG` is set (`resolveActivePlugins`).
- Output: the session finalizer emits `inference_session` when
  `tokensProcessed > 0 || inference.requests > 0`, with
  `metadata.inference = { runtime, requests, models, source, tokens_observed }`.
  Body-bound and lineage-bearing, it seals VERIFIED on the relay and mints
  at the device tier (`device_occurrence` mint-once per session).
- Log overrides: `PROVIAN_OLLAMA_LOG`, `PROVIAN_LMSTUDIO_LOG`,
  `PROVIAN_LLAMA_SERVER_LOG` (llama-server logs to stderr, so its log is
  only tailed when you name the file it is redirected to). Endpoint
  overrides are loopback-only (`OLLAMA_HOST`, `PROVIAN_LMSTUDIO_URL`,
  `PROVIAN_LLAMA_SERVER_URL`); a non-loopback host is refused.
- Legacy JSONL source: `npx @provian/agent-sdk configure --llm-log <path>`
  for a runtime that writes `{model,input_tokens,output_tokens}` records.
- Complementary to LLMSessionPlugin: measures machine inference work,
  not human AI engagement. Both can fire for the same wall-clock window.

### LLMSessionPlugin (desktop capture)

Captures desktop AI assistant foreground sessions (Claude, ChatGPT,
Gemini, Perplexity, Grok, Venice, both native apps and browser tabs) and emits
`ai_conversation` PEs. The plugin never reads conversation content,
URLs beyond hostname and session-id patterns, or keystrokes.

- **Owner-gate:** human devices only. `resolveActivePlugins` drops it on
  every agent device (2026-09-26): on an agent's machine it either does
  nothing (headless) or records a human's or a computer-use agent's
  foreground screen time as the agent's work — the wrong author on the PE.
  Agent installs never start it; an installed agent daemon drops it on its
  next start (a self-update's re-exec).
- **Platform:** macOS and Windows (each ships a native helper); Linux is
  permanently deferred (Wayland does not expose global input observation to
  unprivileged clients).
- **Composition:** a native Swift helper
  (`provian-agent-sdk/native/darwin/foreground-helper/`) spawned as a
  child process emits validated line-delimited JSON on stdout:
  `foreground_changed`, `input_event`, `system_state`,
  `permission_status`, `error`, `fatal`. The plugin routes those events
  through a pure-TS state machine that drives session boundaries and
  emits heartbeats and session-end events. The plugin converts those
  emissions into `PluginPE` structures and queues them for the observer.
- **Consent model:** gated by `capture.llm_session_enabled` in
  `~/.provian/config.json`. The `register-device` flow shows a one-time
  Y/n prompt. CI can auto-accept with `--skip-llm-session-consent`.
  Existing installs upgraded to desktop capture see the prompt once on the
  next `register-device` run; after that the decision is pinned.
- **Opt-out:** set `capture.llm_session_enabled: false` in `~/.provian/config.json`. The
  helper binary stays on disk either way; consent gates execution, not
  presence.
- **Permissions:** Accessibility (browser tab URL extraction) and
  Input Monitoring (keyboard and mouse event timestamps, not
  keystrokes). If Input Monitoring is denied, the plugin still emits
  PEs with `input_fidelity: "presence_only"`; governance may calibrate
  weights against that field in a future pass. If Accessibility is
  denied, native AI apps continue to capture but browser tab
  identification disables.
- **Output:** `ai_conversation` PEs with metadata per
  [CAPTURE_ARCHITECTURE.md §4](../../../../docs/CAPTURE_ARCHITECTURE.md).
  Every PE carries `skipDedupClaim: true` so inference_session,
  compute_session, and coding_session PEs for the same wall-clock
  window are not suppressed. Relay-side dedup is by
  `session_fingerprint_hash` (SHA-256 over length-prefixed UTF-8
  fields: provider, session_start_ms, duration_ms, turn_count,
  plugin_name).
- **Event flow (summary):**

```
helper stdout ─► HelperBridge (validation, backpressure, restart)
                         │
                         ▼
                 LLMSessionStateMachine
                 (idle | candidate | active | closing)
                         │
                         ▼ emit_heartbeat / emit_session_end
                    LLMSessionPlugin
                         │
                         ▼ buildPE (fingerprint, metadata, skipDedupClaim)
                     PluginPE queue
                         │
                         ▼ drainPEs (per observer tick)
                    ProvianObserver ─► local PE store ─► daily batch ─► relay /v1/meter/batch
```

See `llm-session/stateMachine.ts` for the state model,
`llm-session/catalog.ts` for the provider catalog, and
`llm-session/ipc.ts` for the bridge.

## Writing a new plugin

Implement `ObserverPlugin`. Keep side effects scoped to `start` and
`stop`. Read `ProvianObserver` only for logging and session manager
access; do not hold long-lived references that outlive `stop`.

If your plugin emits its own PEs:

- Return them from `drainPEs` on each tick.
- Include `windowStart` and `windowEnd` so the dedup registry can claim
  the window.
- Set `skipDedupClaim: true` only when your signal measures a dimension
  other than compute/inference/coding session. When in doubt, leave it
  unset.
- You may emit a type of your own (the gateway path): on every PE your
  plugin hands over, the observer stamps `metadata.source:
  "observer_plugin"` and `metadata.observer_plugin: <your plugin's name>`,
  overwriting anything your plugin set there (and dropping a `tool` that
  names one of the daemon's own lanes), and the act rides the device's
  daily batch at device tier. Only the daemon's own lanes carry their
  lane markers: the observer refuses a `link_spend` or
  `agent_tool_orchestration` from a plugin, and the relay refuses a
  plugin-marked act that carries either type or a lane's marker. A type the
  network has never seen records with no mint, enters the public review
  queue (provian.ai/proposals), and earns from the day its policy row is
  signed. A named type that has its own witness (a chain, relay, forge or
  Genesis type) is refused on this path.

Every new plugin should have a unit-test double for its external
dependency (filesystem, child process, HTTP server) so tests run
deterministically without real resources.
