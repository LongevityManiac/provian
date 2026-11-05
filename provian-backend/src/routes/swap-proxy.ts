/**
 * Swap proxy routes — the wallet app's three swap routes, each fee-bearing ON THE RELAY.
 *
 *   GET  /api/proxy/zerox/allowance-holder/quote   same-chain EVM (0x v2)
 *   GET  /api/proxy/lifi/quote                     cross-chain (LI.FI)
 *   POST /api/proxy/jupiter/order                  same-chain Solana (Jupiter), any SPL pair
 *
 * All three sit behind wallet auth. Each rebuilds the upstream request from an allowlist of the
 * client's routing fields, sets Provian's 25 bps fee itself (core/swap/swap-fees.ts), and refuses
 * to return an upstream answer it could not verify as carrying that fee to the named recipient.
 * The 0x proxy was a transparent pass-through until 2026-09-25; every other 0x path is now
 * refused so no fee-free 0x call can be made through the relay.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ResponseTooLargeError } from '../core/net/bounded-fetch';
import {
  SwapFeeError,
  PROVIAN_SOLANA_TREASURY,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_WSOL_MINT,
  LIFI_SOLANA_NATIVE_TOKEN,
  tokenAccountSize,
  LIFI_SOLANA_CHAIN_ID,
  SWAP_FEE_BPS,
  resolveEvmSwapFeeRecipient,
  buildZeroXQuoteQuery,
  verifyZeroXQuoteFee,
  buildLifiQuoteQuery,
  verifyLifiQuoteFee,
  parseJupiterOrderRequest,
  planJupiterFee,
  parseLookupTableAddresses,
  addFeeAccountCreation,
  buildJupiterQuoteQuery,
  JUPITER_ROOM_MAX_ACCOUNTS,
  verifyJupiterQuote,
  buildJupiterSwapBody,
  verifyJupiterTransaction,
  decodeSolanaTransaction,
  encodeSolanaTransaction,
  SOLANA_MAX_TX_BYTES,
  type ZeroXQuoteView,
  type LifiQuoteView,
  type JupiterQuoteView,
  type JupiterFeePlan,
  type SolanaMintInfo,
  type DecodedSolanaTx,
} from '../core/swap/swap-fees';
import {
  resolveAccountKeys,
  closedAccounts,
  addSimulationFunding,
  depositsFromSimulation,
  type ParsedInnerInstruction,
  listAccountOpenings,
  categorizeOpening,
  networkFeeLamports,
  summarizeSolanaCosts,
  type OpeningCategory,
  type SolanaSwapCosts,
} from '../core/swap/solana-swap-costs';

type FetchLike = (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Awaited<ReturnType<typeof fetch>>>;

export interface SwapProxyDeps {
  authenticate: (req: Request, res: Response, next: NextFunction) => unknown;
  checkProxyRateLimit: (userId: string, service: string, maxRequests: number) => Promise<boolean>;
  /**
   * Upstream fetch. Production passes server.ts `fetchWithTimeout`, which is BOUNDED
   * one deadline over connect + headers + body, body byte-capped, and the
   * returned Response already fully read — so the `.json()` reads below cannot block.
   */
  fetch: FetchLike;
  forwardUpstreamResponse: (res: Response, upstream: { ok: boolean; status: number }, body: unknown) => void;
  isUpstreamTimeout: (err: unknown) => boolean;
  env: Record<string, string | undefined>;
}

const RATE_LIMIT_PER_MIN = 10;

/**
 * A mainnet address holding far more SOL than any swap needs, named as the source of the
 * simulation-only credit (see computeSolanaCosts). Nothing is ever signed for it or sent; if it
 * ever runs short the simulation fails and the relay falls back to the top-level figures.
 * The first one not already a key of the transaction is used. Override with
 * SOLANA_SIMULATION_FUNDER.
 */
const DEFAULT_SOLANA_SIMULATION_FUNDERS = [
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
];
/** Credited on top of the SOL being swapped, so the simulated wallet can pay every cost. */
const SIMULATION_CREDIT_LAMPORTS = 10_000_000_000n;
const FEE_ACCOUNT_OK_TTL_MS = 10 * 60_000;

