# Framework Integration Examples

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

Provian works with any agent. Integration is instrumentation, not a report: the observer daemon on a registered machine witnesses what the agent does — the session records its harness already writes, model turns sent through the local model proxy, OpenTelemetry spans its framework exports, and, for an agent on its own machine with none of those, the commands it runs, read from the operating system. Each program is witnessed by exactly one of those lanes: its described session files if it keeps them, otherwise the proxy, otherwise OTel, otherwise the process lane. Each model response calling one or more tools mints once, including errored calls, and each command a process-lane program runs mints once; switching model, provider or sign-in never changes the lane. Provian maintains no per-harness or per-framework integration. The examples below are illustrative — non-exhaustive places where that witnessing attaches. They are not a maintained per-framework matrix, and no framework here is special or recommended; the same observer works in OpenClaw, Hermes, IronClaw, or any runtime.

**PEs prove provenance.** A Provenance Envelope (PE) exists only when something other than the agent vouches for the work — the device observing it, a counterparty, a forge, or the chain. An agent's own claim about its work is never a PE, at any tier. So none of these examples has the agent describe its work: there is no `reportAction`, no `provian report`, no `submit_pe`, and the relay refuses a caller-chosen action type on the device route unless an observer plugin witnessed it (the batch receipt marks that act `refused`, `actor_declared:action_type_not_observed`). What the device route admits is the observation-lane types — `agent_tool_orchestration`, `agent_api_orchestration`, `coding_session`, `compute_session`, `inference_session`, `ai_conversation`, and a transcript-witnessed `link_spend` and a never-seen type an observer plugin on the machine witnessed (the gateway path), which records with no mint until its policy row is signed.

Provian never gates your agent. Every PE here is recorded after the fact; nothing reaches into your agent and stops it. Every act of work mints once at its best-supported value; stronger verified evidence may raise that value, but no tier guarantees a particular amount, settlement time, or market value. That incentive, not enforcement, is the mechanism.

**Prerequisites:** Host registered as a Provian device — one HTTPS call to `POST /v1/devices/register` with a one-time token from the app, whose Connect → Your computer line runs it and starts the observer. The relay's human-computer email (`kind=device`) carries that direct call; agent-computer emails carry the hash-checked hosted installer that registers and starts the observer; see [DEVELOPER_SETUP.md](./DEVELOPER_SETUP.md). Agent wallet created per [AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md). To register the host as an **agent-owned device** (PEs attribute to the agent wallet) without pasting the agent API key/secret, consume the one-time emailed line instead — minted via `POST /v1/agent/wallet/:wallet_id/device-invite` (the agent's own invite) or the relay's `kind=agent_device` email command under the linked human's wallet auth. See [EXTERNAL_DEVICE_INTEGRATION.md](./EXTERNAL_DEVICE_INTEGRATION.md) Section 2. (`npx @provian/agent-sdk register-device`, with `--agent-token <token>` for an emailed agent token, registers the same way from a shell.) There is no relay session: retired `POST /v1/relay/agent/connect` and `Bearer {session_id}`. Which credential unlocks which lane: [AUTH_MAP.md](./AUTH_MAP.md).

---

## Any framework that emits OpenTelemetry (no code change)

The observer runs a loopback OTLP/HTTP receiver on `127.0.0.1:4318` and records one `agent_tool_orchestration` PE per model response calling one or more tools, including errored calls (and HTTP-client chains into `agent_api_orchestration`), classifying spans only by the GenAI / OpenInference / OpenLLMetry semantic conventions. Use this lane only for a program neither its own session files nor the proxy covers. Configure that program’s fixed witness as OTel, turn on its standard instrumentation and point only its exporter at the receiver:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

That covers LangChain, LangGraph, CrewAI, LlamaIndex, AutoGen, the OpenAI Agents SDK, Mastra, and any runtime with standard OTel GenAI instrumentation.

## Any framework, by its model calls (no code change)

The observer's model-endpoint proxy on `127.0.0.1:4320` witnesses each model turn's tool calls and token usage, whatever the framework or vendor. Use it only for a program that keeps no session files. Point that program’s model base URL at it and restart:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4320/anthropic
export OPENAI_BASE_URL=http://127.0.0.1:4320/openai
export XAI_BASE_URL=http://127.0.0.1:4320/xai
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4320/gemini
```

The key rides through untouched and is never logged. This is the path for the Claude Agent SDK, Google ADK, Mastra, and a hand-rolled agent loop alike. The selected witness alone mints that program’s responses; session-file capture takes priority, then proxy, then OTel, then the process lane.

---

## LangChain, LangGraph and CrewAI (Python)

A Python framework program keeps no session files of its own, so the observer witnesses it like any other such program: through the model proxy when its model base URL points at the proxy, otherwise through the OTel receiver with the framework's standard instrumentation, and, on its own machine with neither, through the process lane, which witnesses each command it runs. Nothing is added to the program's code.

---

## Hermes

Hermes is witnessed like any other program that keeps session files: the agent describes Hermes's own session records (`provian witness instructions`, then `provian witness configure --description <local-json-file>`), and the observer accepts that description only after validating it against real records. The SDK ships no built-in Hermes description. Each model response that calls at least one tool, including errored calls, records one `agent_tool_orchestration` PE, regardless of the number of tools. Session files remain the witness across provider, model and sign-in changes. Setup must witness an actual new response before completing.

---

## Card purchases through Stripe Link

An agent can pay with its human's card through Stripe Link's wallet for agents (Link CLI `spend-request`; one-time card, shared payment token, or Link Pay Token — the same `lsrq_…` spend request either way). The human sets it up in the app (Agent Hub → the agent → Card spending); the card stays in the human's Link account and Provian never holds, asks for, or sees it. There is no call to record a spend : where the observer's transcript lane reads the Link CLI call and its result from the agent's harness transcript, it records a `link_spend` PE carrying the spend-request fields only — never a card object, a credential, or `LINK_ACCESS_TOKEN`. A successful `link_spend` is a priced work type, mint-once on the `lsrq_…` id; other terminal outcomes record what happened without a work mint. A hosted bot follows the same rule: the spend is witnessed when the transcript its harness writes on its machine carries the Link CLI call and its result.

---

## See also

- [Agent Integration](./AGENT_INTEGRATION.md) -- what records an agent's work, hosted bots, and the Link spend witness
- [Developer Setup](./DEVELOPER_SETUP.md) -- device registration and observer daemon
- [Agent Architecture](../AGENT_ARCHITECTURE.md) -- wallet creation, beneficiary linking, PVT splits
