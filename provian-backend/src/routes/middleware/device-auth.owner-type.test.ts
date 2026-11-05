import type { NextFunction, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const cacheGet = jest.fn<(key: string) => Promise<unknown>>();
const cacheSet = jest.fn<(key: string, value: unknown, ttl: number) => Promise<unknown>>();
const cacheDel = jest.fn<(key: string) => Promise<unknown>>();
const verifyCredential = jest.fn<() => Promise<boolean>>();
const verifySignature = jest.fn<() => Promise<{ ok: boolean }>>();

jest.mock('../../cache', () => ({
  cache: {
    get: (key: string) => cacheGet(key),
    set: (key: string, value: unknown, ttl: number) => cacheSet(key, value, ttl),
    del: (key: string) => cacheDel(key),
  },
}));

jest.mock('../../core/agent-wallet/api-key', () => ({
  verifyApiCredentialAsync: () => verifyCredential(),
}));

jest.mock('./device-signature-binding', () => ({
  verifyBoundDeviceSignature: () => verifySignature(),
}));

import { createDeviceAuthMiddleware, hasValidDeviceOwnerType } from './device-auth';

const DEVICE_KEY = `pdk_${'1'.repeat(32)}`;
const DEVICE_SECRET = `pds_${'2'.repeat(64)}`;
const DEVICE_PREFIX = DEVICE_KEY.slice(0, 20);
const DEVICE_ID = 'dev_owner_boundary';

const INVALID_OWNER_TYPES: readonly unknown[] = [
  undefined,
  null,
  '',
  'Human',
  'unknown',
  0,
  false,
  {},
  ['human'],
];

function device(ownerType: unknown): Record<string, unknown> {
  return {
    device_id: DEVICE_ID,
    device_name: 'Boundary device',
    device_type: 'coding_workstation',
    platform: 'test',
    owner_wallet_id: 'wallet_owner',
    owner_user_id: 'owner',
    owner_address: '0x1111111111111111111111111111111111111111',
    owner_type: ownerType,
    attestation_capability: 'software',
    device_key_hash: 'hash',
    device_key_salt: 'salt',
    device_key_prefix: DEVICE_PREFIX,
    status: 'active',
    created_at: 1,
    last_pe_at: null,
    total_pes: 0,
    signing_method: 'secure_enclave_p256',
    signing_public_key: `04${'1'.repeat(128)}`,
  };
}

type MalformedOwnerDocument = 'accessor' | 'inherited' | 'array';

const MALFORMED_SOURCE_CASES = (
  ['cache', 'firestore'] as const
).flatMap((source) => (
  ['accessor', 'inherited', 'array'] as const
).map((shape) => [source, shape] as const));

function malformedOwnerDevice(
  shape: MalformedOwnerDocument,
  signingMethod: 'bearer' | 'secure_enclave_p256',
): Record<string, unknown> {
  if (shape === 'array') {
    return Object.assign([], device('human'), {
      signing_method: signingMethod,
    }) as unknown as Record<string, unknown>;
  }

  const row = shape === 'inherited'
    ? Object.assign(
      Object.create({ owner_type: 'human' }) as Record<string, unknown>,
      { ...device(undefined), signing_method: signingMethod },
    )
    : { ...device('human'), signing_method: signingMethod };
  delete row.owner_type;
  if (shape === 'accessor') {
    Object.defineProperty(row, 'owner_type', {
      enumerable: true,
      get: () => 'human',
    });
  }
  return row;
}

function fakeDb(firestoreDevice: Record<string, unknown> | null): Firestore {
  return {
    collection: (collectionName: string) => ({
      doc: (_documentId: string) => ({
        get: async () => {
          if (collectionName === 'device_key_index') {
            return { exists: true, data: () => ({ device_id: DEVICE_ID }) };
          }
          return {
            exists: firestoreDevice !== null,
            data: () => firestoreDevice ?? undefined,
          };
        },
      }),
    }),
  } as unknown as Firestore;
}

function responseHarness(): {
  response: Response;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    response: { status } as unknown as Response,
    status,
    json,
  };
}

async function authenticate(
  authorization: string,
  db: Firestore,
): Promise<{ nextEconomicBoundary: jest.Mock; status: jest.Mock; json: jest.Mock; req: Request }> {
  const req = {
    headers: { authorization },
    method: 'POST',
    path: '/v1/pe/submit',
    originalUrl: '/v1/pe/submit',
    body: {},
  } as unknown as Request;
  const { response, status, json } = responseHarness();
  const nextEconomicBoundary = jest.fn();
  await createDeviceAuthMiddleware(db)(
    req,
    response,
    nextEconomicBoundary as unknown as NextFunction,
  );
  return { nextEconomicBoundary, status, json, req };
}

