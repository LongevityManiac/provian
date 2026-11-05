/**
 * HTTP surface of the Provian x402 facilitator.
 *
 *   GET  /supported                 x402 standard: kinds, extensions, signers
 *   POST /verify                    x402 standard: { x402Version, paymentPayload, paymentRequirements }
 *   POST /settle                    x402 standard
 *   GET  /fee-quote                 what a settlement costs now (?network=base|solana)
 *   POST /sellers/register          seller identity by wallet signature
 *   GET  /sellers/:chain/:address   a seller's public profile
 *   GET  /health
 *   POST /internal/refill           scheduled: gas self-refill + revenue sweep      (scheduler OIDC or Bearer secret)
 *   POST /internal/witness-retry    scheduled: re-send unacknowledged witness reports (scheduler OIDC or Bearer secret)
 *   POST /internal/setup            once: create the Solana gas wallet's USDC fee account (Bearer secret)
 *
 * Reading (/supported, /fee-quote, /sellers/*, the 402 terms) is free and needs nothing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { getAddress, isAddress } from 'viem';
import { isAddress as isSolanaAddress } from '@solana/kit';
import { BASE_NETWORK, PRESENTATION_EXTENSION_KEY, SOLANA_NETWORK, X402_VERSION } from './constants.js';
import type { BaseFacilitator } from './base/facilitator.js';
import type { BaseChain } from './base/chain.js';
import type { SolanaFacilitator } from './solana/facilitator.js';
import type { SolanaChain } from './solana/chain.js';
import type { FacilitatorStore } from './store.js';
import { publicSeller, registerSeller, RegistrationError, sellerIdOf, type EvmMessageVerifier } from './sellers.js';
import { quoteBase, quoteSolana } from './fee-quote.js';
import { refillBase, refillSolana, type RefillReport } from './refill.js';
import type { RefillConfig } from './config.js';
import { retryPendingWitness, type WitnessReporter } from './witness.js';
import type { FetchLike } from './presentation.js';
import { facilitatorRequestSchema } from './x402-types.js';
import { encodeOutputSignatureHeader, OUTPUT_SIGNATURE_HEADER, signOutputBytes, type EvmMessageSigner } from './output-signature.js';

export interface AppDeps {
  readonly base: BaseFacilitator | null;
  readonly baseChain: BaseChain | null;
  readonly basePriceMaxAgeSeconds: number;
  readonly solana: SolanaFacilitator | null;
  readonly solanaChain: SolanaChain | null;
  readonly solanaPriceMaxAgeSeconds: number;
  readonly store: FacilitatorStore;
  readonly verifyEvmMessage: EvmMessageVerifier | null;
  /** Bearer secret for /internal/* (FACILITATOR_RELAY_SECRET). Unset → internal routes answer 503. */
  readonly internalSecret: string | null;
  /**
   * Cloud Scheduler's OIDC token check for /internal/* (true only for a Google-signed token whose
   * audience is this service and whose email is the scheduler service account). The scheduled jobs
   * authenticate this way, so the shared secret never sits in a job's headers, where anyone with
   * `cloudscheduler.jobs.get` could read it (the relay's F43 rule). Null → only the secret is accepted.
   */
  readonly verifySchedulerToken?: ((token: string) => Promise<boolean>) | null;
  readonly quoteSecret: string | null;
  readonly refill: RefillConfig;
  readonly witness: WitnessReporter;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly disabledReasons: Record<'base' | 'solana', string | null>;
  /**
   * Signs the facilitator's own output — a successful settlement receipt — with the Base gas EOA
   * (`Provian-Output-Signature` over the exact response bytes). Null → receipts go out unsigned.
   */
  readonly outputSigner?: EvmMessageSigner | null;
}

export function secretMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

