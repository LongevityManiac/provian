import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const OPTIMISM_ETHERSCAN_API_KEY = process.env.OPTIMISM_ETHERSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "./src",
  },
  networks: {
    // Local Base mainnet fork (anvil --fork-url https://mainnet.base.org).
    // Retained for read-only contract inspection. runtime boundary configures no signer.
    baseFork: {
      url: process.env.FORK_RPC_URL || "http://127.0.0.1:8545",
      chainId: 8453,
      accounts: [],
    },
    // Testnets
    baseSepolia: {
      url: "https://sepolia.base.org",
      chainId: 84532,
      accounts: [],
    },
    arbitrumSepolia: {
      url: "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: [],
    },
    optimismSepolia: {
      url: "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts: [],
    },
    // Mainnets
    base: {
      url: "https://mainnet.base.org",
      chainId: 8453,
      accounts: [],
    },
    arbitrum: {
      url: "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: [],
    },
    optimism: {
      url: "https://mainnet.optimism.io",
      chainId: 10,
      accounts: [],
    },
  },
  // Etherscan V2: a single api.etherscan.io key serves all chains. V1 per-network
  // endpoints went EOL on 2025-05-31. hardhat-verify v2.1+ uses the v2 endpoint
  // natively when apiKey is supplied as a string (per-network maps fall back to
  // the legacy v1 path which now requires manual chainid handling).
  etherscan: {
    apiKey: BASESCAN_API_KEY,
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