describe('device owner_type authentication boundary', () => {
  beforeEach(() => {
    cacheGet.mockReset();
    cacheSet.mockReset().mockResolvedValue(undefined);
    cacheDel.mockReset().mockResolvedValue(undefined);
    verifyCredential.mockReset().mockResolvedValue(true);
    verifySignature.mockReset().mockResolvedValue({ ok: true });
  });

  it('requires an own owner_type field on a non-array document', () => {
    const inherited = Object.assign(
      Object.create({ owner_type: 'human' }) as Record<string, unknown>,
      { device_id: DEVICE_ID },
    );
    const arrayWithOwner = Object.assign([], { owner_type: 'human' });

    expect(hasValidDeviceOwnerType(inherited)).toBe(false);
    expect(hasValidDeviceOwnerType(arrayWithOwner)).toBe(false);
    expect(hasValidDeviceOwnerType(Object('human'))).toBe(false);
    expect(hasValidDeviceOwnerType(device('human'))).toBe(true);
    expect(hasValidDeviceOwnerType(device('agent'))).toBe(true);
  });

  it.each(INVALID_OWNER_TYPES)(
    'rejects cached DeviceKey bearer ownership %p before credentials or economic handlers',
    async (ownerType) => {
      cacheGet.mockResolvedValue({ ...device(ownerType), signing_method: 'bearer' });
      const result = await authenticate(
        `DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`,
        fakeDb(null),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifyCredential).not.toHaveBeenCalled();
      expect(cacheDel).toHaveBeenCalledWith(`device:${DEVICE_PREFIX}`);
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_OWNER_TYPES)(
    'rejects Firestore DeviceKey bearer ownership %p before caching or economic handlers',
    async (ownerType) => {
      cacheGet.mockResolvedValue(null);
      const result = await authenticate(
        `DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`,
        fakeDb({ ...device(ownerType), signing_method: 'bearer' }),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifyCredential).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed ownership through the Basic bearer alias', async () => {
    cacheGet.mockResolvedValue({ ...device('unknown'), signing_method: 'bearer' });
    const basic = Buffer.from(`${DEVICE_KEY}:${DEVICE_SECRET}`).toString('base64');
    const result = await authenticate(`Basic ${basic}`, fakeDb(null));

    expect(result.status).toHaveBeenCalledWith(401);
    expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
    expect(verifyCredential).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SOURCE_CASES)(
    'rejects a %s/%s owner document on DeviceKey before credentials, caching, or economics',
    async (source, shape) => {
      const row = malformedOwnerDevice(shape, 'bearer');
      cacheGet.mockResolvedValue(source === 'cache' ? row : null);
      const result = await authenticate(
        `DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`,
        fakeDb(source === 'firestore' ? row : null),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifyCredential).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_OWNER_TYPES)(
    'rejects cached P-256 ownership %p before signature or economic handlers',
    async (ownerType) => {
      cacheGet.mockResolvedValue(device(ownerType));
      const result = await authenticate(
        `DeviceSignature ${DEVICE_ID}`,
        fakeDb(null),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifySignature).not.toHaveBeenCalled();
      expect(cacheDel).toHaveBeenCalledWith(`device:id:${DEVICE_ID}`);
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SOURCE_CASES)(
    'rejects a %s/%s owner document on P-256 before signature, caching, or economics',
    async (source, shape) => {
      const row = malformedOwnerDevice(shape, 'secure_enclave_p256');
      cacheGet.mockResolvedValue(source === 'cache' ? row : null);
      const result = await authenticate(
        `DeviceSignature ${DEVICE_ID}`,
        fakeDb(source === 'firestore' ? row : null),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifySignature).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_OWNER_TYPES)(
    'rejects Firestore P-256 ownership %p before caching, signature, or economic handlers',
    async (ownerType) => {
      cacheGet.mockResolvedValue(null);
      const result = await authenticate(
        `DeviceSignature ${DEVICE_ID}`,
        fakeDb(device(ownerType)),
      );

      expect(result.status).toHaveBeenCalledWith(401);
      expect(result.nextEconomicBoundary).not.toHaveBeenCalled();
      expect(verifySignature).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    },
  );

  it.each(['human', 'agent'] as const)(
    'accepts the exact cached DeviceKey owner_type %s',
    async (ownerType) => {
      cacheGet.mockResolvedValue({ ...device(ownerType), signing_method: 'bearer' });
      const result = await authenticate(
        `DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`,
        fakeDb(null),
      );

      expect(result.nextEconomicBoundary).toHaveBeenCalledTimes(1);
      expect(verifyCredential).toHaveBeenCalledTimes(1);
      expect(result.status).not.toHaveBeenCalled();
    },
  );

  it.each(['human', 'agent'] as const)(
    'accepts the exact cached P-256 owner_type %s',
    async (ownerType) => {
      cacheGet.mockResolvedValue(device(ownerType));
      const result = await authenticate(
        `DeviceSignature ${DEVICE_ID}`,
        fakeDb(null),
      );

      expect(result.nextEconomicBoundary).toHaveBeenCalledTimes(1);
      expect(verifySignature).toHaveBeenCalledTimes(1);
      expect(result.status).not.toHaveBeenCalled();
    },
  );

  // follow-through: the submit route prices and binds a request by HOW it
  // authenticated. Every device (SE included) holds a bearer secret, so the
  // middleware must say which path admitted THIS request.
  it('marks a DeviceKey bearer request on a Secure Enclave device as bearer, never device_signature', async () => {
    cacheGet.mockResolvedValue(device('human'));
    const result = await authenticate(`DeviceKey ${DEVICE_KEY}:${DEVICE_SECRET}`, fakeDb(null));
    expect(result.nextEconomicBoundary).toHaveBeenCalledTimes(1);
    expect(result.req.device?.signing_method).toBe('secure_enclave_p256');
    expect(result.req.deviceAuthMethod).toBe('bearer');
  });

  it('marks a verified DeviceSignature request as device_signature', async () => {
    cacheGet.mockResolvedValue(device('human'));
    const result = await authenticate(`DeviceSignature ${DEVICE_ID}`, fakeDb(null));
    expect(result.nextEconomicBoundary).toHaveBeenCalledTimes(1);
    expect(result.req.deviceAuthMethod).toBe('device_signature');
  });
});
