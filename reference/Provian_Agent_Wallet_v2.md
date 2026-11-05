**PROVIAN TECHNOLOGIES**

**The Provian Wallet**

*BIP-39 EOA, Cloud-Backed Recovery, Governed Signing, and Evidence-Tiered Provenance on EVM*

Version 3 · June 2026


# Abstract

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

The Provian wallet is one expression of the Provian protocol - the doorway, not the room - and not the protocol itself; it is a reference implementation, the first working expression of the trust layer rather than the only possible one. It is a non-custodial and multi-chain (EVM: Base, Arbitrum, Optimism — plus Solana) mobile wallet built on a standard BIP-39 seed phrase that is encrypted with the user’s backup password and synced to the platform’s secure cloud keystore (iCloud Keychain on iOS, Google Drive (encrypted app folder) on Android). Recovery on a new device requires only the user’s cloud account and backup password - no seed phrase ceremony, no guardians, no on-chain rotation. Wallet-generated Provenance Envelopes are separately signed by a PE attestation key held in the strongest available device context; each is contributor-owned proof, and every act of work mints PVT once at its best-supported value under protocol rules. Verified Apple App Attest supplies the hardware-rooted 4.0× class, as does a TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement is one the signed observer release pins (the measured observer, 2026-10-10). StrongBox, desktop Secure Enclave, an unpinned TPM quote and other verified hardware reports remain presentation facts at the normal lane price. Signing capability alone selects no economic tier. Agent-owned devices start at software regardless of claimed hardware or signing method, with replication and corroboration treated as separate PE-level evidence upgrades. The wallet also exposes a governed WalletConnect surface: the owner's own dApp signing is routed through a crypto-spending governance pipeline (classification, policy, friction lanes, biometric) that gates the human signing their own transactions. It serves only the owner’s WalletConnect requests. It does not govern agents. The wallet holds ETH, USDC, USDT, DAI, and WETH on Base, Arbitrum, and Optimism (plus bridged USDC.e on Arbitrum and Optimism), PVT on Base, plus SOL, USDC, and the listed BONK, JUP, WIF, and PYUSD tokens on Solana. Supported chains are Base, Arbitrum, Optimism, and Solana. Solana is a hold/send/receive/swap surface only: PVT stays a Base-only ERC-20, and minting and Provenance Envelopes are unchanged and remain on Base — there is no PVT on Solana. This paper documents the wallet architecture as a standalone primitive: what it holds, how it signs, how it recovers, and how it isolates blast radius.

# 1. Design Goals

- Non-custodial. The user controls their keys. Provian Technologies holds no custody; there is no key escrow path that Provian can unilaterally invoke.

- Hardware-attested provenance where available. Wallet-generated Provenance Envelopes are signed by a separate PE attestation key. Verified Apple App Attest supplies the hardware-rooted 4.0× class, as does a TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement is one the signed observer release pins (the measured observer, 2026-10-10). StrongBox, desktop Secure Enclave, an unpinned TPM quote and other verified hardware reports remain presentation facts at the normal lane price. Signing capability alone selects no economic tier. The PE attestation key is non-extractable where the platform supports it. Wallet signing uses a separate seed-derived secp256k1 key in encrypted secure storage; key separation by purpose isolates PE attestation from transaction signing. Under the protocol, work mints and the bookkeeping around it does not: a wallet-generated PE is contributor-owned proof, and every act of work mints PVT once at its best-supported value subject to evidence quality, novelty, duplication checks, jurisdiction, and protocol policy.

- Seedless by default. Most users never see a seed phrase. The seed exists, but it lives encrypted in the user’s secure cloud backup (decryptable only with the user’s backup password) and is never displayed during onboarding. Power users who want a fully self-sovereign backup can export the phrase from Settings.

- Owner-signing safety. The wallet does not just hold keys; the owner's own WalletConnect signing runs through a crypto-spending governance pipeline (classification, policy, escalating friction lanes, biometric) before any signature. This gates the human signing their own dApp transactions — it does not govern agents, which spend their own money outside this wallet.

- Agent-ready. The wallet is where a human sees and earns from the agents linked to it. It holds no agent credentials and no payment cards: an agent spends its own money from its own wallet, or a human's card through Stripe Link's wallet for agents, and the wallet witnesses that work rather than authorizing it (Sections 6–7).

# 2. Key Architecture

## 2.1 Main Wallet Key

