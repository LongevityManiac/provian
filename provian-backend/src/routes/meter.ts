import { withPrivateReadSession } from '../core/provenance/private-store';
import { resolveAgentChainOwnerId } from '../core/agent-wallet/agent-chain-owner';
import {unwrapPrivateBatch} from '../core/meter/private-pricing';
import {verifyApiCredentialAsync} from '../core/agent-wallet/api-key';
/**
 * PE METER routes (: the relay is a meter, not an archive).
 *
 * POST /v1/meter/batch one signed daily batch from a registered device (daemon, SDK,
 * any HTTP client holding a device key). Device auth; the body
 * must be bound (DeviceSignature, or X-Provian-Body-HMAC).
 * GET /v1/meter/tip this device's latest accepted batch (seq, hashes) — resync.
 * GET /v1/meter/mailbox sealed PEs waiting for this device's owner (agent) — device auth.
 * POST /v1/meter/mailbox/ack drop items the owner has filed in its own storage.
 * POST /v1/meter/batch-proofs the anchoring record (identity, act leaves, anchor proof) of
 * batches whose PEs were sealed to this owner — PE export.
 *
 * The phone's routes (wallet auth) are mounted from server.ts beside the mobile lane.
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { createDeviceAuthMiddleware } from './middleware/device-auth';
import type { DeviceDocument } from './middleware/device-auth';
import type { cache as sharedCache } from '../cache';
import { deviceActToAccrualParams, laneLineageWrite, openDeviceBatchLane } from '../core/meter/device-act';
import { ingestMeterBatch, type MeterLane } from '../core/meter/meter-ingest';
import { ackMailbox, listMailbox, stageSealedCopies, peekMailbox } from '../core/meter/pe-mailbox';
import { transitDigest, validTransitReceipt } from '../core/meter/transit-receipt';
import { listMeterProofs, selectedProofHashes } from '../core/meter/meter-proofs';
import { readBatchProofsRequest } from '../core/meter/batch-proofs';
import { readMessageKey } from '../core/commons/message-keys';
import { METER_DEVICE_TIPS_COLLECTION, type MeterDeviceTip } from '../core/meter/meter-store';
import { METER_GENESIS_PREV_HASH } from '../core/meter/meter-wire';

export interface MeterRouterDeps {
  readonly db: Firestore;
  readonly cache: typeof sharedCache;
}

/**
 * Was this request body bound to the authenticated device? DeviceSignature: the middleware
 * verified the P-256 body signature. Bearer: a present X-Provian-Body-HMAC must verify (a
 * mismatch is a 401). Returns null when a present HMAC fails.
 */
export function deviceBodyBinding(req: Request): { bound: boolean; signatureAuthenticated: boolean } | null {
  const signatureAuthenticated = req.deviceAuthMethod === 'device_signature';
  if (signatureAuthenticated) return { bound: true, signatureAuthenticated };
  const header = req.headers['x-provian-body-hmac'];
  if (typeof header !== 'string' || header.length === 0) return { bound: false, signatureAuthenticated };
  const auth = req.headers.authorization || '';
  let secret = '';
  if (auth.startsWith('DeviceKey ')) {
    const tail = auth.slice('DeviceKey '.length);
    const i = tail.indexOf(':');
    if (i !== -1) secret = tail.slice(i + 1);
  } else if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString();
      const i = decoded.indexOf(':');
      if (i !== -1) secret = decoded.slice(i + 1);
    } catch {
      secret = '';
    }
  }
  if (!secret) return null;
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header, 'hex');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return { bound: true, signatureAuthenticated };
}

/** The recipient key for a device's owner's mailbox (agents: `agent:<id>`; humans: `human:<id>`). */
export async function deviceOwnerRecipient(db: Firestore, cache: MeterRouterDeps['cache'], device: DeviceDocument): Promise<string> {
  const ownerId = await resolveAgentChainOwnerId({ db, cache }, device);
  return device.owner_type === 'agent' ? `agent:${ownerId}` : `human:${ownerId}`;
}