/** Fixed-window per-IP limiter (per instance). */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { count: number; windowStart: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.windowStart >= 60_000) {
      hits.set(ip, { count: 1, windowStart: now });
      if (hits.size > 50_000) hits.clear();
      next();
      return;
    }
    h.count += 1;
    if (h.count > perMinute) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ inflate: false, limit: '64kb' }));

  const limited = rateLimiter(240);

  const requireInternal = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.internalSecret) {
      res.status(503).json({ error: 'internal_auth_unconfigured' });
      return;
    }
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token.length === 0) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (secretMatches(token, deps.internalSecret)) {
      next();
      return;
    }
    const verify = deps.verifySchedulerToken ?? null;
    if (verify === null) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    verify(token).then(
      (ok) => { if (ok) next(); else res.status(401).json({ error: 'unauthorized' }); },
      () => { res.status(401).json({ error: 'unauthorized' }); },
    );
  };

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'provian-x402-facilitator',
      chains: {
        base: deps.base ? 'enabled' : `disabled: ${deps.disabledReasons.base ?? 'unconfigured'}`,
        solana: deps.solana ? 'enabled' : `disabled: ${deps.disabledReasons.solana ?? 'unconfigured'}`,
      },
    });
  });

  app.get('/supported', (_req, res) => {
    const kinds: Array<Record<string, unknown>> = [];
    const signers: Record<string, string[]> = {};
    if (deps.base && deps.baseChain) {
      kinds.push({
        x402Version: X402_VERSION,
        scheme: 'exact',
        network: BASE_NETWORK,
        extra: { provianFee: { payer: 'seller', settler: deps.baseChain.settler, quote: '/fee-quote?network=base' } },
      });
      signers['eip155:*'] = [deps.baseChain.operator];
    }
    if (deps.solana && deps.solanaChain) {
      kinds.push({
        x402Version: X402_VERSION,
        scheme: 'exact',
        network: SOLANA_NETWORK,
        extra: { feePayer: deps.solanaChain.feePayer, provianFee: { payer: 'buyer', quote: '/fee-quote?network=solana' } },
      });
      signers['solana:*'] = [deps.solanaChain.feePayer];
    }
    res.json({ kinds, extensions: [PRESENTATION_EXTENSION_KEY], signers });
  });

  const dispatch = (network: string): BaseFacilitator | SolanaFacilitator | null => {
    if (network === BASE_NETWORK) return deps.base;
    if (network === SOLANA_NETWORK) return deps.solana;
    return null;
  };

  app.post('/verify', limited, async (req, res) => {
    const parsed = facilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ isValid: false, invalidReason: 'invalid_request' });
      return;
    }
    const f = dispatch(parsed.data.paymentRequirements.network);
    if (!f) {
      res.json({ isValid: false, invalidReason: 'unsupported_network' });
      return;
    }
    try {
      res.json(await f.verify(parsed.data.paymentPayload, parsed.data.paymentRequirements));
    } catch (err) {
      console.error('[facilitator] verify error', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
      res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error' });
    }
  });

  app.post('/settle', limited, async (req, res) => {
    const parsed = facilitatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, errorReason: 'invalid_request', transaction: '', network: '' });
      return;
    }
    const network = parsed.data.paymentRequirements.network;
    const f = dispatch(network);
    if (!f) {
      res.json({ success: false, errorReason: 'unsupported_network', transaction: '', network });
      return;
    }
    try {
      const result = await f.settle(parsed.data.paymentPayload, parsed.data.paymentRequirements);
      const body = JSON.stringify(result);
      if (result.success === true && deps.outputSigner) {
        try {
          const signature = await signOutputBytes(deps.outputSigner, new TextEncoder().encode(body));
          res.set(OUTPUT_SIGNATURE_HEADER, encodeOutputSignatureHeader(signature));
        } catch {
          // A receipt that cannot be signed still goes out: the settlement already happened.
          console.error('[facilitator] receipt signing failed');
        }
      }
      res.type('application/json').send(body);
    } catch (err) {
      console.error('[facilitator] settle error', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
      res.status(500).json({ success: false, errorReason: 'unexpected_settle_error', transaction: '', network });
    }
  });

  app.get('/fee-quote', limited, async (req, res) => {
    const network = typeof req.query.network === 'string' ? req.query.network : '';
    try {
      if ((network === 'base' || network === BASE_NETWORK) && deps.baseChain) {
        const scheme = req.query.scheme === 'permit2' ? 'permit2' : 'eip3009';
        res.json(await quoteBase(deps.baseChain, scheme, deps.basePriceMaxAgeSeconds, deps.now()));
        return;
      }
      if ((network === 'solana' || network === SOLANA_NETWORK) && deps.solanaChain) {
        const num = (k: string, d: bigint): bigint => {
          const v = req.query[k];
          return typeof v === 'string' && /^\d{1,12}$/.test(v) ? BigInt(v) : d;
        };
        const sigs = typeof req.query.signatures === 'string' && /^\d$/.test(req.query.signatures) ? Number(req.query.signatures) : 2;
        res.json(
          await quoteSolana(
            deps.solanaChain,
            { computeUnitLimit: num('compute_unit_limit', 200_000n), computeUnitPriceMicroLamports: num('compute_unit_price', 1n), signatures: sigs },
            deps.solanaPriceMaxAgeSeconds,
            deps.quoteSecret,
            deps.now(),
          ),
        );
        return;
      }
      res.status(400).json({ error: 'network must be base or solana (and enabled)' });
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(503).json({ error: 'fee_price_unavailable' });
    }
  });

  app.post('/sellers/register', limited, async (req, res) => {
    try {
      const seller = await registerSeller(req.body, { store: deps.store, verifyEvm: deps.verifyEvmMessage, now: deps.now });
      res.status(201).json({ registered: true, seller: publicSeller(seller) });
    } catch (err) {
      if (err instanceof RegistrationError) {
        res.status(err.status).json({ registered: false, error: err.code });
        return;
      }
      console.error('[facilitator] register error', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
      res.status(500).json({ registered: false, error: 'unexpected_error' });
    }
  });

  app.get('/sellers/:chain/:address', limited, async (req, res) => {
    const chain = String(req.params.chain ?? '');
    const raw = String(req.params.address ?? '');
    let id: string;
    if (chain === 'base' && isAddress(raw)) id = sellerIdOf('base', getAddress(raw));
    else if (chain === 'solana' && isSolanaAddress(raw)) id = sellerIdOf('solana', raw);
    else {
      res.status(400).json({ error: 'invalid chain or address' });
      return;
    }
    const s = await deps.store.getSeller(id);
    if (!s) {
      res.status(404).json({ error: 'seller_not_registered' });
      return;
    }
    res.json(publicSeller(s));
  });

  app.post('/internal/refill', requireInternal, async (_req, res) => {
    const reports: RefillReport[] = [];
    if (deps.baseChain) {
      reports.push(
        await refillBase({
          chain: deps.baseChain,
          policy: { gasFloor: deps.refill.baseGasFloorWei, usdcBuffer: deps.refill.baseUsdcBuffer, refillMax: deps.refill.baseRefillMaxUsdc, minSwap: deps.refill.baseMinSwapUsdc },
          zeroxApiKey: deps.refill.zeroxApiKey,
          fetch: deps.fetch,
        }),
      );
    }
    if (deps.solanaChain) {
      reports.push(
        await refillSolana({
          chain: deps.solanaChain,
          policy: { gasFloor: deps.refill.solanaGasFloorLamports, usdcBuffer: deps.refill.solanaUsdcBuffer, refillMax: deps.refill.solanaRefillMaxUsdc, minSwap: deps.refill.solanaMinSwapUsdc },
          jupiterApiKey: deps.refill.jupiterApiKey,
          priceMaxAgeSeconds: deps.solanaPriceMaxAgeSeconds,
          fetch: deps.fetch,
        }),
      );
    }
    // Balances, amounts, tx hashes and error text only — never a key or an API secret.
    for (const r of reports) console.log(`[facilitator] refill ${JSON.stringify(r)}`);
    // Balances, amounts, tx hashes and error text only: never a key or an API secret.
    for (const r of reports) console.log(`[facilitator] refill ${JSON.stringify(r)}`);
    // The Command Center reads the latest run per chain; a failed write never fails the refill.
    const at = deps.now();
    await Promise.all(reports.map((r) => deps.store.recordRefill(r, at).catch((err: unknown) => {
      console.error('[facilitator] refill state not saved', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
    })));
    res.json({ reports });
  });

  /** One-time, idempotent: the Solana gas wallet's USDC account (where the fee lands) must exist. */
  app.post('/internal/setup', requireInternal, async (_req, res) => {
    if (!deps.solanaChain) {
      res.json({ solana: 'disabled' });
      return;
    }
    try {
      res.json({ solana_fee_account: await deps.solanaChain.ensureOwnUsdcAccount() });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message.slice(0, 200) : 'setup failed' });
    }
  });

  app.post('/internal/witness-retry', requireInternal, async (_req, res) => {
    // 2026-10-17: a `submitted` record whose receipt wait was lost is resolved from the chain first,
    // so its witness report (or failure) is no longer hostage to the seller retrying /settle.
    const reconciled = deps.base ? await deps.base.reconcileStaleSubmitted() : { scanned: 0, resolved: 0 };
    // M2 (fix run 2026-10-24): Solana records resolve from the Solana cluster the same way.
    const reconciledSolana = deps.solana ? await deps.solana.reconcileStaleSubmitted() : { scanned: 0, resolved: 0 };
    res.json({ ...(await retryPendingWitness(deps.store, deps.witness)), reconciled, reconciled_solana: reconciledSolana });
  });

  return app;
}
