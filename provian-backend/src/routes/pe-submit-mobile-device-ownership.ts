import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';

import { hasValidDeviceOwnerType } from './middleware/device-auth';

export type AuthenticatedHumanMobileDevice = Record<string, unknown> & {
  owner_type: 'human';
  owner_user_id: string;
};

type AuthenticatedRequestDevice = {
  deviceId: string;
  userId: string;
  device: AuthenticatedHumanMobileDevice;
};

// Request-scoped only: this is not an authentication cache. The WeakMap keeps
// the validated Firestore snapshot module-private and prevents callers from
// forging a trusted device by adding a property to req.
const authenticatedRequestDevices = new WeakMap<Request, AuthenticatedRequestDevice>();

export type MobileDeviceOwnershipOutcome =
  | { ok: true; device: AuthenticatedHumanMobileDevice }
  | { ok: false; error: 'invalid_device_ownership' | 'device_not_registered' };

/**
 * Authenticate a DeviceDocument before the mobile PE path trusts it.
 *
 * Firestore data is runtime evidence. Only an own data property whose exact
 * value is `human` is valid for this human-wallet endpoint. `agent` is a valid
 * owner type in general, but contradictory here and therefore denied.
 *
 * Two distinct not-ok cases, because they mean different things:
 *   - `device_not_registered`: no `devices/{id}` doc exists. The supplied id
 *     claims NOBODY's device, so it is not an ownership violation — it is just a
 *     value that references nothing (the mobile app sends a local software
 *     fingerprint before the phone is ever registered as an SE device). The
 *     guard normalizes this to "no device supplied".
 *   - `invalid_device_ownership`: a device DOES exist but is owned by another
 *     user or is an agent device. That is a genuine cross-ownership claim and
 *     still fails closed (the Gate-1 invariant, D-`67d389b7`).
 */
export async function authenticateHumanMobileDeviceOwnership(input: {
  db: Firestore;
  deviceId: string;
  userId: string;
}): Promise<MobileDeviceOwnershipOutcome> {
  const deviceDoc = await input.db.collection('devices').doc(input.deviceId).get();
  if (!deviceDoc.exists) {
    return { ok: false, error: 'device_not_registered' };
  }

  const rawDevice = deviceDoc.data();
  if (
    !hasValidDeviceOwnerType(rawDevice)
    || rawDevice.owner_type !== 'human'
    || rawDevice.owner_user_id !== input.userId
  ) {
    return { ok: false, error: 'invalid_device_ownership' };
  }

  return {
    ok: true,
    device: rawDevice as AuthenticatedHumanMobileDevice,
  };
}

/**
 * Actual /v1/pe/submit/mobile ownership gate. It runs after wallet auth and
 * before the route handler, so a device owned by ANOTHER party cannot reach
 * signature/attestation selection, idempotency, PE creation, or economics.
 *
 * An UNREGISTERED supplied id (references no `devices/{id}` doc) is NOT such a
 * violation — the guard normalizes it to absent (sets `req.body
 * .device_attestation_id = undefined`) and lets the request through, so the PE
 * records at software tier. This is the pre-2026-07-14 record behaviour: before
 * the fail-closed guard landed, the mobile app's local software fingerprint
 * recorded fine; the guard then 401-ed EVERY mobile PE because the app never
 * registers that id as a device. Normalizing (rather than 401-ing) an
 * unregistered id restores recording for all deployed installs while keeping
 * the cross-ownership fail-closed intact. It grants no elevated trust: the
 * downstream tier resolver only trusts an id that authenticated here, so a
 * normalized (absent) id stays software.
 */
export function createMobilePEDeviceOwnershipGuard(db: Firestore): RequestHandler {
  return async function mobilePEDeviceOwnershipGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const deviceId = req.body?.device_attestation_id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      next();
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const outcome = await authenticateHumanMobileDeviceOwnership({
        db,
        deviceId,
        userId,
      });
      if (!outcome.ok) {
        // Unregistered id → normalize to "no device supplied" and record at
        // software. A registered device owned by someone else / an agent still
        // fails closed with a 401 (the Gate-1 ownership invariant).
        if (outcome.error === 'device_not_registered') {
          req.body.device_attestation_id = undefined;
          next();
          return;
        }
        res.status(401).json({ error: outcome.error });
        return;
      }

      authenticatedRequestDevices.set(req, {
        deviceId,
        userId,
        device: outcome.device,
      });
      next();
    } catch (error) {
      console.error('[PESubmitMobile] device ownership resolution unavailable', error);
      res.status(503).json({ error: 'device_attestation_resolution_unavailable' });
    }
  };
}

/**
 * Return only the exact request/device/user tuple authenticated by the guard.
 * Re-run the runtime guard before trust so later refactors cannot turn the
 * request-scoped handoff into an ownership inference.
 */
export function getAuthenticatedHumanMobileDevice(
  req: Request,
  deviceId: string,
  userId: string,
): AuthenticatedHumanMobileDevice | null {
  const authenticated = authenticatedRequestDevices.get(req);
  if (
    !authenticated
    || authenticated.deviceId !== deviceId
    || authenticated.userId !== userId
    || !hasValidDeviceOwnerType(authenticated.device)
    || authenticated.device.owner_type !== 'human'
    || authenticated.device.owner_user_id !== userId
  ) {
    return null;
  }
  return authenticated.device;
}

/**
 * PE METER — the batch lane names its device in the batch, not in `device_attestation_id`. Run the
 * same ownership check for that id and, when it passes, register the request-scoped handoff the
 * tier resolver reads. A registered device owned by anyone else is refused; an unregistered id
 * records at software, exactly as the guard above normalizes it.
 */
export async function authenticateRequestHumanMobileDevice(
  db: Firestore,
  req: Request,
  deviceId: string,
): Promise<MobileDeviceOwnershipOutcome> {
  const userId = req.user?.id;
  if (!userId) return { ok: false, error: 'invalid_device_ownership' };
  const outcome = await authenticateHumanMobileDeviceOwnership({ db, deviceId, userId });
  if (outcome.ok) authenticatedRequestDevices.set(req, { deviceId, userId, device: outcome.device });
  return outcome;
}
