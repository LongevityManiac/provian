# Current chain configuration

PVT10 is the current successor token on Base; its on-chain version label is `v10`.
Its name and symbol remain Provian Value Token and PVT. Resolve the live kernel
and institutions from the permanent protocol pointer `0x619eae740ce56c5a8edbb2b047e58369281ddad7` using the
runtime pin in `config/protocol-pointer.json` and independent RPC agreement.
Never substitute a predecessor address when discovery fails.

`contracts/deployments/base-pvt9-institutions.json` and `config/pvt9-base.json`
retain predecessor deployment and ABI records. The PVT9 kernel
`0x8811441914381143b9408c5C32247367F86F173A` is retired, not the live kernel.

USDC escrow is available on the configured chains. Arbitrum and Optimism defaults come from `contracts/deployments/arbitrum-live.json` and `contracts/deployments/optimism-live.json`. PVT principal uses the live Base kernel. Per-chain environment overrides are resolved by `provian-backend/src/core/agent-bank/chain-registry.ts`.

Standard earnings settle on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date; Genesis grants settle daily. Epoch issuance stays in Fixed mode with 7.5M Genesis and 10M combined PVT ceilings. While the protocol is operated, supply expands as work enters the network, with no fixed total-supply cap. Genesis admission is open through December 31, 2026.

The device batch anchor is on Base. Presenters carry their PEs and inclusion proofs. Runtime forbidden-address lists and the predecessor burn cutoff remain enforced; retired addresses cannot become live SDK targets. `contracts/deployments/base-retired-addresses.json` contains only the address blacklist used by that resolver.

Base transaction handling supports Denim’s faster block cadence. Wallet nonces follow canonical chain state with explicit recovery of saved transactions; server signers have one durable writer per key. Discovery uses dRPC with independent Alchemy confirmation. Recovery windows and lag measurements use block timestamps. Twelve-confirmation monetary evidence and one-block presentation-benefit acceptance retain their existing separate roles.
