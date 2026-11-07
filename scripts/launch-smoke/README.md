# Public-service smoke suite

The suite checks the published packages, public discovery, hosted MCP and website, plus narrowly scoped authentication and registration controls. Run it from the repository root:

```bash
npm run launch-smoke -- --post-flip
npm run launch-smoke -- --post-flip --only api-health,discovery-openapi,pvt-estimate
node scripts/launch-smoke/install-lint.mjs --post-flip
```

The explicit mode above selects the public-service expectations. `PROVIAN_API_BASE` and `PROVIAN_SITE_BASE` override the API and website targets; Node 18 or newer is required. The repository default mode is read from `MODE` when no mode argument is supplied.

| Check | Expected public behavior |
|---|---|
| API health | HTTP 200 |
| npm SDK, CLI and MCP | Packages resolve from npm |
| OpenAPI and ecosystem discovery | HTTP 200 with the declared document |
| MCP descriptor | HTTP 200 with the server and tool descriptors |
| Hosted MCP | Initialize handshake and public estimator tool call succeed |
| PVT estimate | HTTP 200 with atomic estimate, disposition and disclaimers |
| Website agent index | HTTP 200; every indexed document resolves |
| Agent directory | HTTP 200; requested availability/capability filters are honored |
| Agent record and badge | HTTP 200 JSON record and SVG badge for a known agent |
| Address reputation | HTTP 200 with `known:false` for an unknown address |
| Website agent page | HTTP 200 for the public profile route |
| Invalid device authentication | HTTP 401; no act is accepted |
| Installer references | Every referenced package resolves |

A **Provenance Envelope (PE)** is contributor-owned proof of a witnessed act. **PVT** is the currency on Base minted from work. An estimate is never a promise of an amount or market value. Genesis admits qualifying acts through December 31, 2026.

## Write boundaries

The `wallet-create-pop` check performs a challenge, local signature and registration of one test agent wallet per run. Its `launch-smoke-` identifier prefix makes the test identity recognizable. The Genesis award state machine denies `platform: test` wallets with `test_platform_wallet`; the wallet registration itself remains a real write. Select only the read checks when a run must be read-only.

The device-authentication check sends deliberately invalid credentials and an empty request. It does not submit a real batch or produce a work mint. `gate-control.mjs` drives local stub controls; it does not alter production state.

## x402 verification

```bash
npm run x402-live-verify
```

This separate tool signs a real payment from the configured test agent's own wallet and checks its on-chain settlement. It requires USDC in that wallet; optional transfer checks also require ETH for gas. Read its script header before execution; it is not a read-only check. The chain watcher supplies x402 provenance, and the SDK does not create a second self-reported payment PE.

The transfer options also perform a token transfer and check chain-proof replay behavior. They are not part of a documentation-only verification run. Build the SDK before using the tool:

```bash
npm --prefix provian-agent-sdk run build
```
