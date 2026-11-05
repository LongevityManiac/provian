# Reference Contract Pattern

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

## Overview

Provian's reference smart contracts are the "first email client, not the email protocol." They are battle-tested, Court-integrated, PE-generating defaults that anyone can use - or fork and modify.

## The Pattern

1. Provian designs PE action types for an institution domain
2. Provian deploys reference smart contracts that:
   - Emit on-chain events that the relay witnesses into contributor-owned PEs
   - Include PVT fee sinks that self-burn via `IPVTBurnable.burn(amount)` — each sink burns PVT it already holds in its own balance; PVT9 implements no `protocolBurn` and no `setProtocolContract`, so there is no registration step
   - Integrate with the Court for dispute resolution
   - Are verified and source-published on block explorers (on-chain contract source is public by nature)
3. Provian ships a reference Commons client for that institution. The client/UI is Provian's proprietary reference implementation; the PE action types and the verified contracts are open, so anyone can build their own client against them.
4. The ecosystem forks the open contracts, specializes, or builds alternative clients on the open PE protocol
5. The PE protocol earns from all implementations via the 0.5% minting split
6. Provian's reference contracts earn from users who choose the battle-tested defaults

## Reference Contract Fee Philosophy

Reference contracts include small PVT fees burned via `IPVTBurnable.burn(amount)` — an ungated self-burn of PVT the contract already custodies (pulled in via `transferFrom`, or held as pooled/locked balance). These fees are:

- **Transparent** - visible in the contract source and documented
- **Optional** - anyone can fork the contract and remove them
- **Asset-specific** - PVT fees are burned; USDC protocol fees go to the fee wallet
- **Irreversible** - a burn reduces supply; it promises no market benefit
- **Small** - never more than the value of using the battle-tested, Court-integrated default

## Existing Reference Contracts

| Contract | Fee Mechanism | Burn Path |
|----------|--------------|-----------|
| ProvianEscrowV4 | 0.5% PVT fee burned when a PVT escrow is funded (a USDC escrow pays its fee to the fee wallet instead) | `burn` (IPVTBurnable self-burn) |
| ProvianPromiseV3 | 0.25% PVT fee on promise settlement | `burn` (IPVTBurnable self-burn) |
| ProvianPoolV3 | 0.5% PVT fee on pool execution | `burn` (IPVTBurnable self-burn) |
| ProvianCourtV2 | Self-burns forfeited collateral, forfeited reward shares, reward dust, and unclaimable rewards (holds `IPVTBurnable immutable pvt`) | `burn` (IPVTBurnable self-burn, 5 sites: ProvianCourtV2.sol:1007/1041/1065/1089/1157) |

## Institution status

Court/Disputes, Voting, Compute market and Insurance are not open. Performance bonds and bond-claim lifecycle use the deployed BondPool contract.

## Economic Model

Two revenue mechanisms for any institution:

1. **PE minting floors (immutable)**: Every mint applies the immutable 0.5% Provian cut and the 0.5% human/Genesis Foundation floor. Human-resolving and Genesis mints therefore use the 99/0.5/0.5 split. For an agent-side mint without a verified human beneficiary, the Foundation rate may adjust prospectively under authorized policy but never below that floor; the contributor receives the residual. Work mints and the bookkeeping around it does not; every act of work mints PVT once at its best-supported value. This boundary is constitutional and contract-enforced.

2. **Reference contract fees (optional)**: Reference contracts include `burn` self-burn fee structures (`IPVTBurnable.burn`). Anyone can fork and remove them. The reference contracts are the defaults because they are battle-tested, Court-integrated, and PE-generating.
