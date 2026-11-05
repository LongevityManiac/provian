# Current chain configuration

The kernel and institution addresses come from `contracts/deployments/base-pvt9-institutions.json`; the complete kernel ABI and policy bindings come from `config/pvt9-base.json`.

| Base contract | Address |
|---|---|
| PVT9 kernel | `0x8811441914381143b9408c5C32247367F86F173A` |
| Eligibility verifier | `0xb26Fd9d4f3b42911592B96270e8437287DE33406` |
| escrowV4 | `0x96560fDF49e563eFCdc2d502934676DC074732d0` |
| promiseV3 | `0x7506F4A052750260A0ddcdF5E63a77CC646d89B9` |
| poolV3 | `0x1301BF63Cb6BaE7171f6c7D895C762B243964d26` |
| bondPool | `0x6b09E9C72316De9d62d63f09B187d4c86bBf787E` |
| courtV2 | `0x9a326D1ff5EC97cE466CF6fc71BA6f5372E41D7f` |

USDC escrow is available on the configured chains. Arbitrum and Optimism defaults come from `contracts/deployments/arbitrum-live.json` and `contracts/deployments/optimism-live.json`. PVT principal uses the live Base kernel. Per-chain environment overrides are resolved by `provian-backend/src/core/agent-bank/chain-registry.ts`.

Standard earnings settle on a schedule Provian sets, currently every 30 days per payee from their last standard settlement UTC date; Genesis grants settle daily. Epoch issuance stays in Fixed mode with 7.5M Genesis and 10M combined PVT ceilings. While the protocol is operated, supply expands as work enters the network, with no fixed total-supply cap. Genesis admission is open through December 31, 2026.

The device batch anchor is on Base. Presenters carry their PEs and inclusion proofs. Runtime forbidden-address lists and the predecessor burn cutoff remain enforced; retired addresses cannot become live SDK targets. `contracts/deployments/base-retired-addresses.json` contains only the address blacklist used by that resolver.

Base transaction handling supports Denim’s faster block cadence. Wallet nonces follow canonical chain state with explicit recovery of saved transactions; server signers have one durable writer per key. Discovery uses dRPC with independent Alchemy confirmation. Recovery windows and lag measurements use block timestamps. Twelve-confirmation monetary evidence and one-block presentation-benefit acceptance retain their existing separate roles.
