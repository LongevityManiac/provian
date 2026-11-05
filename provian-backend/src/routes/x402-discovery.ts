/**
 * — the relay origin's x402 discovery document: `GET /openapi.json`.
 *
 * x402 indexers (x402scan first) look for `/openapi.json` on an origin and register each operation
 * that declares `x-payment-info` and a `402` response, then probe it for the runtime challenge
 * (which is authoritative). This document describes exactly one paid operation, the PE Archive's
 * agent route `POST /v1/archive/pay`, and nothing else: the relay's full API reference stays at
 * `/v1/openapi.json`, and the people's route (`/v1/archive/mobile/pay`, wallet auth) is not an x402
 * resource anyone else can call, so it is never listed.
 *
 * Every payment term comes from the one place the route's own 402 takes it
 * (`usdcChargeRequirement(ARCHIVE_SERVICE_TERMS)`), and the request and response schemas from the
 * route's Bazaar listing (`ARCHIVE_BAZAAR_EXTENSION`): nothing here restates a price, token, chain
 * or recipient.
 *
 * Served once the site is open (`PUBLIC_LAUNCH=true`, read per request). Before that the path is
 * passed on untouched, so it answers exactly as an unknown path does.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { isPublicLaunchOpen } from './middleware/pre-launch-surface-gate';
import { AGENT_PAY_PATH } from './archive';
import {
  ARCHIVE_BAZAAR_EXTENSION,
  ARCHIVE_LISTING_DESCRIPTION,
  ARCHIVE_LISTING_SERVICE_NAME,
  ARCHIVE_SERVICE_TERMS,
} from '../core/archive/archive-terms';
import { usdcChargeRequirement } from '../core/payments/usdc-charge';

/** The discovery document's path on the relay origin. */
export const X402_OPENAPI_PATH = '/openapi.json';

/** USDC's decimals (6): how many atomic units make one dollar of the requirement's amount. */
const USDC_DECIMALS = 6;

/**
 * A USDC amount in atomic units as decimal dollars, at least two places: `5000000` → `5.00`,
 * `10000` → `0.01`, `1234567` → `1.234567`. Throws on anything but a non-negative integer string.
 */
export function usdFromUsdcAtomic(atomic: string): string {
  if (!/^\d+$/.test(atomic)) throw new Error('usdc_amount_not_atomic');
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const value = BigInt(atomic);
  const fraction = (value % scale).toString(10).padStart(USDC_DECIMALS, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${(value / scale).toString(10)}.${fraction}`;
}

/** The OpenAPI security scheme name for the agent's Provian API key. */
const API_KEY_SCHEME = 'ApiKeyAuth';

/** The discovery document for a relay whose public origin is `publicBaseUrl`. Pure. */
export function buildX402OpenApiDocument(publicBaseUrl: string): Record<string, unknown> {
  const origin = publicBaseUrl.replace(/\/$/, '');
  const requirement = usdcChargeRequirement(ARCHIVE_SERVICE_TERMS);
  const price = usdFromUsdcAtomic(requirement.amount);
  const input = ARCHIVE_BAZAAR_EXTENSION.schema.properties.input.properties;
  const output = ARCHIVE_BAZAAR_EXTENSION.schema.properties.output.properties.example;

  return {
    openapi: '3.1.0',
    info: {
      title: ARCHIVE_LISTING_SERVICE_NAME,
      version: '1.0.0',
      description: ARCHIVE_LISTING_DESCRIPTION,
      contact: { url: 'https://provian.ai' },
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        [API_KEY_SCHEME]: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: input.headers.properties.Authorization.description
            + ' Without a key the call answers 402 with its terms; a payment sent without a valid key is refused 401 and nothing is charged.',
        },
      },
    },
    paths: {
      [AGENT_PAY_PATH]: {
        post: {
          operationId: 'buyArchiveGb',
          tags: ['PE Archive'],
          summary: `Buy one GB of PE Archive space for ${price} USDC over x402`,
          description: ARCHIVE_SERVICE_TERMS.description,
          security: [{ [API_KEY_SCHEME]: [] }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: input.body } },
          },
          responses: {
            '200': {
              description: 'Paid: one more GB credited',
              content: { 'application/json': { schema: output } },
            },
            '202': { description: 'Charged; the GB is being credited' },
            '401': { description: 'No valid agent API key. A payment sent with it is refused and nothing is charged.' },
            '402': {
              description: 'Payment required: the x402 v2 challenge, in the PAYMENT-REQUIRED header (base64 JSON) and the body, with the Bazaar listing',
              headers: { 'PAYMENT-REQUIRED': { schema: { type: 'string' } } },
            },
            '409': { description: '`archive_space_available` (the next GB is bought once less than 100 MB remain) or `payment_already_used`' },
            '503': { description: '`waits_for_gas` or `archive_payments_not_configured`; nothing charged' },
          },
          'x-payment-info': {
            price: { mode: 'fixed', currency: 'USD', amount: price },
            protocols: [{
              x402: {
                version: 2,
                scheme: requirement.scheme,
                network: requirement.network,
                asset: requirement.asset,
                payTo: requirement.payTo,
                amount: requirement.amount,
              },
            }],
          },
        },
      },
    },
  };
}

/** `GET /openapi.json`: the discovery document once the site is open; before that, untouched. */
export function createX402DiscoveryRouter(deps: {
  readonly publicBaseUrl: string;
  /** Where the launch flip (`PUBLIC_LAUNCH`) is read, per request. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const document = buildX402OpenApiDocument(deps.publicBaseUrl);
  router.get(X402_OPENAPI_PATH, (_req: Request, res: Response, next: NextFunction) => {
    if (!isPublicLaunchOpen(env)) { next(); return; }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(document);
  });
  return router;
}
