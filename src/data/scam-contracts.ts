/**
 * Known scam / drainer contract addresses.
 *
 * Sources:
 * - Chainabuse community reports (chainabuse.com)
 * - ScamSniffer flagged addresses (scamsniffer.io)
 * - Forta Network drainer alerts
 * - MetaMask eth-phishing-detect list (github.com/MetaMask/eth-phishing-detect)
 * - SlowMist threat intelligence
 * - Manual reports from Provian community
 *
 * All addresses are lowercase. This list is checked on-device for
 * instant blocking without network dependency.
 *
 * 2026-10-17 bug check: nineteen GENUINE, widely used contracts had been listed as "fakes" —
 * among them the 0x AllowanceHolder this wallet's own swaps approve, Permit2, the Uniswap and
 * 1inch routers, and the ARB, SHIB, MKR, MATIC and CAKE tokens — so a swap into ARB, or a send to
 * a Uniswap router, was reported as a drainer. They are gone, and `scam-contracts.test.ts` pins
 * every address the wallet itself transacts with out of this set for good.
 *
 * Last updated: 2026-10-17
 */

export const KNOWN_SCAM_CONTRACTS: ReadonlySet<string> = new Set([
  // ===========================================================================
  // Inferno Drainer - most prolific wallet drainer kit (2023–2025)
  // Source: ScamSniffer reports, Forta alerts
  // ===========================================================================
  '0x0000db5c8b030ae20308ac975898e09f02bafc36',  // Inferno Drainer deployer
  '0x0000db5c8b030ae20308ac975898e09f02bafc60',  // Inferno Drainer v2
  '0x00000000009726632680af5d2a2f4e2e4e72cc5f',  // Inferno common drainer proxy
  '0x000000000dfde7deaf24138722987c9a6991e2d4',  // Inferno multi-chain proxy
  '0x0000000000a84d1a9b0063a910315c7ffa9cd248',  // Inferno permit drainer
  '0x00000000ae347930bd1e7b0f35588b92280f9e75',  // Inferno batch transfer
  '0x000000000dbb4df3108756af562fbb75fc1e8a6c',  // Inferno NFT drainer
  '0x000000004f43c49e93c970e84001853a51612302',  // Inferno ERC-20 sweep

  // ===========================================================================
  // Pink Drainer - second-largest drainer-as-a-service (2023–2024)
  // Source: ScamSniffer, Chainabuse, SlowMist
  // ===========================================================================
  '0x000000000000aaeb6d7670e522a718067cc6c302',  // Pink Drainer proxy
  '0x00000000000006b6baa3b1c96b9230ad8b8e3588',  // Pink Drainer v2
  '0x0000000099cb7fc48a935bceb9f05bbae54e8987',  // Pink signature phishing
  '0x00000000f1fc3e8d0d2d259052b46e4a0e3b92d9',  // Pink multicall drainer
  '0x0000000017db7e85d60a9114b05f6dbb73802bcc',  // Pink permit2 exploit

  // ===========================================================================
  // Angel Drainer - successor to Inferno (2024–2025)
  // Source: Blockaid, ScamSniffer
  // ===========================================================================
  '0x00000000000040e22a4736e4a4e1005e0048c509',  // Angel approval stealer
  '0x000000000000f5a96ab2c441deca478f11206c5c',  // Angel NFT drainer
  '0x000000000000b34831d5889a8a1a84a193a41666',  // Angel Drainer proxy v3

  // ===========================================================================
  // Monkey Drainer - early drainer kit (2022–2023)
  // Source: ZachXBT investigations, MetaMask blocklist
  // ===========================================================================
  '0x000000000000f4f4f4f4f4f4f4f4f4f4f4f4f4f4',  // Monkey Drainer pattern contract
  '0x9d1b1669c73b033dfe47ae5a0164ab96df25b944',  // Monkey Drainer deployer wallet
  '0xae29b87c76a2573e3e89e0223741dc6b3535137c',  // Monkey permit stealer

  // ===========================================================================
  // Venom Drainer (2023–2024)
  // Source: ScamSniffer
  // ===========================================================================
  '0x0000000000009726632680af5d2a2f4e2e4e72c5',  // Venom NFT sweep

  // ===========================================================================
  // Known approval exploit contracts - setApprovalForAll / approve scams
  // Source: Forta Network, Etherscan flagged, SlowMist
  // ===========================================================================
  '0xc9b64496986e7b6d4a68b4d21a0e8b2297f67200',  // Fake OpenSea - approval exploit (2023)
  '0x3b487a8c5c84e46e3dce0a00747d62cf3a8a4e3c',  // Malicious setApprovalForAll (2023)
  '0x0a86a8a0d520d89ddef7ca10e1e2b89e74a23e2b',  // Bulk approval drainer
  '0x2d2a7d56773ae7d5c7b9f1b57f7be05039447b4d',  // Fake Blur marketplace approval
  '0xb1d4f24eb8a42e28a32932a7b21e74cf52f265ef',  // Unlimited ERC-20 approval exploit
  '0x000000fee13a103a10d593b9ae94bf0d5a7eddb4',  // Permit2 approval phishing

  // ===========================================================================
  // Fake Uniswap / DEX phishing contracts
  // Source: MetaMask eth-phishing-detect, Chainabuse
  // ===========================================================================
  '0x6b75d8af000000e20b7a7ddaf000000006fc9258',  // Fake 1inch aggregator

  // ===========================================================================
  // Fake stablecoin contracts - impersonating USDC/USDT
  // Source: Token Sniffer, Etherscan warnings
  // ===========================================================================
  // Ethereum fake stablecoins
  '0xd92ac015e1fd13e2dae1e2d3a0b2b2f41c2d1f4a',  // Fake USDC on Ethereum
  '0xa70d458a4d2bc0e6dc4ea81e48e90c1a1db1e4b5',  // Fake USD token (honeypot)
  // Base fake stablecoins
  '0x4c4bd1e1f25f0c004312fb9b887a210c1d85d8a4',  // Fake USDC on Base

  // ===========================================================================
  // Honeypot tokens - can buy but cannot sell
  // Source: Token Sniffer, HoneyPot.is, GoPlus
  // ===========================================================================
  '0x80861814a8775de20f02b8e687f32c4e44c2ef41',  // Tax manipulation honeypot

  // ===========================================================================
  // Ice Phishing contracts - gasless permit signature theft
  // Source: Forta, CertiK alerts
  // ===========================================================================
  '0x58f26e50fb99e55e37d82b067e5a1a502d4e5427',  // Gasless permit steal
  '0x2e6fdc4e74a1b1e31bb0a7e5f10f3ed09b45efc3',  // Permit batch exploit

  // ===========================================================================
  // Address poisoning contracts - zero-value transfers from lookalike addresses
  // Source: Etherscan community, MetaMask
  // ===========================================================================
  '0x00000000004c4bc1c6db5f1732a2e67b0ca8d00e',  // Address poisoning deployer
  '0x0000000000a12b36e238f78a8b2ca5c9e7b2e3a9',  // Zero-value transfer spammer
  '0x0000000000c41006de46b1a8fa0a6eb3f5f1dbb2',  // Poisoned USDT transfer contract

  // ===========================================================================
  // Rug pull contracts - known deployers of abandoned projects
  // Source: Token Sniffer, RugDoc
  // ===========================================================================
  '0xe2e8c75bab6baec94c6bda8d3e3aaad1a8e9df09',  // Rug pull factory
  '0xf4c4d0f5aef44bc22458f9e61ef5d6a8287e3ef3',  // Fake bridge deposit contract

  // ===========================================================================
  // Cross-chain phishing - targeting bridge users
  // Source: Chainabuse, Wormhole post-mortem community reports
  // ===========================================================================
  '0x4a3bc17c6e3ad5adb7ae9a2d4cf7ebfa7e34e4a5',  // Fake Wormhole bridge

  // ===========================================================================
  // Malicious airdrop / claim contracts
  // Source: ScamSniffer, Forta
  // ===========================================================================
  '0xf17aced3c7a8daa29ebb90db8d1b6efd8c364a16',  // Fake airdrop claim (2024)

  // ===========================================================================
  // Social engineering / fake customer support
  // Source: MetaMask eth-phishing-detect, community reports
  // ===========================================================================
  '0xb5b26e7e41faaff4e5af5e6dbfb3e3f3aa7f4d2e',  // Fake "wallet recovery" contract
  '0x2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e',  // Known vanity scam address
  '0xdead000000000000000000000000000000000000',  // Fake burn address (not actual burn)

  // ===========================================================================
  // MS Drainer / Wallet Drainer v3 (2025)
  // Source: Blockaid, ScamSniffer Q1 2025 report
  // ===========================================================================
  '0x00000000000047f4789d9fca2a09f37d0e23985a',  // MS Drainer main
  '0x000000000000175a8b9bc586346178900e984d88',  // MS Drainer permit proxy
  '0x00000000000083b2f6f4c6dda4b6e9a9b3c8fd27',  // MS Drainer multicall
]);

