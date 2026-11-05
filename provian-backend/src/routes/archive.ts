/**
 * — the paid PE Archive routes.
 *
 * Your PEs stay yours: the Archive keeps encrypted days you choose to pay for ($5 USDC per GB,
 * kept permanently). The relay stores ciphertext only — one object per uploaded part (written once) in the
 * Archive bucket — and a small index. Three surfaces, one per credential, never merged:
 *
 * AGENT API KEY (`Bearer pvn_live_…`) — the agent's own account; pays over x402
 * GET /v1/archive status (+ who days are sealed to)
 * POST /v1/archive/pay buy a GB: no PAYMENT-SIGNATURE → 402 terms; with it → charge + credit.
 * Once the site is open (`PUBLIC_LAUNCH=true`, read per request) a caller with
 * no credential and no payment gets the same 402 terms and listing, so x402
 * indexers can read them; a payment sent without a valid key is refused 401
 * and never reaches the charge path.
 * POST /v1/archive/on | /v1/archive/off turn on (only with paid space left) / off (keeps everything)
 * GET /v1/archive/days?after=YYYY-MM-DD the archived days (index only)
 * GET /v1/archive/days/:day/object the day's ciphertext (pull, decrypt locally, present)
 * GET /v1/archive/payments/:id one of this agent's payments
 *
 * DEVICE (the observer daemon's device key; uploads are body-bound)
 * GET /v1/archive/device status for this device's owner + recipients
 * POST /v1/archive/device/parts { part } — one sealed part of one closed day
 * GET /v1/archive/device/days?after=… GET /v1/archive/device/days/:day/object
 *
 * PERSON (wallet auth; the app pays from the person's own wallet)
 * GET /v1/archive/mobile status + recipients
 * POST /v1/archive/mobile/pay { payment? } — same terms; the quote (no payment) also says
 * whether this wallet holds the $5 and gas is covered now
 * POST /v1/archive/mobile/on | /off
 * POST /v1/archive/mobile/parts { part }
 * GET /v1/archive/mobile/days?wallet=&after= own days, or a LINKED AGENT's
 * GET /v1/archive/mobile/days/:wallet/:day/object own day, or a linked agent's (sealed to this person too)
 * GET /v1/archive/mobile/payments this person's purchases, newest first (with transactions)
 * GET /v1/archive/mobile/linked?after= confirmed days of every agent linked to this person
 * (so the phone can drop the copies it holds for them)
 *
 * POST /v1/internal/scheduler/archive-sweep scheduler auth: finish payments, confirm days.
 *
 * A day is served as its parts' objects in index order (one object per part since 2026-10-07).
 * Nothing here deletes an archived day or any PE. A full Archive whose next GB is not paid answers
 * 402 `archive_space_exhausted` to an upload; the day stays on the owner's devices.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { sweepDormantOccurrences } from '../core/meter/occurrence-residency';
import type { Firestore } from 'firebase-admin/firestore';
import type { cache as sharedCache } from '../cache';
import { createDeviceAuthMiddleware, type DeviceDocument } from './middleware/device-auth';
import { isPublicLaunchOpen } from './middleware/pre-launch-surface-gate';
import { deviceBodyBinding } from './meter';
import { resolveAgentChainOwnerId } from '../core/agent-wallet/agent-chain-owner';
import { readMessageKey } from '../core/commons/message-keys';
import { encodeHeaderJson, USDC_CHARGE_NETWORK } from '../core/payments/usdc-charge';
import {
  archiveAgentListing,
  archiveAgentPaymentRequired,
  archiveHumanListing,
  archivePaymentRequired,
  ARCHIVE_GB_FEE_USDC_ATOMIC,
  ARCHIVE_PAYMENTS_COLLECTION,
} from '../core/archive/archive-terms';
import type { CdpSettlementListing } from '../core/payments/cdp-facilitator';
import {
  advanceArchivePayment,
  archiveChargeCovered,
  humanArchiveOwner,
  listArchiveDays,
  listArchivePayments,
  openArchiveDayStream,
  publicArchiveAccount,
  publicArchiveDay,
  publicArchivePayment,
  readArchiveAccount,
  readArchiveDay,
  requestArchiveGb,
  setArchiveOn,
  storeArchivePart,
  sweepArchive,
  type ArchiveDeps,
  type ArchiveOwner,
  type ArchivePayResponse,
  type ArchivePaymentDoc,
  type ArchiveUploadResult,
} from '../core/archive/archive-service';

export { humanArchiveOwner };
import type { AgentWalletDocument } from '../core/agent-wallet/types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const REQUEST_ID = /^ap_[0-9a-f]{40}$/;

export interface ArchiveRouterDeps {
  readonly db: Firestore;
  readonly cache: typeof sharedCache;
  readonly authenticateAgent: RequestHandler;
  /** Wallet auth that sets `req.user = { id, device_id }` (the app's request-bound token). */
  readonly authenticateWallet: RequestHandler;
  readonly authenticateScheduler: (req: Request) => Promise<boolean>;
  /** Null while the Archive bucket is not configured. */
  readonly archiveDeps: () => ArchiveDeps | null;
  readonly publicBaseUrl: string;
  /** Where the launch flip (`PUBLIC_LAUNCH`) is read, per request. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

// ─── owners (always from the caller's own credential) ───────────────────────────

export function agentArchiveOwner(wallet: AgentWalletDocument): ArchiveOwner {
  return {
    wallet: wallet.id,
    kind: 'agent',
    actorId: wallet.agent_id,
    linkedHumanWallet: typeof wallet.linked_human_wallet_id === 'string' && wallet.linked_human_wallet_id.length > 0
      ? wallet.linked_human_wallet_id
      : null,
  };
}

/** A device's owner, keyed exactly as the meter keys its batches (agent_id / user_id). */
export async function deviceArchiveOwner(db: Firestore, cache: typeof sharedCache, device: DeviceDocument): Promise<ArchiveOwner | null> {
  if (device.owner_type === 'agent') {
    if (!device.owner_wallet_id) return null;
    const snap = await db.collection('agent_wallets').doc(device.owner_wallet_id).get();
    if (!snap.exists) return null;
    const agent = { id: snap.id, ...(snap.data() as Omit<AgentWalletDocument, 'id'>) } as AgentWalletDocument;
    const actorId = await resolveAgentChainOwnerId({ db, cache }, device);
    return { ...agentArchiveOwner(agent), actorId };
  }
  return humanArchiveOwner(db, device.owner_user_id);
}

