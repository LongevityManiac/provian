# Agent SDK version & staleness signal

Agent keys are immutable and the relay updates instantly on every deploy, but an
agent's **client SDK** only changes when its operator pulls a new package. Before
this mechanism there was no signal telling an operator a newer SDK existed, so
agents silently staled on important features (e.g. Solana wallet support + Solana
x402 landed in v1.5.0 with nothing nudging older installs to update).

This document describes the advisory version signal that closes that gap. It is
**advisory, fail-open, and never a gate** — nothing here can break an agent's
operation, and it never touches the agent's own x402 spending (agent's money,
agent's rules).

## Source of truth

The relay is the source of truth for "what version an agent should be on":

- `SDK_LATEST` — mirrors `provian-agent-sdk/package.json`'s version. It is the
  version an up-to-date agent runs. Bump it in the same change that publishes a
  new SDK. (`provian-backend/src/core/sdk-version.ts`.)
- `SDK_MIN_SUPPORTED` — a deliberately permissive advisory floor (`1.0.0` today:
  no released 1.x SDK is protocol-incompatible, so nothing real trips it). Raise
  it only when a genuinely breaking change ships. Raising it never makes the
  relay refuse an agent — it only escalates the SDK's log (and, if the operator
  opted into strict mode, a connect-time throw).

A cross-package test (`sdk-version.test.ts`) fails if `SDK_LATEST` drifts from
the SDK package's actual version, so the two can't skew.

## How the relay advertises it

Three surfaces, in increasing convenience:

1. **`GET /v1/sdk/version`** — public, ungated (agents must be able to learn
   staleness at any time). Returns
   `{ latest, minSupported, upgradeCommand, notes, minNote }`.
2. **`X-Provian-SDK-Latest` / `X-Provian-SDK-Min` response headers** — set on
   **every** relay response by a global middleware. This is the primary channel:
   the SDK learns staleness passively on connect and on every heartbeat GET,
   with no dedicated call.
3. `connect` is itself a relay request (sovereign mode probes
   `GET /v1/sdk/version`; device mode pings `/v1/devices`), so a fresh `connect`
   already knows. There is no relay session; `connect` is a
   reachability probe.

## How the SDK consumes it

- `SDK_VERSION` (`src/version.ts`) is the SDK's own version as a compile-time
  constant — the one form that resolves in the tsc `dist/` package, the
  self-contained bootstrap bundle (where `package.json` isn't on disk), and
  vitest alike. Kept in lockstep with `package.json` by `version.test.ts`.
- Every relay response passes through `ProvianClient.fetchWithTimeout`, which
  reads the two headers and compares them to `SDK_VERSION`
  (`src/sdk-staleness.ts`). Reading headers never consumes the body, and a
  missing/odd `headers` object can never break the request (fail-open).
- On the **first** time the SDK finds itself behind, it logs **once** (deduped so
  heartbeats don't spam):
  - stale (`current < latest`, still supported): `console.warn` with the upgrade
    command.
  - below minimum (`current < minSupported`): `console.error` (louder).
- The observer daemon surfaces `sdk_version` / `sdk_stale` / `sdk_below_min` in
  its device self-report (`PUT /v1/devices/me/capture-status`), so a stale agent
  shows up in the **phone's device view** — display-only, never affecting auth,
  attestation, or earning.
- `client.getSdkStaleness()` returns the current verdict; `client.checkSdkVersion()`
  does an explicit best-effort pull for one-shot callers.

## Failure behavior (fail-open by design)

- A missing or unreachable `/v1/sdk/version`, absent headers, or an unparseable
  version → the check is a no-op and the agent operates normally.
- `belowMin` logs loudly but, by default, **does not** stop the agent
  (availability wins). Operators who want a hard stop set
  `strictSdkVersion: true` in `ProvianClientConfig`; connect then throws
  `ProvianError(code: 'SDK_BELOW_MIN')` when the relay advertises a minimum newer
  than the running SDK. Even in strict mode, a relay that advertises no version
  never throws.
- None of this gates the agent's own x402 spending, ever.

## Updating an agent

`@provian/agent-sdk` is published on npm. Update it with:

```
npm i @provian/agent-sdk@latest
```

If the agent runs the SDK via `npx @provian/agent-sdk`, clear the npx/npm cache
so `@latest` resolves the just-published version rather than a cached older one.

The observer daemon (including one installed by the hosted `curl … | sh` line)
does not wait for this: it updates its own bundle from the Provian-signed release
channel, on by default — see [SELF_UPDATE.md](./SELF_UPDATE.md).