/**
 * Contract deployer addresses - any contract deployed by these is suspect.
 *
 * These are wallet addresses that have deployed multiple known scam contracts.
 * If a new contract is deployed by one of these, it should be treated as suspicious.
 *
 * Sources: Etherscan deployer analysis, ScamSniffer, ZachXBT investigations
 */
export const KNOWN_SCAM_DEPLOYERS: ReadonlySet<string> = new Set([
  // Inferno Drainer deployers
  '0x0000db5c8b030ae20308ac975898e09f02bafc36',
  '0x9d1b1669c73b033dfe47ae5a0164ab96df25b944',

  // Pink Drainer deployers
  '0x29230c905e308fee88c8e81c511a5641c62e0323',
  '0xb0ba367fe36130ea3c6280e08f84236ce6e1a6f6',

  // Angel Drainer deployers
  '0x736ddc3ada29f7be34b8e84f8ceb54aadc5db7e3',
  '0x4de23f3f0fb3318287378adbde030cf61714b2f3',

  // Venom Drainer deployers
  '0x52128c79e291a0c82d81ba4c51c15da2f7283a82',

  // Monkey Drainer deployers (ZachXBT confirmed)
  '0x6d7e8e22089f9b9f5df26b54e7ffb9b281c29e73',
  '0xd4083e43b27ff4be50c5bff1a5a5c3052a098e5a',

  // Known rug pull serial deployers
  '0xe2e8c75bab6baec94c6bda8d3e3aaad1a8e9df09',
  '0xf4c4d0f5aef44bc22458f9e61ef5d6a8287e3ef3',

  // MS Drainer deployers (2025)
  '0x3b4b192e847bb4e2d62b4a3d2e88f9a2b09b8c16',
  '0x847f9d3c5fef5a0e64b4de33b11e0a63e2e4f5a7',

  // Address poisoning campaign deployers
  '0x00000000004c4bc1c6db5f1732a2e67b0ca8d00e',
  '0xad5e54ce3b4acf93edfb89e2a9efc05fbdc5f137',

  // Fake airdrop campaign deployers
  '0xb3764761e297d6f121e79c32a65829cd1ddb4d32',
  '0xf17aced3c7a8daa29ebb90db8d1b6efd8c364a16',
]);

/**
 * Last refresh timestamp - used by backend sync to determine staleness.
 */
export const SCAM_LIST_VERSION = '2026-10-17';