/** Whom days are sealed to: the owner's published message key, and an agent's linked human's. */
export async function archiveRecipients(db: Firestore, owner: ArchiveOwner): Promise<{ party_id: string; role: 'owner' | 'linked_human'; pubkey_b64u: string }[]> {
  const out: { party_id: string; role: 'owner' | 'linked_human'; pubkey_b64u: string }[] = [];
  const own = await readMessageKey(db, owner.wallet);
  if (own) out.push({ party_id: owner.wallet, role: 'owner', pubkey_b64u: own.pubkey_b64u });
  if (owner.linkedHumanWallet !== null) {
    const human = await readMessageKey(db, owner.linkedHumanWallet);
    if (human) out.push({ party_id: owner.linkedHumanWallet, role: 'linked_human', pubkey_b64u: human.pubkey_b64u });
  }
  return out;
}

// ─── responses ──────────────────────────────────────────────────────────────────

/** The agent route: the x402 resource the Archive's public listing names. */
export const AGENT_PAY_PATH = '/v1/archive/pay';

/** The headers an x402 client sends a payment in: v2 `PAYMENT-SIGNATURE`, v1 `X-PAYMENT`. */
const PAYMENT_HEADERS: readonly string[] = ['payment-signature', 'x-payment'];

/**
 * Whether a request carries a payment in any form an x402 client or the app sends one: a payment
 * header (any value, even an empty one) or a `payment` field in a JSON body. Anything that might be
 * a payment counts as one.
 */
