import express, { type Request } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import {
  createMobilePEDeviceOwnershipGuard,
  getAuthenticatedHumanMobileDevice,
} from './pe-submit-mobile-device-ownership';

const DEVICE_ID = 'dev_mobile_owner_boundary';
const USER_ID = 'human_mobile_owner';

function device(ownerType: unknown, ownerUserId = USER_ID): Record<string, unknown> {
  return {
    device_id: DEVICE_ID,
    owner_type: ownerType,
    owner_user_id: ownerUserId,
    status: 'active',
    signing_method: 'secure_enclave_p256',
    signing_public_key: `04${'1'.repeat(128)}`,
    attestation_capability: 'hardware_full',
    platform: 'ios',
  };
}

function accessorOwnerDevice(): Record<string, unknown> {
  const row = device('human');
  delete row.owner_type;
  Object.defineProperty(row, 'owner_type', {
    enumerable: true,
    get: () => 'human',
  });
  return row;
}

function inheritedOwnerDevice(): Record<string, unknown> {
  const row = Object.create({ owner_type: 'human' }) as Record<string, unknown>;
  Object.assign(row, device(undefined));
  delete row.owner_type;
  return row;
}

function arrayDevice(): Record<string, unknown> {
  return Object.assign([], device('human')) as unknown as Record<string, unknown>;
}

const INVALID_ROWS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['missing', () => {
    const row = device(undefined);
    delete row.owner_type;
    return row;
  }],
  ['undefined', () => device(undefined)],
  ['null', () => device(null)],
  ['empty', () => device('')],
  ['wrong case', () => device('Human')],
  ['unknown', () => device('unknown')],
  ['number', () => device(0)],
  ['boolean', () => device(false)],
  ['object', () => device({})],
  ['wrapped', () => device(Object('human'))],
  ['owner value array', () => device(['human'])],
  ['accessor', accessorOwnerDevice],
  ['inherited', inheritedOwnerDevice],
  ['array document', arrayDevice],
  ['contradictory agent', () => device('agent')],
  ['contradictory human identity', () => device('human', 'other_user')],
];

type Effects = ReturnType<typeof economicEffects>;

function economicEffects() {
  return {
    signatureVerification: jest.fn(),
    attestationSelection: jest.fn(),
    idempotencyRead: jest.fn(),
    rateLimitRead: jest.fn(),
    cacheRead: jest.fn(),
    cacheWrite: jest.fn(),
    peTransaction: jest.fn(),
    peBuffer: jest.fn(),
    accrual: jest.fn(),
    foundation: jest.fn(),
    genesis: jest.fn(),
    statistics: jest.fn(),
  };
}

function expectNoEffect(effects: Effects): void {
  for (const effect of Object.values(effects)) {
    expect(effect).not.toHaveBeenCalled();
  }
}

function fakeDb(row: unknown, writes: jest.Mock, failLookup = false): Firestore {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (failLookup) throw new Error('firestore unavailable');
          return {
            exists: row !== undefined,
            data: () => row,
          };
        },
        set: (...args: unknown[]) => writes(...args),
        create: (...args: unknown[]) => writes(...args),
        update: (...args: unknown[]) => writes(...args),
      }),
    }),
  } as unknown as Firestore;
}

function appFor(row: unknown, failLookup = false) {
  const effects = economicEffects();
  const writes = jest.fn();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.user = { id: USER_ID, device_id: 'wallet_auth_device' };
    next();
  });
  app.post(
    '/v1/pe/submit/mobile',
    createMobilePEDeviceOwnershipGuard(fakeDb(row, writes, failLookup)),
    (req, res) => {
      const suppliedId = (req.body as { device_attestation_id?: unknown })?.device_attestation_id;
      const trusted = getAuthenticatedHumanMobileDevice(req, DEVICE_ID, USER_ID);
      // A device_attestation_id that SURVIVED the guard must have an
      // authenticated device — its absence would be a real wiring bug. An
      // unregistered id is normalized to undefined by the guard, so it reaches
      // here as "no device supplied" and records at software.
      if (typeof suppliedId === 'string' && suppliedId.length > 0 && !trusted) {
        res.status(500).json({ error: 'missing_authenticated_device' });
        return;
      }

      // These spies represent every downstream trust/economic class in the
      // production inline handler. The actual guard is mounted ahead of that
      // handler in server.ts; the source-wiring test pins that ordering.
      for (const effect of Object.values(effects)) effect();
      res.status(201).json({ accepted: true, tier: trusted ? 'verified' : 'software' });
    },
  );
  return { app, effects, writes };
}

describe('mobile verified-attestation owner_type boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(INVALID_ROWS)(
    'rejects %s ownership before any PE, cache, statistic, Genesis, Foundation, or accrual effect',
    async (_label, makeRow) => {
      const harness = appFor(makeRow());
      const response = await request(harness.app)
        .post('/v1/pe/submit/mobile')
        .send({ device_attestation_id: DEVICE_ID });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'invalid_device_ownership' });
      expectNoEffect(harness.effects);
      expect(harness.writes).not.toHaveBeenCalled();
    },
  );

  it('records at software (does NOT 401) when the supplied id is not a registered device', async () => {
    // The mobile app sends a local software fingerprint it never registered.
    // An unregistered id claims nobody's device, so it is normalized to absent
    // and the PE records at software — the pre-2026-07-14 record behaviour that
    // the fail-closed guard broke by 401-ing every mobile PE.
    const harness = appFor(undefined);
    const response = await request(harness.app)
      .post('/v1/pe/submit/mobile')
      .send({ device_attestation_id: DEVICE_ID });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ accepted: true, tier: 'software' });
    // Records: every downstream effect ran (the unregistered id did not block it).
    for (const effect of Object.values(harness.effects)) {
      expect(effect).toHaveBeenCalledTimes(1);
    }
    expect(harness.writes).not.toHaveBeenCalled();
  });

  it('STILL 401s a REGISTERED device owned by another user — RED control: the normalize-unregistered fix must not loosen cross-ownership', async () => {
    // The paired negative control for the test above. If a future change made
    // the guard pass ALL not-ok outcomes (not just device_not_registered), this
    // would flip 401 -> 201 and fail. A device that EXISTS but is owned by
    // someone else is a genuine ownership claim and stays fail-closed.
    const harness = appFor(device('human', 'other_user'));
    const response = await request(harness.app)
      .post('/v1/pe/submit/mobile')
      .send({ device_attestation_id: DEVICE_ID });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'invalid_device_ownership' });
    expectNoEffect(harness.effects);
    expect(harness.writes).not.toHaveBeenCalled();
  });

  it('fails closed on ownership lookup failure with no downstream effect', async () => {
    const harness = appFor(device('human'), true);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(harness.app)
      .post('/v1/pe/submit/mobile')
      .send({ device_attestation_id: DEVICE_ID });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'device_attestation_resolution_unavailable' });
    expectNoEffect(harness.effects);
    expect(harness.writes).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('admits the exact own human value for the matching authenticated user', async () => {
    const harness = appFor(device('human'));
    const response = await request(harness.app)
      .post('/v1/pe/submit/mobile')
      .send({ device_attestation_id: DEVICE_ID });

    expect(response.status).toBe(201);
    for (const effect of Object.values(harness.effects)) {
      expect(effect).toHaveBeenCalledTimes(1);
    }
    expect(harness.writes).not.toHaveBeenCalled();
  });
});
