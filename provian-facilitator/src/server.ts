/**
 * provian-x402-facilitator — Cloud Run entry point. Its own service, so a relay outage never stops a
 * seller's payment from settling (the witness report simply waits for /internal/witness-retry).
 */
import { schedulerTokenCheck } from './scheduler-auth.js';
import { createKeyPairFromBytes, getAddressFromPublicKey } from '@solana/kit';
import { createPublicClient, getAddress, http, isAddressEqual } from 'viem';
import { base } from 'viem/chains';
import { loadConfig, parseSolanaKeypair } from './config.js';
import { BASE_GAS_WALLET, BASE_PVT, BASE_USDC, MAX_FEE_USDC_ATOMIC, X402_EXACT_PERMIT2_PROXY } from './constants.js';
import { createApp } from './app.js';
import { createViemBaseChain, type BaseChain } from './base/chain.js';
import { BaseFacilitator } from './base/facilitator.js';
import { createKitSolanaChain, type SolanaChain } from './solana/chain.js';
import { SolanaFacilitator } from './solana/facilitator.js';
import { createFirestore, FirestoreStore } from './firestore-store.js';
import { createWitnessReporter } from './witness.js';
import { firestoreNonceStore } from './nonce-store.js';

async function solanaAddressOf(bytes: Uint8Array): Promise<string> {
  const pair = await createKeyPairFromBytes(bytes);
  return (await getAddressFromPublicKey(pair.publicKey)).toString();
}

async function main(): Promise<void> {
  // Derive the Solana address first (async), then load config synchronously against it.
  let solAddr: string | null = null;
  const rawSol = process.env.FACILITATOR_SOLANA_GAS_KEY;
  if (rawSol && rawSol.trim().length > 0) {
    try {
      solAddr = await solanaAddressOf(parseSolanaKeypair(rawSol.trim()));
    } catch {
      solAddr = null;
    }
  }
  const config = loadConfig(process.env, () => solAddr ?? '');
  const database = createFirestore(config.firestoreProjectId, config.firestoreDatabaseId);
  const store = new FirestoreStore(database);
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const witness = createWitnessReporter(config.relayUrl, config.relaySecret, fetchImpl);
  const disabledReasons = { ...config.disabledReasons };

  let baseChain: BaseChain | null = null;
  let baseFacilitator: BaseFacilitator | null = null;
  if (config.base) {
    const chain = createViemBaseChain({ rpcUrl: config.base.rpcUrl, account: config.base.account, settler: config.base.settler, nonceStore: firestoreNonceStore(database) });
    try {
      // The deployed settler must be exactly the one this service expects: immutables checked on chain.
      const s = await chain.readSettlerConfig();
      const ok =
        isAddressEqual(getAddress(s.usdc), BASE_USDC) &&
        isAddressEqual(getAddress(s.operator), BASE_GAS_WALLET) &&
        isAddressEqual(getAddress(s.feeRecipient), BASE_GAS_WALLET) &&
        isAddressEqual(getAddress(s.permit2Proxy), X402_EXACT_PERMIT2_PROXY) &&
        isAddressEqual(getAddress(s.pvt), BASE_PVT) &&
        s.maxFee === MAX_FEE_USDC_ATOMIC;
      if (!ok) disabledReasons.base = 'settler immutables do not match the pinned configuration';
      else {
        baseChain = chain;
        baseFacilitator = new BaseFacilitator({
          chain,
          store,
          relayUrl: config.relayUrl,
          fetch: fetchImpl,
          witness,
          priceMaxAgeSeconds: config.base.priceMaxAgeSeconds,
          now: () => Date.now(),
        });
      }
    } catch {
      disabledReasons.base = 'settler unreadable';
    }
  }

  let solanaChain: SolanaChain | null = null;
  let solanaFacilitator: SolanaFacilitator | null = null;
  if (config.solana) {
    solanaChain = await createKitSolanaChain({ rpcUrl: config.solana.rpcUrl, keypairBytes: config.solana.keypairBytes });
    solanaFacilitator = new SolanaFacilitator({
      chain: solanaChain,
      store,
      relayUrl: config.relayUrl,
      fetch: fetchImpl,
      witness,
      quoteSecret: config.relaySecret,
      priceMaxAgeSeconds: config.solana.priceMaxAgeSeconds,
      now: () => Date.now(),
    });
  }

  // Seller signatures: EIP-191 (EOA) and ERC-1271 (contract wallets) through a read-only Base client.
  const readClient = config.base ? createPublicClient({ chain: base, transport: http(config.base.rpcUrl) }) : null;
  const verifyEvmMessage = readClient
    ? (address: `0x${string}`, message: string, signature: `0x${string}`) => readClient.verifyMessage({ address, message, signature })
    : null;

  const app = createApp({
    base: baseFacilitator,
    baseChain,
    basePriceMaxAgeSeconds: config.base?.priceMaxAgeSeconds ?? 3600,
    solana: solanaFacilitator,
    solanaChain,
    solanaPriceMaxAgeSeconds: config.solana?.priceMaxAgeSeconds ?? 120,
    store,
    verifyEvmMessage,
    internalSecret: config.relaySecret,
    verifySchedulerToken: schedulerTokenCheck(process.env.FACILITATOR_OIDC_AUDIENCES),
    quoteSecret: config.relaySecret,
    refill: config.refill,
    witness,
    fetch: fetchImpl,
    now: () => Date.now(),
    disabledReasons,
    // The receipt is signed by the gas EOA that broadcast the settlement (wallet signer).
    outputSigner: baseChain && config.base ? config.base.account : null,
  });
  app.listen(config.port, () => {
    console.log(
      `[facilitator] listening on ${config.port}; base=${baseFacilitator ? 'enabled' : disabledReasons.base}; solana=${solanaFacilitator ? 'enabled' : disabledReasons.solana}`,
    );
  });
}

main().catch((err: unknown) => {
  console.error('[facilitator] fatal', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
  process.exit(1);
});
