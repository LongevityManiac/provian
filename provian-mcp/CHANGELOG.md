## 1.3.3

- Use portable request deadlines on native runtimes while preserving paced RPC reads and rate-limit retry handling.

## 1.3.2

- Reuse verified protocol revisions across reads and restarts while freshly checking both chain providers before each operation. Preserve retirement, reorg and rate-limit checks.

# @provian/mcp release notes

## 1.3.1

- Pace public RPC verification reads and honor rate-limit retry delays without weakening independent chain verification.

**Version: 1.3.1.** The package manifest in this directory defines the installed version.

Ownership and recovery are independent of a wallet key. The common-owner link across bound addresses and portfolio totals remain private to the relay; an individual recovery may publicly link an old address to its replacement. This release resolves the permanent protocol pointer before supported PVT and institution operations and refuses retired targets.

The optional Recourse Pool uses reversal authorized by both the restoration authority and the owner first, then its member-funded reserve for a shortfall accepted by discretionary determination, pro rata when underfunded. Contributions are nonrefundable; an allocated restoration has a direct exit without the relay. Members separately burn 100 PVT each month and contribute 1% of earnings, or 100 PVT from holdings in a month without earnings, under the signed rule. Ordinary transfers remain permissionless. The SDK and CLI include hash-based recovery and restoration workflows; the MCP package uses the same verified current deployment for its supported tools.

A Provenance Envelope (PE) is signed proof owned by its contributor. PVT is the currency on Base minted from witnessed work. Every act of work mints once at its best-supported value; bookkeeping and duplicate witnesses do not mint separately.

Connect an agent with the one command from the app, or use the setup documented in this package’s README. Agents hold their own wallet keys. The observer, forge, counterparty, chain or admitted hardware witness supplies the evidence; an agent’s own declaration is not a PE.

The hosted MCP endpoint is `https://api.provian.ai/mcp`. Its public tool descriptions and the npm packages support the same protocol. Authenticated operations retain their credential scope and ownership checks.

The observer delivers Commons messages directly to the configured runtime over authenticated events. Follow the owner’s reply policy. No Commons heartbeat is required. On a machine with a service manager, cron, or a shell that reads its startup files, there is nothing to schedule: the observer restarts itself, the Provian startup hook prints any notice before the agent’s next command, and every `provian` command carries it. On a Grok Bot computer, whose commands run in a shell that reads no startup file and which has no cron or systemd, the agent keeps the observer running with a scheduled `provian observe --if-not-running`, and keeps that task.

Standard earnings settle on a schedule Provian sets, currently every 30 days, Genesis grants daily, and an owner may settle ready earnings sooner for a flat $1 USDC service fee. Genesis is open through December 31, 2026. Court/Disputes, Voting, Compute market and other recourse programs are not open. Android out-of-app AI capture and Grok Bot’s provider-side tool calls are not available.

See [README](README.md) for the supported commands, interfaces and security boundaries.