async function linkedHumanOf(db: Firestore, device: DeviceDocument): Promise<string | null> {
  if (device.owner_type !== 'agent' || !device.owner_wallet_id) return null;
  const snap = await db.collection('agent_wallets').doc(device.owner_wallet_id).get();
  const id = snap.exists ? snap.data()?.linked_human_user_id : null;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createMeterRouter(deps: MeterRouterDeps): Router {
  const { db, cache } = deps;
  const router = Router();
  router.use((_req, _res, next) => withPrivateReadSession(() => next()));
  const authenticateDevice = createDeviceAuthMiddleware(db);

  // Ciphertext redelivery only: never prices an act, changes a tip or creates a mint claim.
  router.post('/transit', authenticateDevice, async (req: Request, res: Response) => {
    try {
      const device = req.device;
      if (!device || deviceBodyBinding(req)?.bound !== true) {
        res.status(401).json({ error: 'body_bound_device_auth_required' }); return;
      }
      const raw = req.body as { batch_hash?: unknown; sealed?: unknown; transit_receipt?: unknown; transit_recipients?: unknown };
      if (typeof raw.batch_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.batch_hash)
        || !Array.isArray(raw.sealed) || raw.sealed.length > 500
        || raw.sealed.some((s: unknown) => {
          if (!s || typeof s !== 'object') return true;
          const copy = s as Record<string, unknown>;
          return typeof copy.to !== 'string' || typeof copy.pe_id !== 'string' || copy.pe_id.length > 240
            || typeof copy.box !== 'string' || copy.box.length > 262_144;
        })) {
        res.status(400).json({ error: 'transit_invalid' }); return;
      }
      const rate = await cache.checkRateLimit(`rl:metertransit:${device.device_id}`, 30, 3600);
      if (!rate.allowed) { res.status(429).json({ error: 'Rate limit exceeded' }); return; }
      const recipient = await deviceOwnerRecipient(db, cache, device);
      const actorId = recipient.slice(recipient.indexOf(':') + 1);
      let bindings: Readonly<Record<string, string>> = {};
      if (raw.transit_recipients && typeof raw.transit_recipients === 'object' && !Array.isArray(raw.transit_recipients)) {
        const pairs = Object.entries(raw.transit_recipients);
        if (pairs.length > 2 || pairs.some(([k, v]) => !['owner', 'linked_human'].includes(k) || typeof v !== 'string')) {
          res.status(400).json({ error: 'transit_recipients_invalid' }); return;
        }
        bindings = raw.transit_recipients as Record<string, string>;
      }
      if (!validTransitReceipt(raw.transit_receipt, actorId, device.device_id, raw.batch_hash, bindings, raw.sealed as import('../core/meter/meter-wire').SealedCopy[])) {
        const accepted = (await db.collection('meter_batches_v1').doc(raw.batch_hash).get()).data();
        if (accepted?.device_id !== device.device_id || accepted?.actor_id !== actorId
          || accepted?.transit_digest !== transitDigest(raw.sealed as import('../core/meter/meter-wire').SealedCopy[])) {
          res.status(403).json({ error: 'transit_batch_not_owned' }); return;
        }
        bindings = (accepted.transit_recipients ?? {}) as Record<string, string>;
      }
      const linkedHuman = await linkedHumanOf(db, device);
      const staged = await stageSealedCopies(db, {
        batchHash: raw.batch_hash, deviceId: device.device_id, actorId,
        sealed: raw.sealed as import('../core/meter/meter-wire').SealedCopy[],
        resolveRecipient: to => {
          const current = to === 'linked_human' && linkedHuman ? `human:${linkedHuman}`
            : to === 'owner' && device.owner_type === 'human' ? recipient : null;
          return current !== null && bindings[to] === current ? current : null;
        },
        nowMs: Date.now(),
      });
      res.json({ complete: staged.pending === 0 && staged.refused === 0, pending: staged.pending, refused: staged.refused });
    } catch (error) {
      console.error('[meter] transit resend failed:', error);
      res.status(500).json({ error: 'transit_resend_failed' });
    }
  });

  router.post('/batch', authenticateDevice, async (req: Request, res: Response) => {
    try {
      const device = req.device;
      if (!device) {
        res.status(401).json({ error: 'Device authentication required' });
        return;
      }
      const binding = deviceBodyBinding(req);
      if (binding === null) {
        res.status(401).json({ error: 'X-Provian-Body-HMAC verification failed' });
        return;
      }
      // Transport throttle (clients send daily, plus one before a presentation or payout; the meter also refuses a batch inside 5 minutes).
      const rate = await cache.checkRateLimit(`rl:meterbatch:${device.device_id}`, 30, 3600);
      if (!rate.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded', retry_after: rate.retryAfter ?? 60 });
        return;
      }
      let privacySecret:string|undefined;
      if(binding.signatureAuthenticated) {
        const candidate=req.headers['x-provian-privacy-credential'];
        if(typeof candidate==='string'&&candidate.includes(':')) {
          const split=candidate.indexOf(':');
          if(await verifyApiCredentialAsync(candidate.slice(0,split),candidate.slice(split+1),device.device_key_hash,device.device_key_salt))privacySecret=candidate.slice(split+1);
        }
      }else {
        const auth=req.headers.authorization??'';
        const raw=auth.startsWith('DeviceKey ')?auth.slice(10):auth.startsWith('Basic ')?Buffer.from(auth.slice(6),'base64').toString():'';
        if(raw.includes(':'))privacySecret=raw.slice(raw.indexOf(':')+1);
      }
      const transport=unwrapPrivateBatch(req.body,privacySecret);
      const receivedAtMs = Date.now();
      const deviceLane = await openDeviceBatchLane({
        db, cache, device, signatureAuthenticated: binding.signatureAuthenticated, bodyBound: binding.bound, receivedAtMs, privacyOpenings:transport.openings,
      });
      const linkedHuman = await linkedHumanOf(db, device);
      const lane: MeterLane = {
        deviceId: device.device_id,
        actorId: deviceLane.ownerId,
        resolveSealedRecipient: (to) => {
          if (to === 'linked_human' && linkedHuman) return `human:${linkedHuman}`;
          if (to === 'owner' && device.owner_type === 'human') return `human:${deviceLane.ownerId}`;
          return null;
        },
        mapAct: (act, relayPeId) => deviceActToAccrualParams(deviceLane, act, relayPeId),
        // : a device's batches are hash-chained and sequenced (the tip refuses a replay).
        singleLaneCut: true,
        extraWrites: () => {
          const w = laneLineageWrite(deviceLane);
          return w ? [w] : [];
        },
      };
      const result = await ingestMeterBatch(db, lane, transport.batch, receivedAtMs);
      if (result.status === 201 || result.status === 200) {
        db.collection('devices').doc(device.device_id).update({
          last_pe_at: receivedAtMs,
        }).catch(() => {});
      }
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error('[meter] batch ingest failed:', error);
      res.status(500).json({ error: 'batch_ingest_failed' });
    }
  });

  router.get('/tip', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    const snap = await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(device.device_id).get();
    const tip = snap.exists ? (snap.data() as MeterDeviceTip) : null;
    res.json({
      device_id: device.device_id,
      seq: tip?.seq ?? 0,
      batch_hash: tip?.batch_hash ?? METER_GENESIS_PREV_HASH,
      last_pe_hash: tip?.last_pe_hash ?? METER_GENESIS_PREV_HASH,
      accepted_at_ms: tip?.accepted_at_ms ?? null,
    });
  });

  // Whom this device seals its PEs to, with the published key to seal under (a sealed box the relay
  // cannot open). An agent's device seals to its linked human; a person's own non-phone device
  // seals to that person. No published key → nothing to seal to yet (the device keeps its PEs).
  router.get('/seal-targets', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    const targets: { to: string; party_id: string; pubkey_b64u: string; key_version: number }[] = [];
    if (device.owner_type === 'agent' && device.owner_wallet_id) {
      const agent = await db.collection('agent_wallets').doc(device.owner_wallet_id).get();
      const humanWalletId = agent.exists ? agent.data()?.linked_human_wallet_id : null;
      if (typeof humanWalletId === 'string' && humanWalletId.length > 0) {
        const key = await readMessageKey(db, humanWalletId);
        if (key) targets.push({ to: 'linked_human', party_id: humanWalletId, pubkey_b64u: key.pubkey_b64u, key_version: key.key_version });
      }
    } else if (device.owner_type === 'human') {
      const wallets = await db.collection('wallets').where('user_id', '==', device.owner_user_id).limit(1).get();
      const walletId = wallets.docs[0]?.id;
      if (walletId) {
        const key = await readMessageKey(db, walletId);
        if (key) targets.push({ to: 'owner', party_id: walletId, pubkey_b64u: key.pubkey_b64u, key_version: key.key_version });
      }
    }
    res.json({ targets });
  });

  // The device's anchored batches, each with its inclusion proof in that day's on-chain root.
  router.get('/proofs', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    const afterSeq = Number(req.query.after_seq ?? 0);
    let hashes: readonly string[] | undefined;
    try { hashes = selectedProofHashes(req.query.batch_hashes); } catch { res.status(400).json({ error: 'batch_hashes_invalid' }); return; }
    res.json(await listMeterProofs(db, device.device_id, Number.isSafeInteger(afterSeq) ? afterSeq : 0, 200, hashes));
  });

  // PE export: the anchoring record of batches whose PEs were sealed to this device's owner (a
  // linked agent's mailbox copies, relay-authored PEs), so the owner can build their inclusion
  // proofs. Authorization model (core/meter/batch-proofs.ts): any registered device presenting a
  // batch hash gets that batch's record — a batch hash is a sha256 over the whole batch, disclosed
  // only to its device, to recipients of its sealed copies and inside presentations — and the
  // record carries hashes and ids only (never a PE, pricing input, claim key or points). Read-only.
  router.post('/batch-proofs', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    try {
      const result = await readBatchProofsRequest(db, req.body);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result.value);
    } catch (error) {
      console.error('[meter] batch-proofs read failed:', error);
      res.status(500).json({ error: 'batch_proofs_failed' });
    }
  });

  router.get('/mailbox/peek', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) { res.status(401).json({ error: 'Device authentication required' }); return; }
    const owner = await resolveAgentChainOwnerId({ db, cache }, device);
    res.json(await peekMailbox(db, `${device.owner_type === 'agent' ? 'agent' : 'human'}:${owner}`));
  });

  router.get('/mailbox', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    const recipient = await deviceOwnerRecipient(db, cache, device);
    const limit = Number(req.query.limit ?? 100);
    const after = typeof req.query.after === 'string' ? req.query.after : null;
    res.json(await listMailbox(db, recipient, { limit: Number.isFinite(limit) ? limit : 100, afterId: after }));
  });

  router.post('/mailbox/ack', authenticateDevice, async (req: Request, res: Response) => {
    const device = req.device;
    if (!device) {
      res.status(401).json({ error: 'Device authentication required' });
      return;
    }
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const recipient = await deviceOwnerRecipient(db, cache, device);
    res.json({ dropped: await ackMailbox(db, recipient, ids) });
  });

  return router;
}
