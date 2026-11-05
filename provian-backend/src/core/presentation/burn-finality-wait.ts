/**
 * schedule a burn's verifier call instead of polling for it blind.
 *
 * A PVT burn is decided ONLY by `verifyEvmPvtBurn` (both operator-bound RPC legs in exact
 * agreement): at one-block inclusion when the relay accepts it, and at
 * Base economic finality (12 confirmations) when the finalizer confirms or revokes it. This module
 * never decides anything about a burn. It answers one scheduling question — "is it worth asking the
 * verifier yet?" so the relay calls the verifier the moment the burn reaches the depth it needs
 * (1 to accept, 12 to finalize), instead of sleeping blind between refused attempts.
 *
 * It reads through ONE leg, the secondary (`BASE_RPC_URL_SECONDARY`, the free independent
 * endpoint), so waiting adds no metered calls: the metered two-leg read happens only when the
 * probe says the depth has arrived. A probe that lies or errors can only make the verifier run
 * early (it refuses, and the loop tries again) or late (bounded by the caller's deadline); it can
 * never make a burn verify.
 */

import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from '../onchain/economic-constants';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { timeBurnStep } from '../onchain/burn-timing';

/** Probe cadence while the burn is not yet visible, or when the window is imminent. */
export const FINALITY_PROBE_INTERVAL_MS = 250;

/** The one-leg reads the scheduler needs. Never used to decide a verdict. */
export interface FinalityProbe {
  /** The block the tx was included in, or null when no receipt is visible yet. */
  receiptBlock(txHash: string): Promise<number | null>;
  headBlock(): Promise<number>;
}

function parseHexQuantity(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/** The production probe: the secondary (free, independent) operator-bound Base leg. */
export function secondaryLegFinalityProbe(): FinalityProbe {
  const leg = getOperatorBoundRpcLegs('base')[1];
  return {
    async receiptBlock(txHash) {
      const r = await timeBurnStep(`discovery_${leg.operatorId}_receipt`, () => leg.provider.send('eth_getTransactionReceipt', [txHash])) as { blockNumber?: unknown } | null;
      if (!r) return null;
      return parseHexQuantity(r.blockNumber);
    },
    async headBlock() {
      const n = parseHexQuantity(await timeBurnStep(`discovery_${leg.operatorId}_head`, () => leg.provider.send('eth_blockNumber', [])));
      if (n === null) throw new Error('finality_probe_head_unreadable');
      return n;
    },
  };
}

export interface FinalityWaitOptions {
  readonly deadlineAtMs: number;
  readonly probe?: FinalityProbe;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /**
   * The depth to wait for (default: Base economic finality, 12). recording waits for
   * 1 — the burn MINED — and the finalizer waits for 12 before its own finality check.
   */
  readonly confirmations?: number;
}

/**
 * Wait until the probe sees the burn tx at `confirmations` depth (default finality: head ≥
 * inclusion + 11), or the deadline. Returns true when the window arrived, false at the deadline. Probe errors are treated
 * as "not yet" — the caller's verifier call is what decides, and it runs either way.
 */
export async function waitForFinalityWindow(txHash: string, opts: FinalityWaitOptions): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const depth = Math.max(1, Math.floor(opts.confirmations ?? BASE_ECONOMIC_FINALITY_CONFIRMATIONS));
  let probe: FinalityProbe;
  try {
    probe = opts.probe ?? secondaryLegFinalityProbe();
  } catch {
    return false;
  }
  const nap = async (ms: number): Promise<void> => {
    const left = opts.deadlineAtMs - now();
    if (left > 0) await sleep(Math.min(ms, left));
  };
  while (now() < opts.deadlineAtMs) {
    let included: number | null = null;
    let head: number | null = null;
    try {
      included = await probe.receiptBlock(txHash);
      if (included !== null) head = await probe.headBlock();
    } catch {
      await nap(FINALITY_PROBE_INTERVAL_MS);
      continue;
    }
    if (included === null || head === null) {
      await nap(FINALITY_PROBE_INTERVAL_MS);
      continue;
    }
    const blocksShort = included + depth - 1 - head;
    if (blocksShort <= 0) return true;
    // A block count is never converted to elapsed time. The same seconds-based
    // probe cadence works before, during and after a chain cadence change.
    await nap(FINALITY_PROBE_INTERVAL_MS);
  }
  return false;
}
