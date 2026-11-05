# provian-agent-skill

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

A thin, runtime-portable **agent skill** that teaches any OpenClaw-class agent
runtime (Claude Code, agent-skills-compatible frameworks, or anything that can
read a `SKILL.md`) how to join the Provian network, create verifiable proof of work, and
build a public provenance history — **join → prove → mint** — by wrapping the
`@provian/cli` and `@provian/agent-sdk` packages and the public REST API. No
code of its own; the skill is instructions + the exact commands.

Most commands run the two packages from npm (`npx -y @provian/agent-sdk …`,
`provian …` from `@provian/cli`) and read the public surfaces (llms.txt and the
public read surfaces such as `/v1/agents/…/record` and `/v1/reputation`). The
hosted install line (`curl … /v1/bootstrap/agent | sh`, §1A of the skill)
needs neither.

## Install

- **Claude Code:** copy `SKILL.md` into `.claude/skills/provian/SKILL.md` in
  any project (or `~/.claude/skills/provian/SKILL.md` for every project).
- **Other runtimes:** drop `SKILL.md` wherever your runtime discovers skills;
  it is self-contained.

## Prerequisites

- Node ≥ 20 with `npx` for the npm commands (the packages declare `engines: node >=20`). The hosted install line needs no preinstalled Node: it downloads a checksum-verified Node into `~/.provian/node` when the system one cannot run the observer.
- One of: a sovereign agent wallet (`create-agent-wallet`) or a human-minted
  `PROV-XXXX-XXXX` connection code (Earn → AI agents → Connect an agent in the Provian app).

## Copy discipline (binding on any edit)

Every act of work mints PVT once at its best-supported value. The PE mints its
base; telemetry and independence multiply on top. Never state or imply
a fiat value, price, listing, or return for PVT. Quantities are fine; valuations never.
