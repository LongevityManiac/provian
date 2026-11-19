import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import {
  buildDeviceBootstrapCommand,
  buildDeviceBootstrapCommandWindows,
} from '../core/device-bootstrap-script';
import { resolveRelayUrl } from '../core/setup-command';

const COLLECTION = 'computer_pairings';
const PAIRING_TIME_MS = 15 * 60_000;
const SETUP_TIME_MS = 60 * 60_000;
const CODE = /^[a-f0-9]{12}$/;
const BROWSER_KEY = /^[a-f0-9]{64}$/;

interface Pairing {
  browserHash: string;
  expires_at: number;
  userId?: string;
  token?: string;
}

interface SetupToken {
  pairing_device_id?: string;
}

interface PairedDevice {
  status?: string;
  owner_user_id?: string;
  owner_type?: string;
  device_name?: string;
  capture_health?: { updated_at?: number };
  last_pe_at?: number | null;
}

interface Dependencies {
  db: Firestore;
  authenticate: RequestHandler;
  checkRateLimitStrict: (key: string, limit: number, windowSeconds: number) =>
    Promise<{ allowed: boolean; error?: string }>;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createComputerPairingRouter({ db, authenticate, checkRateLimitStrict }: Dependencies): Router {
  const router = Router();
  const pairings = db.collection(COLLECTION);
  const tokens = db.collection('setup_tokens');

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/start', async (req, res) => {
    try {
      const key: unknown = req.body?.browserKey;
      if (typeof key !== 'string' || !BROWSER_KEY.test(key)) {
        return res.status(400).json({ error: 'invalid_browser_key' });
      }
      const browserHash = hash(key);
      const code = browserHash.slice(0, 12);
      const limited = await checkRateLimitStrict(`computer-pairing:start:${req.ip}`, 10, 60);
      if (limited.error) return res.status(503).json({ error: 'temporarily_unavailable' });
      if (!limited.allowed) return res.status(429).json({ error: 'try_later' });

      const expiresAt = await db.runTransaction(async (transaction) => {
        const ref = pairings.doc(code);
        const now = Date.now();
        const existing = (await transaction.get(ref)).data() as Pairing | undefined;
        if (existing && existing.expires_at > now) {
          return existing.browserHash === browserHash ? existing.expires_at : null;
        }
        const expires_at = now + PAIRING_TIME_MS;
        transaction.set(ref, { browserHash, expires_at } satisfies Pairing);
        return expires_at;
      });
      if (!expiresAt) return res.status(409).json({ error: 'try_new_code' });
      return res.status(201).json({ code, expiresAt });
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.post('/confirm', authenticate, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'wallet_authentication_required' });
      const code: unknown = req.body?.code;
      if (typeof code !== 'string' || !CODE.test(code)) {
        return res.status(400).json({ error: 'invalid_code' });
      }
      const limited = await checkRateLimitStrict(`computer-pairing:confirm:${userId}`, 15, 300);
      if (limited.error) return res.status(503).json({ error: 'temporarily_unavailable' });
      if (!limited.allowed) return res.status(429).json({ error: 'try_later' });

      const ref = pairings.doc(code);
      const token = randomBytes(32).toString('hex');
      const result = await db.runTransaction(async (transaction) => {
        const session = (await transaction.get(ref)).data() as Pairing | undefined;
        const now = Date.now();
        if (!session || session.expires_at <= now) return 404;
        if (session.userId === userId) return 200;
        if (session.userId) return 404;

        const unused = await transaction.get(
          tokens.where('user_id', '==', userId).where('used', '==', false),
        );
        const active = unused.docs.filter((doc) => {
          const data = doc.data();
          return data.type === 'device_registration' && data.expires_at > now;
        });
        if (active.length >= 5) return 429;

        const expires_at = now + SETUP_TIME_MS;
        transaction.create(tokens.doc(token), {
          user_id: userId,
          type: 'device_registration',
          created_at: now,
          expires_at,
          used: false,
          computer_pairing: true,
        });
        transaction.update(ref, { userId, token, expires_at });
        return 200;
      });
      return result === 200
        ? res.json({ state: 'waiting_for_computer' })
        : res.status(result).json({ error: result === 429 ? 'try_later' : 'code_unavailable' });
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  async function connection(session: Pairing) {
    if (!session.token || !session.userId) return null;
    const setup = (await tokens.doc(session.token).get()).data() as SetupToken | undefined;
    if (!setup?.pairing_device_id) return null;
    const device = (await db.collection('devices').doc(setup.pairing_device_id).get()).data() as PairedDevice | undefined;
    if (device?.owner_type !== 'human' || device.owner_user_id !== session.userId
      || device.status !== 'active' || !device.device_name || !device.capture_health?.updated_at) return null;
    return { state: 'connected', name: device.device_name, deviceId: setup.pairing_device_id,
      firstProof: typeof device.last_pe_at === 'number' && device.last_pe_at > 0 } as const;
  }

  router.post('/browser-status', async (req, res) => {
    try {
      const key: unknown = req.body?.browserKey;
      if (typeof key !== 'string' || !BROWSER_KEY.test(key)) {
        return res.status(400).json({ error: 'invalid_browser_key' });
      }
      const browserHash = hash(key);
      const session = (await pairings.doc(browserHash.slice(0, 12)).get()).data() as Pairing | undefined;
      if (!session || session.browserHash !== browserHash || session.expires_at <= Date.now()) {
        return res.status(404).json({ error: 'code_unavailable' });
      }
      if (!session.token) return res.json({ state: 'waiting_for_phone' });

      const connected = await connection(session);
      if (connected) return res.json({ state: connected.state, name: connected.name, firstProof: connected.firstProof });
      const params = { token: session.token, relayUrl: resolveRelayUrl() };
      return res.json({
        state: 'waiting_for_computer',
        macLinux: buildDeviceBootstrapCommand(params),
        windows: buildDeviceBootstrapCommandWindows(params),
      });
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.post('/phone-status', authenticate, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'wallet_authentication_required' });
      const code: unknown = req.body?.code;
      if (typeof code !== 'string' || !CODE.test(code)) {
        return res.status(400).json({ error: 'invalid_code' });
      }
      const session = (await pairings.doc(code).get()).data() as Pairing | undefined;
      if (!session || session.userId !== userId || session.expires_at <= Date.now()) {
        return res.status(404).json({ error: 'code_unavailable' });
      }
      return res.json(await connection(session) ?? { state: 'waiting_for_computer' });
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  return router;
}