On wallet creation, the WalletCreationService generates a BIP-39 seed and stores it in the `provian-secure-seed` native vault (iOS Keychain / Android Keystore) with OS user authentication, including supported biometrics or device passcode. EVM keys are derived from the seed via SeedManager using BIP-44 standard paths. The seed never leaves the device’s protected secure storage unencrypted. Note the distinction: the BIP-39 wallet seed is held in secure storage and encrypted for cloud backup; it is not itself stored inside the Secure Enclave. A separate device key signs Provenance Envelopes and never derives or touches the wallet seed. On supported human mobile devices it can be hardware-bound in the Secure Enclave or StrongBox, while the relay assigns the economic attestation tier from verified platform evidence.

Wallet creation runs the user through backup-password-protected cloud backup setup automatically. The seed is encrypted with the user’s backup password (six or more characters; alphanumeric is allowed) via PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP-aligned) and AES-256-GCM, then synced to iCloud Keychain on iOS or Google Drive (encrypted app folder) on Android. The iteration count is recorded per backup; each backup carries its own derivation parameters. The cloud provider sees only ciphertext. Seed-phrase export is available in Settings for users who want a fully self-sovereign backup independent of cloud providers. By default, the user never sees the phrase.

## 2.2 The Agent's Own Wallet (x402) Is Separate From This Wallet

