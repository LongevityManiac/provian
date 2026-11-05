/**
 * Output signing keys (: outputs produced on devices that don't hold the wallet key
 * are signed with that device's registered key).
 *
 * PUT /v1/devices/me/output-signing-key device auth — a BEARER observer device registers the
 * one P-256 key it signs outputs with (a Secure-Enclave
 * device already has its registered signing key → 409).
 * POST /v1/wallet/output-signing-key wallet auth — a phone registers its hardware
 * PE-attestation key (never the wallet key) as its
 * output key; answers the `aok_…` signer id.
 *
 * Body for both: `{ public_key: "04…" (SEC1 uncompressed P-256, hex), proof: <128 hex r‖s> }`,
 * where `proof` is ECDSA P-256 over SHA-256 of `outputKeyRegistrationMessage(kind, owner, key)`
 * (owner = the device id / the person's user id). One key per device or phone, immutable.
 * Registering a key writes no PE and pays nothing.
 */

import { Router, type Request, type Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { createDeviceAuthMiddleware } from './middleware/device-auth';
import { registerAppOutputKey, registerDeviceOutputKey } from '../core/pvt/output-signing-keys';

export function createDeviceOutputKeyRouter(deps: { readonly db: Firestore }): Router {
  const router = Router();
  const authenticateDevice = createDeviceAuthMiddleware(deps.db);
  router.put('/me/output-signing-key', authenticateDevice, async (req: Request, res: Response): Promise<void> => {
    try {
      const device = req.device;
      if (!device) { res.status(401).json({ error: 'Device authentication required' }); return; }
      const result = await registerDeviceOutputKey(deps.db, device, req.body);
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.status(result.created ? 201 : 200).json({
        registered: true, created: result.created,
        signer: { kind: 'device', id: result.key_id }, public_key: result.public_key,
      });
    } catch (error) {
      console.error('[OutputKeys] device register error:', error);
      res.status(500).json({ error: 'Failed to register output signing key' });
    }
  });
  return router;
}

/** `app.post('/v1/wallet/output-signing-key', authenticate, …)`: `req.user` is set by wallet auth. */
export function createWalletOutputKeyHandler(deps: { readonly db: Firestore }): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
      const result = await registerAppOutputKey(deps.db, userId, req.body, Date.now());
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
      res.status(result.created ? 201 : 200).json({
        registered: true, created: result.created,
        signer: { kind: 'app', id: result.key_id }, public_key: result.public_key,
      });
    } catch (error) {
      console.error('[OutputKeys] app register error:', error);
      res.status(500).json({ error: 'Failed to register output signing key' });
    }
  };
}