export function createSwapProxyRouter(deps: SwapProxyDeps): Router {
  const router = Router();
  const feeAccountVerifiedAt = new Map<string, number>();

  const fail = (res: Response, err: unknown, label: string): void => {
    if (err instanceof SwapFeeError) {
      if (err.status >= 500) console.error(`[SwapProxy] ${label} refused: ${err.code} ${err.message}`);
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (deps.isUpstreamTimeout(err)) {
      res.status(504).json({ error: 'Upstream timed out', code: 'UPSTREAM_TIMEOUT' });
      return;
    }
    // deps.fetch reads every upstream body under one deadline and a byte cap
    // (core/net/bounded-fetch.ts); an over-cap answer is aborted, never buffered.
    if (err instanceof ResponseTooLargeError) {
      res.status(502).json({ error: 'Upstream response too large', code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
      return;
    }
    console.error(`[SwapProxy] ${label} error:`, err);
    res.status(500).json({ error: 'Proxy request failed', code: 'PROXY_ERROR' });
  };

  const limited = async (req: Request, res: Response, service: string): Promise<boolean> => {
    if (!(await deps.checkProxyRateLimit(req.user!.id, service, RATE_LIMIT_PER_MIN))) {
      res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // 0x — same-chain EVM
  // ---------------------------------------------------------------------------
  router.get('/zerox/allowance-holder/quote', deps.authenticate, async (req: Request, res: Response) => {
    try {
      if (await limited(req, res, 'zerox')) return;
      const apiKey = deps.env.ZEROX_API_KEY;
      if (!apiKey) {
        res.status(503).json({ error: 'Service not configured', code: 'SERVICE_UNAVAILABLE' });
        return;
      }
      const recipient = resolveEvmSwapFeeRecipient(deps.env);
      const query = buildZeroXQuoteQuery(req.query as Record<string, unknown>, recipient);
      const upstream = await deps.fetch(`https://api.0x.org/swap/allowance-holder/quote?${query.toString()}`, {
        headers: { '0x-api-key': apiKey, '0x-version': 'v2' },
      });
      const body = (await upstream.json()) as ZeroXQuoteView & Record<string, unknown>;
      if (!upstream.ok) {
        deps.forwardUpstreamResponse(res, upstream, body);
        return;
      }
      const fee = verifyZeroXQuoteFee(body, { buyToken: query.get('buyToken')!, feeRecipient: recipient });
      res.json({ ...body, provian_fee: { bps: SWAP_FEE_BPS, amount: fee.feeAmount, token: fee.feeToken } });
    } catch (err) {
      fail(res, err, '0x quote');
    }
  });

  // Every other 0x path (price, permit2, arbitrary) is refused: the old pass-through let a client
  // call 0x through the relay with no fee at all.
  router.all('/zerox/*', deps.authenticate, (_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Only GET allowance-holder/quote is served; the relay sets the swap fee on it',
      code: 'ZEROX_PATH_REFUSED',
    });
  });

  // ---------------------------------------------------------------------------
  // Solana chain reads (shared by the LI.FI Solana-source and Jupiter routes)
  // ---------------------------------------------------------------------------
  const solanaRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const rpc = deps.env.ALCHEMY_API_KEY
      ? `https://solana-mainnet.g.alchemy.com/v2/${deps.env.ALCHEMY_API_KEY}`
      : 'https://api.mainnet-beta.solana.com';
    const r = await deps.fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: T; error?: unknown };
    if (!r.ok || j.result === undefined) {
      throw new SwapFeeError('solana_rpc_unavailable', `Solana RPC ${method} failed`, 503);
    }
    return j.result;
  };

  type ParsedAccount = {
    owner?: string;
    lamports?: number;
    space?: number;
    data?: { parsed?: { info?: Record<string, unknown> } } | [string, string];
  } | null;

  const parsedInfo = (a: ParsedAccount): Record<string, unknown> | undefined =>
    (a && !Array.isArray(a.data) ? a.data?.parsed?.info : undefined);

  /** Program, Token-2022 extensions and default-frozen state of each mint, read from chain. */
  const readMints = async (mints: string[]): Promise<Record<string, SolanaMintInfo | undefined>> => {
    const res = await solanaRpc<{ value: ParsedAccount[] }>('getMultipleAccounts', [
      mints,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const out: Record<string, SolanaMintInfo | undefined> = {};
    mints.forEach((m, i) => {
      const acct = res.value?.[i];
      if (!acct?.owner) return;
      const exts = (parsedInfo(acct)?.extensions as Array<{ extension?: string; state?: { accountState?: string } }> | undefined) ?? [];
      out[m] = {
        program: acct.owner,
        extensions: exts.map((e) => String(e.extension)),
        defaultFrozen: exts.some((e) => e.extension === 'defaultAccountState' && e.state?.accountState === 'frozen'),
      };
    });
    return out;
  };

  const readRent = async (size: number): Promise<bigint> => {
    const min = await solanaRpc<number>('getMinimumBalanceForRentExemption', [size]);
    if (!Number.isSafeInteger(min) || min <= 0) {
      throw new SwapFeeError('solana_rpc_unavailable', 'Solana RPC returned no rent minimum', 503);
    }
    return BigInt(min);
  };

  const readBalance = async (address: string): Promise<bigint> => {
    const res = await solanaRpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    // Above 2^53 lamports (9M SOL) JSON loses the last digits; the floor is still far above any cost.
    if (typeof res?.value !== 'number' || !Number.isFinite(res.value) || res.value < 0) {
      throw new SwapFeeError('solana_rpc_unavailable', 'Solana RPC returned no balance', 503);
    }
    return BigInt(Math.floor(res.value));
  };

  const readLookupTables = async (tx: DecodedSolanaTx): Promise<Record<string, string[]>> => {
    const keys = tx.lookups.map((l) => l.tableKey);
    if (keys.length === 0) return {};
    const res = await solanaRpc<{ value: Array<{ owner?: string; data?: [string, string] } | null> }>(
      'getMultipleAccounts',
      [keys, { encoding: 'base64', commitment: 'confirmed' }],
    );
    const out: Record<string, string[]> = {};
    keys.forEach((k, i) => {
      const acct = res.value?.[i];
      if (!acct?.owner || !acct.data) throw new SwapFeeError('solana_tx_malformed', 'lookup table not found', 502);
      out[k] = parseLookupTableAddresses(acct.owner, acct.data[0]);
    });
    return out;
  };

  /**
   * The SOL the user's wallet needs for this Solana transaction, each cost under its own name
   * (core/swap/solana-swap-costs.ts).
   *
   * The relay simulates the user's exact transaction (signatures unchecked, never sent), so every
   * account it opens with the user's SOL — including ones a program opens inside a call, like a
   * bridge's order account — is read from the simulation and the wallet's total SOL change is
   * measured. When the wallet cannot yet afford the swap, the same transaction is simulated with
   * a simulation-only SOL credit from a funded address prepended, as long as that copy still fits
   * in a packet. If neither can run (a price moved, the copy is too large, the funder is short),
   * the figures come from the top-level instructions alone and are marked measured:false.
   */
  const computeSolanaCosts = async (p: {
    tx: DecodedSolanaTx;
    user: string;
    solSwapped: bigint;
    treasuryTopUp: bigint;
    knownMints: Record<string, SolanaMintInfo | undefined>;
  }): Promise<SolanaSwapCosts> => {
    const keys = resolveAccountKeys(p.tx, await readLookupTables(p.tx));
    const openings = listAccountOpenings(p.tx, keys, p.user);
    const balance = await readBalance(p.user);
    const rentExemptMinimum = await readRent(0);
    const networkFee = networkFeeLamports(p.tx, keys);
    const topUp = p.treasuryTopUp > 0n ? [{ category: 'treasury' as const, lamports: p.treasuryTopUp }] : [];

    type SimValue = {
      err: unknown;
      accounts?: Array<{ lamports?: number } | null>;
      innerInstructions?: Array<{ instructions?: ParsedInnerInstruction[] }>;
    };
    const simulate = async (bytes: Uint8Array): Promise<SimValue | null> => {
      if (bytes.length > SOLANA_MAX_TX_BYTES) return null;
      const r = await solanaRpc<{ value?: SimValue }>('simulateTransaction', [
        Buffer.from(bytes).toString('base64'),
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          innerInstructions: true,
          commitment: 'confirmed',
          accounts: { encoding: 'base64', addresses: [p.user] },
        },
      ]).catch(() => null);
      const v = r?.value;
      const post = v?.accounts?.[0]?.lamports;
      return v && v.err === null && typeof post === 'number' && Number.isFinite(post) ? v : null;
    };
    const measure = (v: SimValue, spend: bigint): SolanaSwapCosts => summarizeSolanaCosts({
      networkFee,
      deposits: [
        ...depositsFromSimulation({
          inner: (v.innerInstructions ?? []).flatMap((g) => g.instructions ?? []),
          topLevelOpenings: openings,
          topLevelClosed: closedAccounts(p.tx, keys),
          user: p.user,
        }),
        ...topUp,
      ],
      solSwapped: p.solSwapped,
      balance,
      rentExemptMinimum,
      measuredSpend: spend,
    });
    const postOf = (v: SimValue) => BigInt(Math.floor(v.accounts![0]!.lamports!));

    // 1. The user's own transaction: exact when the wallet can already afford it (fee included).
    const own = await simulate(encodeSolanaTransaction(p.tx));
    if (own) return measure(own, balance - postOf(own));

    // 2. The same transaction with a simulation-only credit (funder pays the fee in the copy).
    const funder = [deps.env.SOLANA_SIMULATION_FUNDER, ...DEFAULT_SOLANA_SIMULATION_FUNDERS]
      .find((f): f is string => !!f && !keys.includes(f));
    const credit = p.solSwapped + SIMULATION_CREDIT_LAMPORTS;
    const funded = funder ? await simulate(encodeSolanaTransaction(addSimulationFunding(p.tx, funder, credit))) : null;
    if (funded) return measure(funded, balance + credit - postOf(funded) + networkFee);

    // Fallback: the top-level instructions alone.
    const atas = openings.filter((o) => o.kind === 'ata');
    const targets = atas.length
      ? (await solanaRpc<{ value: ParsedAccount[] }>('getMultipleAccounts', [
        atas.map((o) => o.target),
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ])).value ?? []
      : [];
    const missingMints = [...new Set(atas.map((o) => o.mint!))].filter((m) => !p.knownMints[m]);
    const mints = { ...p.knownMints, ...(missingMints.length ? await readMints(missingMints) : {}) };
    const rents = new Map<number, bigint>();
    const rentFor = async (size: number) => {
      if (!rents.has(size)) rents.set(size, await readRent(size));
      return rents.get(size)!;
    };
    const deposits: Array<{ category: OpeningCategory; lamports: bigint }> = [];
    for (const o of openings) {
      const category = categorizeOpening(o, p.user);
      if (o.kind === 'system') {
        deposits.push({ category, lamports: o.lamports! });
        continue;
      }
      const existing = targets[atas.indexOf(o)] ?? null;
      if (existing && !(existing.owner === SOLANA_SYSTEM_PROGRAM_ID && existing.space === 0)) continue; // already open
      const mint = mints[o.mint!];
      if (!mint || mint.program !== o.tokenProgram) {
        throw new SwapFeeError('unsupported_mint', 'cannot size a token account the swap opens', 400);
      }
      const due = (await rentFor(tokenAccountSize(mint))) - BigInt(existing?.lamports ?? 0);
      deposits.push({ category, lamports: due > 0n ? due : 0n });
    }
    return summarizeSolanaCosts({ networkFee, deposits: [...deposits, ...topUp], solSwapped: p.solSwapped, balance, rentExemptMinimum });
  };

  // ---------------------------------------------------------------------------
  // LI.FI — cross-chain
  // ---------------------------------------------------------------------------
  router.get('/lifi/quote', deps.authenticate, async (req: Request, res: Response) => {
    try {
      if (await limited(req, res, 'lifi')) return;
      const apiKey = deps.env.LIFI_API_KEY;
      if (!apiKey) {
        res.status(503).json({ error: 'Service not configured', code: 'SERVICE_UNAVAILABLE' });
        return;
      }
      const query = buildLifiQuoteQuery(req.query as Record<string, unknown>);
      const upstream = await deps.fetch(`https://li.quest/v1/quote?${query.toString()}`, {
        headers: { 'x-lifi-api-key': apiKey },
      });
      const body = (await upstream.json()) as LifiQuoteView & Record<string, unknown>;
      if (!upstream.ok) {
        deps.forwardUpstreamResponse(res, upstream, body);
        return;
      }
      const fromChain = Number(query.get('fromChain'));
      const fromToken = query.get('fromToken')!;
      const fromAmount = query.get('fromAmount')!;
      let solanaTx: DecodedSolanaTx | undefined;
      let emptyTreasuryMinimum: bigint | undefined;
      if (fromChain === LIFI_SOLANA_CHAIN_ID) {
        const data = body.transactionRequest?.data;
        if (typeof data !== 'string') {
          throw new SwapFeeError('lifi_tx_missing', 'LI.FI returned no Solana transaction');
        }
        try {
          solanaTx = decodeSolanaTransaction(Buffer.from(data, 'base64'));
        } catch {
          throw new SwapFeeError('lifi_tx_malformed', 'LI.FI Solana transaction could not be decoded');
        }
        if (solanaTx.staticKeys[0] !== query.get('fromAddress')) {
          throw new SwapFeeError('lifi_tx_wrong_payer', 'LI.FI Solana transaction is not paid by the sender');
        }
        if (fromToken === LIFI_SOLANA_NATIVE_TOKEN && (await readBalance(PROVIAN_SOLANA_TREASURY)) === 0n) {
          emptyTreasuryMinimum = await readRent(0);
        }
      }
      const fee = verifyLifiQuoteFee(body, { fromChain, fromAmount, fromToken, solanaTx, emptyTreasuryMinimum });
      const solanaCosts = solanaTx
        ? await computeSolanaCosts({
          tx: solanaTx,
          user: solanaTx.staticKeys[0],
          solSwapped: fromToken === LIFI_SOLANA_NATIVE_TOKEN ? BigInt(fromAmount) : 0n,
          treasuryTopUp: BigInt(fee.treasuryDepositLamports),
          knownMints: {},
        })
        : undefined;
      res.json({
        ...body,
        provian_fee: {
          bps: SWAP_FEE_BPS,
          amount: fee.feeAmount,
          token: fromToken,
          chain: fromChain,
        },
        lifi_fee: { amount: fee.lifiFeeAmount, token: fromToken },
        ...(solanaCosts ? { solana_costs: solanaCosts } : {}),
      });
    } catch (err) {
      fail(res, err, 'LI.FI quote');
    }
  });

  // ---------------------------------------------------------------------------
  // Jupiter — same-chain Solana
  // ---------------------------------------------------------------------------

  /**
   * 'ready' when the fee account is the treasury's initialised account for the fee mint; 'absent'
   * when it has not been created yet (the relay then creates it inside the swap). An address that
   * only holds lamports (System-owned, no data, e.g. someone sent SOL to it) is still 'absent': the
   * ATA program's create tops up its rent, allocates and assigns it, so pre-funding it cannot block
   * a fee mint. Anything else — another owner, another mint, frozen — refuses the swap.
   */
  const feeAccountState = async (plan: JupiterFeePlan): Promise<'ready' | 'absent'> => {
    if (Date.now() - (feeAccountVerifiedAt.get(plan.feeAccount) ?? 0) < FEE_ACCOUNT_OK_TTL_MS) return 'ready';
    const res = await solanaRpc<{ value?: ParsedAccount }>('getAccountInfo', [
      plan.feeAccount,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const acct = res.value ?? null;
    if (!acct) return 'absent';
    if (acct.owner === SOLANA_SYSTEM_PROGRAM_ID && acct.space === 0 && Number.isSafeInteger(acct.lamports)) return 'absent';
    const info = parsedInfo(acct);
    if (acct.owner !== plan.tokenProgram || info?.owner !== PROVIAN_SOLANA_TREASURY || info?.mint !== plan.feeMint) {
      throw new SwapFeeError('swap_fee_wrong_recipient', 'Solana fee account is not the treasury account for the fee mint', 503);
    }
    if (info.state !== 'initialized') {
      throw new SwapFeeError('solana_fee_account_frozen', 'Solana fee account cannot receive the fee', 503);
    }
    feeAccountVerifiedAt.set(plan.feeAccount, Date.now());
    return 'ready';
  };

  router.post('/jupiter/order', deps.authenticate, async (req: Request, res: Response) => {
    try {
      if (await limited(req, res, 'jupiter')) return;
      const order = parseJupiterOrderRequest((req.body ?? {}) as Record<string, unknown>);
      const mints = await readMints([order.inputMint, order.outputMint]);
      // Fee-token order; a mint whose new treasury account would be created frozen cannot
      // receive the fee, so the next mint in the order takes it.
      const skip = new Set<string>();
      let plan = planJupiterFee(order, mints, skip);
      let state = await feeAccountState(plan);
      // At most one skip per side of the pair; planJupiterFee throws once none is left.
      while (state === 'absent' && mints[plan.feeMint]?.defaultFrozen) {
        if (skip.has(plan.feeMint) || skip.size >= 2) {
          throw new SwapFeeError('unsupported_pair', 'no side of this pair can receive the 25 bps fee', 400);
        }
        skip.add(plan.feeMint);
        plan = planJupiterFee(order, mints, skip);
        state = await feeAccountState(plan);
      }
      const key = deps.env.JUPITER_API_KEY;
      const base = key ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
      const headers: Record<string, string> = key ? { 'x-api-key': key } : {};

      // When the treasury's fee account is created in the same transaction and the route leaves
      // no room for the create, ask again for a route with fewer accounts.
      const sizes: Array<number | undefined> = state === 'absent' ? [undefined, ...JUPITER_ROOM_MAX_ACCOUNTS] : [undefined];
      let quote: JupiterQuoteView & Record<string, unknown> = {};
      let swap: { swapTransaction?: string; lastValidBlockHeight?: number } & Record<string, unknown> = {};
      let fee: ReturnType<typeof verifyJupiterQuote> | undefined;
      let swapTransaction = '';
      for (let i = 0; i < sizes.length; i++) {
        const qRes = await deps.fetch(`${base}/quote?${buildJupiterQuoteQuery(order, plan, sizes[i]).toString()}`, { headers });
        quote = (await qRes.json()) as JupiterQuoteView & Record<string, unknown>;
        if (!qRes.ok) {
          deps.forwardUpstreamResponse(res, qRes, quote);
          return;
        }
        fee = verifyJupiterQuote(quote, order, plan.feeMint);

        const sRes = await deps.fetch(`${base}/swap`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildJupiterSwapBody(quote, order.userPublicKey, plan.feeAccount)),
        });
        swap = (await sRes.json()) as { swapTransaction?: string; lastValidBlockHeight?: number } & Record<string, unknown>;
        if (!sRes.ok) {
          deps.forwardUpstreamResponse(res, sRes, swap);
          return;
        }
        if (typeof swap.swapTransaction !== 'string') {
          throw new SwapFeeError('jupiter_tx_missing', 'Jupiter returned no transaction');
        }
        verifyJupiterTransaction(swap.swapTransaction, order.userPublicKey, plan.feeAccount);
        if (state !== 'absent') {
          swapTransaction = swap.swapTransaction;
          break;
        }
        try {
          swapTransaction = addFeeAccountCreation(swap.swapTransaction, await readLookupTables(decodeSolanaTransaction(Buffer.from(swap.swapTransaction, 'base64'))), {
            userPublicKey: order.userPublicKey,
            feeMint: plan.feeMint,
            feeAccount: plan.feeAccount,
            tokenProgram: plan.tokenProgram,
          });
          break;
        } catch (err) {
          if (err instanceof SwapFeeError && err.code === 'jupiter_tx_too_large' && i < sizes.length - 1) continue;
          throw err;
        }
      }
      if (!fee || !swapTransaction) {
        throw new SwapFeeError('jupiter_tx_missing', 'Jupiter returned no usable transaction');
      }
      const solanaCosts = await computeSolanaCosts({
        tx: decodeSolanaTransaction(Buffer.from(swapTransaction, 'base64')),
        user: order.userPublicKey,
        solSwapped: order.inputMint === SOLANA_WSOL_MINT ? BigInt(order.amount) : 0n,
        treasuryTopUp: 0n,
        knownMints: mints,
      });
      res.json({
        quote: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          otherAmountThreshold: quote.otherAmountThreshold,
          priceImpactPct: quote.priceImpactPct,
          routePlan: quote.routePlan,
        },
        swapTransaction,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        prioritizationFeeLamports: swap.prioritizationFeeLamports,
        provian_fee: {
          bps: SWAP_FEE_BPS,
          amount: fee.feeAmount,
          mint: plan.feeMint,
          side: fee.feeSide,
          account: plan.feeAccount,
          token_program: plan.tokenProgram,
        },
        solana_costs: solanaCosts,
        // Present only on the first swap that takes a fee in this mint: the user's transaction
        // also opens the treasury's account for it and pays its rent-exempt deposit.
        ...(state === 'absent'
          ? { fee_account_created: { account: plan.feeAccount, rent_lamports: solanaCosts.treasury_fee_account_lamports } }
          : {}),
      });
    } catch (err) {
      fail(res, err, 'Jupiter order');
    }
  });

  return router;
}