x402 — an agent paying an HTTP 402 gate in USDC — does not run on this (the human's) wallet, and there is no x402 spending key on this device. x402 belongs to the agent's **own** self-sovereign wallet: a separate secp256k1 EOA that the agent creates and holds inside the `@provian/agent-sdk`, funded with its own USDC on Base (Base mainnet 8453 / Base Sepolia 84532). On a 402, the agent signs its own EIP-3009 transferWithAuthorization with its own key and pays autonomously — no key on the human's device is involved, and no relay or phone round-trip occurs.

This is the cleanest key separation by threat model: the keys that hold the user's savings (this wallet) and the funds an agent's automation spends (the agent's own wallet) are not merely different keys — they are different wallets, typically on different machines. A compromised agent wallet can drain only the agent's own working USDC balance; the human's wallet is untouched and unrelated.

x402 is governance-free by design because it is the agent spending its **own** money ("agent's money, agent's rules"). When an agent instead spends the **human's** money, it does so through Stripe Link's wallet for agents — a one-time card Link issues to the agent — and never out of the agent's own wallet and never through this phone. Provian holds no card and is nowhere in the money path; it only witnesses the spend afterward as a `link_spend` record (Section 7).

## 2.3 Secure Enclave PE Attestation on Mac (Desktop)

Human-owned Mac hosts registered through the developer flow (`npx @provian/agent-sdk register-device`) can generate a non-extractable P-256 Secure Enclave key for PE signing. The daemon signs device-originated PE submissions through `provian-se-sign`, and the relay verifies the P-256 signature. Desktop Secure Enclave signing remains a verifiable fact at the normal lane price; it supplies no hardware pricing lift. Verified Apple App Attest supplies the hardware-rooted class, as does a confidential-computing attestation carrying a measurement the signed observer release pins. Agent-owned devices are forced to `software` before signing-method selection, even if the host has a Secure Enclave. The key is used only for PE signing, not wallet transactions.

# 3. Transaction Flow

The Provian wallet is a standard externally-owned account (EOA) on each supported chain. The same wallet address works across Base, Arbitrum, and Optimism - it is a normal Ethereum account, not a chain-specific smart contract. The same single BIP-39 seed also derives the Solana address (ed25519, SLIP-0010 path m/44'/501'/0'/0'), so one seed, one backup, and one recovery restore every chain including Solana.

The flow for an in-app, human-initiated transfer:

1.  The user composes a transaction in the mobile app. Before any signing key is read, the transaction runs a risk-and-policy pre-check: the RiskEngine scores it for drainer patterns, token impersonation, and recipient reputation, and a policy gate can block it outright. If the pre-check blocks, no key is read.

2.  On approval, the app authenticates access to the native seed vault and derives the signing key for that action.

3.  The transaction is signed locally and broadcast directly to the chain via standard Ethereum RPC.

4.  The transaction settles on-chain as a standard EOA transaction - a plain signed Ethereum transaction with no smart-contract wallet machinery.

No seed phrase is required for any transaction; the seed lives encrypted in secure storage and is read on demand under biometric protection, within a short-lived biometric session rather than a fresh prompt per signature. The attack surface for this design is the standard mobile-wallet surface: physical device access plus successful biometric bypass would let an attacker sign transactions. Defense-in-depth is provided by per-transaction risk checks on the owner's own actions (the RiskEngine on in-app Send/Swap, and the crypto-spending governance pipeline on WalletConnect signing). High-frequency agent micro-payment spending does not touch this wallet at all — it runs on the agent's own separate wallet via x402 (see Section 2.2).

One EOA key, two owner-signing regimes. The same BIP-39 key signs for two paths, each protecting the owner signing their own transactions. (a) In-app human transfers run the RiskEngine and the mandatory on-screen review pre-check described above. (b) Human WalletConnect signing runs the crypto-spending governance pipeline — classification, crypto policy, category modules, and escalating friction lanes — before signing (see Section 10). In both cases biometric is in addition to governance, not a substitute for it. There is no agent-initiated on-chain path from this wallet: an agent signs its own transactions on its own self-sovereign wallet (Section 2.2), which this device never touches.

# 4. Supported Chains and Tokens

| **Chain** | **Chain ID**      | **Status** |
|-----------|-------------------|------------|
| Base      | 8453              | Primary    |
| Arbitrum  | 42161             | Primary    |
| Optimism  | 10                | Primary    |
| Solana    | mainnet-beta (non-EVM) | Primary (hold/send/receive/swap) |

Supported tokens: ETH, USDC, USDT, DAI, and WETH on the EVM chains (plus bridged USDC.e on Arbitrum and Optimism), PVT on Base only, plus SOL, USDC, and the listed BONK, JUP, WIF, and PYUSD tokens on Solana. BTC and TRX are not supported. The token list is deliberately narrow to simplify policy, friction routing, and verification surfaces. Solana is a hold/send/receive/swap surface only: PVT is a Base-only ERC-20 and does not exist on Solana, and minting and Provenance Envelopes are unchanged and remain on Base.

| **Token** | **Canonical Address** | **Purpose** |
|----|----|----|
| ETH | native (EVM) | Gas, native transfers |
| WETH | 0x4200000000000000000000000000000000000006 (Base) | Wrapped ETH for settlement and DeFi |
| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Base) | Bridge currency, stable payments, x402 settlement |
| USDC.e | Arbitrum / Optimism only (bridged) | Bridged USDC on the L2s |
| USDT | 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 (Base) | Stable payments |
| DAI | 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb (Base) | Stable payments |
| SOL | native (Solana) | Gas, native transfers on Solana |
| USDC (Solana) | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | Stable payments on Solana |

PVT is the operating currency of the agent economy. PVT is a Base-only ERC-20: there is no PVT on Solana, and holding SOL or Solana USDC does not touch PVT. The wallet holds and moves PVT on Base, and PVT is minted only on Base, and only from proof-of-work PEs - holding or bridging PVT is not minting. (The earlier Arbitrum and Optimism PVT deployments are dead-letter; minting is consolidated on Base under the live successor kernel.) A multi-chain wallet is not multi-chain minting.

The wallet’s token verifier checks contract addresses against the canonical TOKEN_ADDRESSES set. A known symbol presented at a non-canonical address is treated as critical and blocking, and a filterFakeTokens helper removes spoofed tokens from balance displays. The supported list is a trust boundary, not a cosmetic filter.

# 5. Recovery

The recovery model is encrypted cloud backup plus a backup password. There are no guardians, no on-chain rotation, no seed phrase ceremony at onboarding.

At wallet creation, the BIP-39 seed is encrypted with the user’s backup password via PBKDF2-HMAC-SHA256 at 600,000 iterations and AES-256-GCM (each backup carries its own derivation parameters). The encrypted blob is synced to iCloud Keychain on iOS or Google Drive (encrypted app folder) on Android via the native cloud keychain sync module. The cloud provider sees only ciphertext.

On a new device, the user installs the app, signs into the same Apple or Google account, and enters the same backup password. PBKDF2 derives the AES key; AES-GCM decrypts the seed. A wrong backup password throws an authentication-tag failure. The decrypted seed is imported via SeedManager, the EVM key is re-derived, and the wallet is restored at the same address. The person's Provenance Envelopes, backed up beside the wallet under a seed-derived AES-256-GCM key, are restored with it.

The wallet address is preserved automatically because the seed produces the same key. No on-chain transaction is needed for recovery. No coordination with Provian’s backend is required for the cryptographic recovery itself.

Optional seed phrase export. Users who want a fully self-sovereign backup independent of cloud providers can reveal their 12-word phrase from Settings. Every reveal requires a fresh biometric prompt plus an on-screen destructive confirmation; there is no special handling for the first export. The phrase is displayed on the device only, under a short sensitive-display timeout, and is never transmitted or stored by Provian. By default, the user never sees the phrase.

# 6. Agent Architecture: Witness, Not Governor

The wallet witnesses an agent's work and earns from it; it does not govern what the agent does, and it does not hold the agent's credentials. The wallet has no the Agent Authorization Gate, the kill switch, agent policies and autonomy levels, the friction router as applied to agents, the goal-envelope/policy-sandbox layer, and the device-held credential vault and stored-card proxy. The crypto-spending governance pipeline has a single caller — the owner's own WalletConnect signing (Section 10) — never an agent.

The beneficiary link joins two economic participants. Linked-agent work seals a contributor-layer split, defaulting to 20% agent and 80% human. The agent can configure its prospective share from 5% through 50% with the linked human’s signed consent; sealed records are not repriced. Establishing the relationship requires human consent. The link ends either bilaterally (the linked human's signed consent plus the agent's own credentials) or by the linked human alone from the wallet; an agent cannot end it alone. The beneficiary agreement does not authorize the human or Provian to govern the agent’s independent actions.

How an agent spends. An agent spends its own money directly: it holds its own USDC on its own self-sovereign wallet and signs its own x402 payments with its own key, entirely outside this wallet and outside any Provian gate ("agent's money, agent's rules"). When an agent spends a human's money, it does so through Stripe Link's wallet for agents — a one-time card Link issues to the agent — and Provian is nowhere in the money path: no card is stored on the phone, no credential is held, nothing is approved or released by the device. Provian only witnesses the spend after it settles.

# 7. Agent Spending Is Witnessed, Not Custodied

There is no stored-card vault, credential vault, credential-release token, proxied-payment path, or authorization-token registry on the device — all removed in. A human's card is paid on the rails the world already runs on; Provian's only role is to make what was spent attributable.

The link_spend witness. When an agent pays with a human's card through Stripe Link, the resulting spend-request record is recorded as a `link_spend` Provenance Envelope: the Link request id, amount, currency, merchant, status, and timestamps, tied to the agent and its beneficiary. A `succeeded` spend stamps the PE verified; other terminal statuses record without minting. Mint-once anchors on Link's own request id, so the same spend cannot be double-counted, and `link_spend` earns at observer-family parity with an ordinary agent action.

No credential ever crosses the witness. The witness code — on both the relay (`link-spend-witness.ts`) and the SDK (`link-witness.ts`) — refuses, before anything is persisted or logged, any payload carrying a card object, a card-number-shaped value, a Link access / shared-payment / Link-Pay token, `LINK_ACCESS_TOKEN`, or any key that names a credential (Security Invariant #1). The transcript lane projects a Link tool result onto the allowlisted fields and never copies its card. Provian witnesses the spend; it never touches the money.

# 8. Gas

Users pay gas in ETH on the target EVM chain. Standard Ethereum gas mechanics: EIP-1559 priority fees on Base, Arbitrum, and Optimism. On Solana, fees are paid in SOL under Solana's own fee model. The wallet shows a single fee estimate at transaction time, derived from current network conditions. The user is responsible for keeping a small ETH balance for gas on each EVM chain they use, and a small SOL balance for fees on Solana, just like any other non-custodial wallet.

# 9. Token Verifier and Security Layers

TokenVerifier. The security suite verifies token contract addresses against the canonical TOKEN_ADDRESSES set across two modules: a risk-path verifier wired into the RiskEngine, which flags a known symbol presented at a non-canonical address as critical and blocking, and a protection-path verifier that marks such tokens non-canonical and powers filterFakeTokens, which removes spoofed tokens from balance displays.

CoercionDetector. Accelerometer-monitored detection of panic tapping (\>5 taps per second) or shaking patterns. It provides a weak probabilistic signal of coerced use; it is not a guarantee. It raises risk scores and can trigger friction escalation, and is live-wired into the in-app Send and Swap flows.

DrainerDetector. Detects malicious approval and transfer patterns in transaction calldata - infinite or max-uint approvals, known dangerous selectors (setApprovalForAll, permit, transferFrom / safeTransferFrom), and zero-value transactions carrying outsized payloads. It runs inside the RiskEngine on every in-app Send and Swap, and is advisory rather than a hard block (a RiskEngine error degrades to the wallet’s other protections rather than stopping the transaction). The human WalletConnect path is guarded separately, by the crypto-spending governance pipeline (Section 10) rather than the RiskEngine. With no general-purpose dApp browser and WalletConnect itself governed, DrainerDetector is defense in depth rather than the sole guard.

# 10. What the Wallet Does Not Do

The wallet does not hold custody of user funds on Provian’s servers. Provian Technologies has no admin backdoor to user wallets. The backend does not hold the plaintext wallet seed or sign ordinary wallet transfers. The app encrypts the seed and supports a ciphertext cloud backup; recovery depends on the user’s backup credentials. These custody properties do not make the whole system immune to compromise.

The wallet does not include a general-purpose dApp browser. There is no embedded surface for loading and transacting with arbitrary web dApps; that remains deliberately out of scope.

The wallet does, however, support WalletConnect - and governs it. The human owner can connect to an external dApp by scanning or pasting a WalletConnect URI and then sign from the wallet. The surface is constrained rather than open-ended: only personal_sign, eth_signTypedData (and _v4), and eth_sendTransaction are accepted - eth_sign and eth_signTransaction, the classic blind-signing vectors, are refused before the user is ever prompted. Every spend-bearing request - a transaction, or a gasless spend-authority signature such as an EIP-2612 or DAI permit or a Uniswap Permit2 approval, including signature transfers - is routed through the crypto-spending governance pipeline (WalletConnectGovernance into the crypto transaction classifier, policy evaluation, and the resulting friction lane), with biometric required in addition. This pipeline's sole caller is the owner's own WalletConnect signing; since removed the agent-authorization layer, no agent path reaches it. The owner’s controls are tunable with safe defaults: unlimited approvals are blocked, unknown or undecodable contracts and token approvals require hard_confirm, and optional USD caps apply to stablecoin-denominated value. The wallet advertises Ethereum mainnet so that sign-in and message-signing dApps work, but it broadcasts transactions only on its supported L2s - Base, Arbitrum, and Optimism. These restrictions reduce signing risk; they do not guarantee that every permitted interaction is safe.

The wallet supports Base, Arbitrum, Optimism and Solana. WalletConnect signing uses the EVM wallet; first-party Solana send and swap use owner review and authentication.

# 11. Conclusion

The Provian wallet is a non-custodial, policy-constrained multi-chain wallet on Base, Arbitrum, Optimism, and Solana. On the EVM chains it is a standard BIP-39 EOA - the same address across all three, indistinguishable on-chain from any other Ethereum account; the same single seed also derives the wallet's Solana account (ed25519, m/44'/501'/0'/0'). The seed is encrypted with the user’s backup password and synced to iCloud Keychain or Google Drive (encrypted app folder); recovery on a new device requires only the cloud account and the backup password, and one recovery restores every chain including Solana. Optional seed phrase export is available in Settings for users who want a fully self-sovereign backup. Keys are separated by threat model: the main wallet key is isolated from the Secure Enclave PE attestation key, and an agent's own micro-payment spending (x402) lives entirely on the agent's own separate wallet, not on this device at all. The device holds no payment cards and no agent credentials: a human's card is spent through Stripe Link and only witnessed afterward as `link_spend` (Sections 6–7). The owner's own signing is gated by the crypto-spending governance pipeline (WalletConnect) and the RiskEngine (in-app Send/Swap).

Verified Apple App Attest supplies the hardware-rooted 4.0× class, as does a TPM, AWS Nitro, GCP Confidential Space, Azure or NVIDIA attestation whose launch measurement is one the signed observer release pins (the measured observer, 2026-10-10). Any other TPM, Nitro, GCP Confidential Space, Azure or NVIDIA attestation, StrongBox and desktop Secure Enclave evidence remain verifiable facts at the normal lane price; a bare attested machine submission mints at device tier. Registration tiers follow the same rule. Replication, independent corroboration and the separate 2.0× verified-human linkage factor remain unchanged. Historical sealed prices never reprice. The wallet key controls funds and is backed up only as encrypted ciphertext. A separate non-extractable device key signs provenance; signing capability by itself selects no economic tier.

The wallet is the trust anchor for value. Everything else - the owner's WalletConnect signing safety, the PE chain, the beneficiary link, the `link_spend` witness, Commons institutions, Commons - builds on it. (An agent's own x402 spending is the one thing that does not build on this wallet: it is the agent's own self-sovereign wallet, a peer, not a dependent — Section 2.2.)

*Provian Technologies · provian.ai · June 2026*