export function carriesPayment(req: Request): boolean {
  if (PAYMENT_HEADERS.some((name) => req.headers[name] !== undefined)) return true;
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && Object.prototype.hasOwnProperty.call(body, 'payment');
}

/**
 * What a CDP settlement of this resource declares: the agent route carries the public listing and
 * the Bazaar extension; every other route (the people's wallet-auth route) carries no listing, so it
 * is never catalogued as a public x402 resource. The one place the choice is made.
 */
export function archiveListingFor(resourceUrl: string): CdpSettlementListing {
  return new URL(resourceUrl).pathname === AGENT_PAY_PATH
    ? archiveAgentListing(resourceUrl)
    : archiveHumanListing(resourceUrl);
}

/** The 402 for a resource: the agent route's carries the listing and the Bazaar extension. */
export function paymentRequiredFor(resourceUrl: string, error?: string): Record<string, unknown> {
  return archiveListingFor(resourceUrl).extensions !== undefined
    ? archiveAgentPaymentRequired(resourceUrl, error)
    : archivePaymentRequired(resourceUrl, error);
}

function respondPay(res: Response, outcome: ArchivePayResponse, resourceUrl: string, quoteExtra?: Record<string, unknown>): void {
  switch (outcome.kind) {
    case 'payment_required': {
      const body = paymentRequiredFor(resourceUrl, outcome.error);
      res.setHeader('PAYMENT-REQUIRED', encodeHeaderJson(body));
      res.status(402).json({ ...body, ...(quoteExtra ?? {}), archive: publicArchiveAccount(outcome.account) });
      return;
    }
    case 'space_available':
      res.status(409).json({
        error: 'archive_space_available',
        message: 'Your Archive still has space; the next GB is bought when the space is nearly used. Nothing was charged.',
        archive: publicArchiveAccount(outcome.account),
      });
      return;
    case 'waits_for_gas':
      res.setHeader('Retry-After', '600');
      res.status(503).json({ error: 'waits_for_gas', message: 'Base gas is unavailable or too high right now. Nothing was charged; try again later.' });
      return;
    case 'not_your_request':
      res.status(409).json({ error: 'payment_already_used', message: 'This payment belongs to another Archive request.' });
      return;
    case 'not_configured':
      res.status(503).json({ error: 'archive_payments_not_configured' });
      return;
    case 'payment': {
      const p = outcome.payment;
      if (p.charge_tx_hash !== null) {
        res.setHeader('PAYMENT-RESPONSE', encodeHeaderJson({
          success: p.state !== 'charge_failed', payer: p.payer, transaction: p.charge_tx_hash, network: USDC_CHARGE_NETWORK,
        }));
      }
      res.status(p.credited ? 200 : p.state === 'charge_failed' ? 402 : 202)
        .json({ ...publicArchivePayment(p), archive: publicArchiveAccount(outcome.account) });
    }
  }
}

function respondUpload(res: Response, outcome: ArchiveUploadResult, resourceUrl: string): void {
  if (outcome.kind === 'stored') {
    res.status(outcome.idempotent ? 200 : 201).json({ day: publicArchiveDay(outcome.day), idempotent: outcome.idempotent });
    return;
  }
  if (outcome.kind === 'space_exhausted') {
    const body = paymentRequiredFor(resourceUrl, 'archive_space_exhausted');
    res.setHeader('PAYMENT-REQUIRED', encodeHeaderJson(body));
    res.status(402).json({
      ...body,
      error: 'archive_space_exhausted',
      message: 'Archive full — add 1 GB for $5. Until then new days stay on your devices; nothing is deleted.',
      archive: publicArchiveAccount(outcome.account),
    });
    return;
  }
  res.status(outcome.http).json({ error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) });
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function partBytes(req: Request): Uint8Array | null {
  const part = (req.body as { part?: unknown } | undefined)?.part;
  return typeof part === 'string' && part.length > 0 ? new Uint8Array(Buffer.from(part, 'utf8')) : null;
}

function afterDay(req: Request): string | null {
  const after = typeof req.query.after === 'string' ? req.query.after : null;
  return after !== null && DAY.test(after) ? after : null;
}

