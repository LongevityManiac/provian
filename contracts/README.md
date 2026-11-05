# Provian smart contracts

A **Provenance Envelope (PE)** is signed proof owned by the contributor whose act was witnessed. **PVT** is the ERC-20 currency on Base minted from witnessed work. Work mints once at its best-supported value; non-work bookkeeping and duplicate witnesses do not mint separately.

## Base contract registry

The checked-in deployment source is `deployments/base-pvt9-institutions.json`; the kernel ABI and runtime bindings are in `../config/pvt9-base.json`.

| Contract | Address | Role |
|---|---|---|
| ProvianPVT9 | `0x8811441914381143b9408c5C32247367F86F173A` | Token and settlement kernel |
| ProvianPVT9EligibilityVerifier | `0xb26Fd9d4f3b42911592B96270e8437287DE33406` | Approves exact settlement batches |
| ProvianEscrowV4 | `0x96560fDF49e563eFCdc2d502934676DC074732d0` | PVT/USDC escrow and timeout refunds |
| ProvianPromiseV3 | `0x7506F4A052750260A0ddcdF5E63a77CC646d89B9` | Agent lending promises |
| ProvianPoolV3 | `0x1301BF63Cb6BaE7171f6c7D895C762B243964d26` | Threshold pools, target execution and refunds |
| ProvianBondPool | `0x6b09E9C72316De9d62d63f09B187d4c86bBf787E` | Performance bonds |
| ProvianCourtV2 | `0x9a326D1ff5EC97cE466CF6fc71BA6f5372E41D7f` | Arbitration mechanics |
| ProvianPEAnchor | `0x889A59A847e490c5Cc91f281468AbAacc100a9fD` | Daily accepted-batch Merkle roots |

Court/Disputes and Voting are not open. Escrow disputes use the existing party-only admin resolution or the permissionless depositor refund after the contract’s 30-day dispute timeout.

## Minting and authority

`settleStandardPEBatch` settles work, and `settleGenesisPEBatch` settles exact fixed grants. Claim, batch and cursor checks enforce mint-once. Standard earnings settle on a schedule Provian sets, currently every 30 days and Genesis grants daily. An owner may request their ready earnings sooner for a flat $1 USDC service fee through the relay.

Human-resolving standard mints and all Genesis grants split 99% contributor / 0.5% Provian / 0.5% Foundation. `PROVIAN_BPS = 50` and `HUMAN_FOUNDATION_BPS = 50` are immutable. For an agent mint without a verified human beneficiary, the prospectively scheduled Foundation rate may be higher, and the contributor receives the residual. Each act keeps the beneficiary split sealed when that act was first registered; changes apply only to later acts.

Supply expands as work enters the network, with no fixed total-supply cap. Read the live figure from `totalSupply()` on Base. Seven-day epochs use Fixed issuance ceilings of 7.5 million Genesis and 10 million combined PVT. The live rate is `getEpochPolicy(lastOpenedEpoch).mintRate / 1e18`.

Genesis admits qualifying acts through December 31, 2026: 75 PVT gross for human wallet creation, 75 for each agent’s wallet creation, and 25 for each device link, with a 500-PVT gross lifetime ceiling per wallet. Grants are exact inputs independent of the standard mint rate.

Provian Technologies, LLC administers the kernel through its bootstrap wallet, `0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3`. `BOOTSTRAP_ADMIN` is a compile-time constant. Operational minter and verifier roles are bounded and revocable. Policy schedules take effect prospectively by epoch. There is no owner, proxy, admin transfer or renunciation path, or governance controller in the kernel’s authority path.

## Institutions and custody

The institutions bind the kernel and their counterpart contracts through constructor immutables and one-time setters. They cannot be repointed by repeating those setters.

- **Escrow:** PVT and USDC principal; 0.5% protocol fee. PVT fees burn and USDC fees go to Provian’s fee wallet. Dispute resolution can pay only the original recipient or refund the depositor. An unresolved dispute has a 30-day timeout refund.
- **On-chain promises:** 0.25% of settlement; PVT fees burn and USDC fees go to the fee wallet. Human informal promises in the mobile app are a separate signed, encrypted relay feature.
- **Capital pools:** 0.5% of execution; PVT fees burn and USDC fees go to the fee wallet. The admin may execute a funded pool only to its creator-fixed target or refund contributors. Anyone may refund an unexecuted pool after its deadline. Pools are an agent API feature.
- **Performance bonds:** posting burns 2% of the deposit and renewal burns 1% of the amount still bonded. Separate deposit and renewal fees are currently zero under the checked-in schedule. No admin drain exists. Exit paths are agent withdrawal, Court-authorized slash and abandonment under the contract rules. Agent bonds are collateral, not staking rewards.
- **Anchor:** one daily Merkle root commits accepted batches without publishing individual PE contents. Segmented days carry their segment index. Anchoring and mint settlement are separate operations.

Contract parameters use the existing bounded prospective setters. Arbitrator compensation pays arbitrators rather than becoming a protocol burn. Source and tests under `src/` and `test/` define every boundary.

## Build and verification

Run these commands from the repository root.

```bash
npm --prefix contracts install
npm --prefix contracts run compile
forge test --root contracts --force  # run from the repository root
```

The ABI consumed by the relay comes from the reviewed runtime binding. A deployment address alone grants no permission to mint or move another participant’s funds.

The contracts in this directory are MIT-licensed; see `LICENSE`.
