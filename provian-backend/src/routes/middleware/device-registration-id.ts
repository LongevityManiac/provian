import crypto from 'crypto';
import type { Request } from 'express';

/** A caller-stable logical registration identifier, not a hardware identity. */
const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;

export function getDeviceRegistrationId(req: Request): string | null {
  const header = req.headers['idempotency-key'];
  const raw = typeof header === 'string'
    ? header
    : typeof req.body?.registration_id === 'string'
      ? req.body.registration_id
      : null;
  if (raw === null) return null;
  const normalized = raw.trim();
  return REGISTRATION_ID.test(normalized) ? normalized : null;
}

export function hashDeviceRegistrationId(registrationId: string): string {
  if (!REGISTRATION_ID.test(registrationId)) {
    throw new Error('invalid_device_registration_id');
  }
  return crypto.createHash('sha256').update(registrationId, 'utf8').digest('hex');
}