export function createArchiveRouter(deps: ArchiveRouterDeps): Router {
  const router = Router();
  const { db, cache } = deps;
  const env = deps.env ?? process.env;
  const authenticateDevice = createDeviceAuthMiddleware(db);
  const resource = (path: string): string => `${deps.publicBaseUrl.replace(/\/$/, '')}${path}`;

  const withArchive = (handler: (req: Request, res: Response, archive: ArchiveDeps) => Promise<void>) =>
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const archive = deps.archiveDeps();
      if (archive === null) {
        res.status(503).json({ error: 'archive_not_configured' });
        return;
      }
      try {
        await handler(req, res, archive);
      } catch (error) {
        console.error('[archive] failed', error instanceof Error ? error.message : error);
        if (!res.headersSent) res.status(500).json({ error: 'archive_failed' });
      }
    };

  const status = async (res: Response, owner: ArchiveOwner): Promise<void> => {
    const account = await readArchiveAccount(db, owner.wallet);
    res.json({ wallet: owner.wallet, archive: publicArchiveAccount(account), recipients: await archiveRecipients(db, owner) });
  };

  const listDays = async (req: Request, res: Response, wallet: string): Promise<void> => {
    if (req.query.day !== undefined) {
      if (typeof req.query.day !== 'string' || !DAY.test(req.query.day)) { res.status(400).json({ error: 'invalid_day' }); return; }
      const day = await readArchiveDay(db, wallet, req.query.day);
      res.json({ wallet, days: day ? [publicArchiveDay(day)] : [], next_after: null });
      return;
    }
    const limit = Number(req.query.limit ?? 100);
    const days = await listArchiveDays(db, wallet, afterDay(req), Number.isFinite(limit) ? limit : 100);
    res.json({ wallet, days: days.map(publicArchiveDay), next_after: days.length > 0 ? days[days.length - 1].day : null });
  };

  const sendObject = async (res: Response, archive: ArchiveDeps, wallet: string, day: string): Promise<void> => {
    const index = await readArchiveDay(db, wallet, day);
    if (index === null || index.stored_bytes === 0) {
      res.status(404).json({ error: 'archive_day_not_found' });
      return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('X-Provian-Archive-Bytes', String(index.stored_bytes));
    res.setHeader('Cache-Control', 'no-store');
    const stream = openArchiveDayStream(archive.objects, index);
    stream.on('error', (error) => {
      console.error('[archive] object read failed', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.status(502).json({ error: 'archive_object_unreadable' });
      else res.destroy();
    });
    // A client that disconnects mid-download stops the read (openArchiveDayStream stops on close).
    res.once('close', () => { if (!res.writableFinished) stream.destroy(); });
    stream.pipe(res);
  };

  const readPayment = async (req: Request, res: Response, wallet: string, archive: ArchiveDeps): Promise<void> => {
    const id = String(req.params.request_id ?? '');
    const snap = REQUEST_ID.test(id) ? await db.collection(ARCHIVE_PAYMENTS_COLLECTION).doc(id).get() : null;
    const payment = snap?.exists ? (snap.data() as ArchivePaymentDoc) : null;
    if (payment === null || payment.wallet !== wallet) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(publicArchivePayment(await advanceArchivePayment(archive, id)));
  };

  // ── agent API key ────────────────────────────────────────────────────────────

  const agentOwnerOf = (req: Request, res: Response): ArchiveOwner | null => {
    const wallet = req.agentWallet;
    if (wallet === undefined || wallet.status !== 'active') {
      res.status(403).json({ error: 'agent_wallet_inactive' });
      return null;
    }
    return agentArchiveOwner(wallet);
  };

  router.get('/v1/archive', deps.authenticateAgent, withArchive(async (req, res) => {
    const owner = agentOwnerOf(req, res);
    if (owner) await status(res, owner);
  }));

  /**
   * The agent pay route's answer to a caller with no credential, from the launch flip on. The x402
   * indexers (Coinbase's Bazaar, x402scan) list a resource by probing it without a key, so the probe
   * gets the 402: the same requirement and the same Bazaar listing an agent with its key gets, whose
   * input schema states the API key is required. Nothing is read or written for it.
   *
   * A payment is never taken that credits nobody: a request that carries a payment and no
   * credential is refused 401 here, before anything reads the Archive, verifies the payment or
   * calls a facilitator. A request with any credential, valid or not, goes to the agent key check,
   * which refuses an invalid one. Before the flip this calls `next()` for every request, so the
   * route answers exactly as it always has.
   */
  const agentPayChallenge = (req: Request, res: Response, next: NextFunction): void => {
    if (!isPublicLaunchOpen(env)) { next(); return; }
    if (req.headers.authorization !== undefined) { next(); return; }
    if (carriesPayment(req)) {
      res.status(401).json({
        error: 'agent_api_key_required',
        message: 'Nothing was charged: call with your Provian API key (Authorization: Bearer pvn_live_<key>:pvns_<secret>).',
      });
      return;
    }
    // An Archive that is not configured has nothing to sell: the answer stays the key check's.
    if (deps.archiveDeps() === null) { next(); return; }
    const body = paymentRequiredFor(resource(AGENT_PAY_PATH));
    res.setHeader('PAYMENT-REQUIRED', encodeHeaderJson(body));
    res.status(402).json(body);
  };

  router.post('/v1/archive/pay', agentPayChallenge, deps.authenticateAgent, withArchive(async (req, res, archive) => {
    const owner = agentOwnerOf(req, res);
    if (!owner) return;
    const outcome = await requestArchiveGb(archive, {
      owner,
      requestedBy: owner.wallet,
      paymentHeader: header(req, 'payment-signature'),
      listing: archiveListingFor(resource(AGENT_PAY_PATH)),
    });
    respondPay(res, outcome, resource(AGENT_PAY_PATH));
  }));

  for (const on of [true, false]) {
    router.post(`/v1/archive/${on ? 'on' : 'off'}`, deps.authenticateAgent, withArchive(async (req, res, archive) => {
      const owner = agentOwnerOf(req, res);
      if (!owner) return;
      const out = await setArchiveOn(archive, owner, on);
      if (out.kind === 'payment_required') {
        respondPay(res, { kind: 'payment_required', account: out.account }, resource(AGENT_PAY_PATH));
        return;
      }
      res.json({ archive: publicArchiveAccount(out.account) });
    }));
  }

  router.get('/v1/archive/days', deps.authenticateAgent, withArchive(async (req, res) => {
    const owner = agentOwnerOf(req, res);
    if (owner) await listDays(req, res, owner.wallet);
  }));

  router.get('/v1/archive/days/:day/object', deps.authenticateAgent, withArchive(async (req, res, archive) => {
    const owner = agentOwnerOf(req, res);
    if (!owner) return;
    const day = String(req.params.day ?? '');
    if (!DAY.test(day)) {
      res.status(400).json({ error: 'bad_day' });
      return;
    }
    await sendObject(res, archive, owner.wallet, day);
  }));

  router.get('/v1/archive/payments/:request_id', deps.authenticateAgent, withArchive(async (req, res, archive) => {
    const owner = agentOwnerOf(req, res);
    if (owner) await readPayment(req, res, owner.wallet, archive);
  }));

  // ── device (the daemon) ──────────────────────────────────────────────────────

  const deviceOwnerOf = async (req: Request, res: Response): Promise<ArchiveOwner | null> => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return null;
    }
    const owner = await deviceArchiveOwner(db, cache, device);
    if (owner === null) res.status(409).json({ error: 'archive_owner_unresolved' });
    return owner;
  };

  router.get('/v1/archive/device', authenticateDevice, withArchive(async (req, res) => {
    const owner = await deviceOwnerOf(req, res);
    if (owner) await status(res, owner);
  }));

  router.post('/v1/archive/device/parts', authenticateDevice, withArchive(async (req, res, archive) => {
    const binding = deviceBodyBinding(req);
    if (binding === null) {
      res.status(401).json({ error: 'X-Provian-Body-HMAC verification failed' });
      return;
    }
    if (!binding.bound) {
      res.status(401).json({ error: 'archive_upload_not_body_bound' });
      return;
    }
    const owner = await deviceOwnerOf(req, res);
    if (!owner) return;
    const bytes = partBytes(req);
    if (bytes === null) {
      res.status(400).json({ error: 'part_required' });
      return;
    }
    respondUpload(res, await storeArchivePart(archive, { owner, deviceId: req.device!.device_id, bytes }), resource(AGENT_PAY_PATH));
  }));

  router.get('/v1/archive/device/days', authenticateDevice, withArchive(async (req, res) => {
    const owner = await deviceOwnerOf(req, res);
    if (owner) await listDays(req, res, owner.wallet);
  }));

  router.get('/v1/archive/device/days/:day/object', authenticateDevice, withArchive(async (req, res, archive) => {
    const owner = await deviceOwnerOf(req, res);
    if (!owner) return;
    const day = String(req.params.day ?? '');
    if (!DAY.test(day)) {
      res.status(400).json({ error: 'bad_day' });
      return;
    }
    await sendObject(res, archive, owner.wallet, day);
  }));

  // ── person (wallet auth) ─────────────────────────────────────────────────────

  const humanOwnerOf = async (req: Request, res: Response): Promise<ArchiveOwner | null> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    const owner = await humanArchiveOwner(db, userId);
    if (owner === null) res.status(409).json({ error: 'archive_owner_unresolved' });
    return owner;
  };

  /**
   * What the person's wallet holds for the charge and whether Base gas is covered now — read with
   * the same chain reads the charge itself makes. A value that cannot be read is null (the app says
   * so and the relay still checks again when the payment arrives).
   */
  const humanQuotePreflight = async (owner: ArchiveOwner, archive: ArchiveDeps): Promise<Record<string, unknown>> => {
    const walletDoc = await db.collection('wallets').doc(owner.wallet).get().catch(() => null);
    // `address` is the field the relay writes on every wallet (`WalletDocument` in server.ts).
    const raw = walletDoc?.data()?.address;
    const address = typeof raw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
    let balance: string | null = null;
    let gasCovered: boolean | null = null;
    if (archive.charge !== null) {
      if (address !== null) {
        balance = await archive.charge.chain.usdcBalance(address).then((b) => b.toString(10)).catch(() => null);
      }
      gasCovered = await archiveChargeCovered(archive.charge, archive.settlement).then((g) => g.covered).catch(() => null);
    }
    return {
      payer: {
        address,
        usdc_balance_atomic: balance,
        sufficient: balance === null ? null : BigInt(balance) >= ARCHIVE_GB_FEE_USDC_ATOMIC,
      },
      gas_covered: gasCovered,
    };
  };

  /** A wallet this person may read: their own, or an agent linked to them. */
  const readableWallet = async (userId: string, own: ArchiveOwner, wallet: string): Promise<boolean> => {
    if (wallet === own.wallet) return true;
    if (!ID.test(wallet)) return false;
    const agent = await db.collection('agent_wallets').doc(wallet).get();
    return agent.exists && agent.data()?.linked_human_user_id === userId;
  };

  router.get('/v1/archive/mobile', deps.authenticateWallet, withArchive(async (req, res) => {
    const owner = await humanOwnerOf(req, res);
    if (owner) await status(res, owner);
  }));

  router.post('/v1/archive/mobile/pay', deps.authenticateWallet, withArchive(async (req, res, archive) => {
    const owner = await humanOwnerOf(req, res);
    if (!owner) return;
    const body = (req.body ?? {}) as { payment?: unknown };
    const paymentHeader = typeof body.payment === 'string' && body.payment.length > 0 ? body.payment : header(req, 'payment-signature');
    const outcome = await requestArchiveGb(archive, {
      owner,
      requestedBy: req.user!.id,
      paymentHeader,
      listing: archiveListingFor(resource('/v1/archive/mobile/pay')),
    });
    // The quote tells the app, BEFORE it asks for Face ID, whether this wallet can pay now.
    const extra = paymentHeader === undefined && outcome.kind === 'payment_required'
      ? await humanQuotePreflight(owner, archive)
      : undefined;
    respondPay(res, outcome, resource('/v1/archive/mobile/pay'), extra);
  }));

  for (const on of [true, false]) {
    router.post(`/v1/archive/mobile/${on ? 'on' : 'off'}`, deps.authenticateWallet, withArchive(async (req, res, archive) => {
      const owner = await humanOwnerOf(req, res);
      if (!owner) return;
      const out = await setArchiveOn(archive, owner, on);
      if (out.kind === 'payment_required') {
        respondPay(res, { kind: 'payment_required', account: out.account }, resource('/v1/archive/mobile/pay'));
        return;
      }
      res.json({ archive: publicArchiveAccount(out.account) });
    }));
  }

  router.post('/v1/archive/mobile/parts', deps.authenticateWallet, withArchive(async (req, res, archive) => {
    const owner = await humanOwnerOf(req, res);
    if (!owner) return;
    const deviceId = req.user?.device_id;
    const bytes = partBytes(req);
    if (!deviceId || bytes === null) {
      res.status(400).json({ error: 'part_required' });
      return;
    }
    respondUpload(res, await storeArchivePart(archive, { owner, deviceId, bytes }), resource('/v1/archive/mobile/pay'));
  }));

  router.get('/v1/archive/mobile/days', deps.authenticateWallet, withArchive(async (req, res) => {
    const owner = await humanOwnerOf(req, res);
    if (!owner) return;
    const wallet = typeof req.query.wallet === 'string' && req.query.wallet.length > 0 ? req.query.wallet : owner.wallet;
    if (!await readableWallet(req.user!.id, owner, wallet)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await listDays(req, res, wallet);
  }));

  router.get('/v1/archive/mobile/days/:wallet/:day/object', deps.authenticateWallet, withArchive(async (req, res, archive) => {
    const owner = await humanOwnerOf(req, res);
    if (!owner) return;
    const wallet = String(req.params.wallet ?? '');
    const day = String(req.params.day ?? '');
    if (!DAY.test(day) || !await readableWallet(req.user!.id, owner, wallet)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await sendObject(res, archive, wallet, day);
  }));

  router.get('/v1/archive/mobile/linked', deps.authenticateWallet, withArchive(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const agents = await db.collection('agent_wallets').where('linked_human_user_id', '==', userId).limit(50).get();
    const after = afterDay(req);
    const out: Record<string, unknown>[] = [];
    for (const agent of agents.docs) {
      const days = await listArchiveDays(db, agent.id, after, 200);
      for (const d of days) if (d.confirmed) out.push(publicArchiveDay(d));
    }
    res.json({ days: out });
  }));

  router.get('/v1/archive/mobile/payments', deps.authenticateWallet, withArchive(async (req, res) => {
    const owner = await humanOwnerOf(req, res);
    if (!owner) return;
    const payments = await listArchivePayments(db, owner.wallet);
    res.json({ wallet: owner.wallet, payments: payments.map(publicArchivePayment) });
  }));

  router.get('/v1/archive/mobile/payments/:request_id', deps.authenticateWallet, withArchive(async (req, res, archive) => {
    const owner = await humanOwnerOf(req, res);
    if (owner) await readPayment(req, res, owner.wallet, archive);
  }));

  // ── scheduler ────────────────────────────────────────────────────────────────

  router.post('/v1/internal/scheduler/archive-sweep', async (req: Request, res: Response) => {
    if (!await deps.authenticateScheduler(req)) {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    const archive = deps.archiveDeps();
    if (archive === null) {
      res.json({ skipped: 'archive_not_configured' });
      return;
    }
    try {
      const paid = await sweepArchive(archive);
      const dormant = await sweepDormantOccurrences(archive.db);
      res.json({ ...paid, dormant_occurrences: dormant });
    } catch (error) {
      console.error('[archive-sweep] FAILED', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'archive_sweep_failed' });
    }
  });

  return router;
}
