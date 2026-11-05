import express, { type Request } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

import { createDeviceRouter } from './devices';

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
  Object('human'),
];

const MALFORMED_MANAGEMENT_CASES: Array<[
  'get' | 'patch' | 'delete',
  'accessor' | 'inherited' | 'array',
]> = [
  ['get', 'accessor'],
  ['get', 'inherited'],
  ['get', 'array'],
  ['patch', 'accessor'],
  ['patch', 'inherited'],
  ['patch', 'array'],
  ['delete', 'accessor'],
  ['delete', 'inherited'],
  ['delete', 'array'],
];

type FakeState = {
  updates: Array<Record<string, unknown>>;
};

function device(ownerType: unknown): Record<string, unknown> {
  return {
    device_id: 'dev_management',
    device_name: 'Managed device',
    device_type: 'coding_workstation',
    platform: 'test',
    owner_wallet_id: 'wallet_human',
    owner_user_id: 'human_user',
    owner_address: '0x1111111111111111111111111111111111111111',
    owner_type: ownerType,
    attestation_capability: 'software',
    device_key_hash: 'hash',
    device_key_salt: 'salt',
    device_key_prefix: 'pdk_prefix',
    status: 'active',
    created_at: 1,
    last_pe_at: null,
    total_pes: 0,
  };
}

function malformedOwnerDocument(shape: 'accessor' | 'inherited' | 'array'):
Record<string, unknown> {
  if (shape === 'array') {
    return Object.assign([], device('human')) as unknown as Record<string, unknown>;
  }
  const row = shape === 'inherited'
    ? Object.assign(
      Object.create({ owner_type: 'human' }) as Record<string, unknown>,
      device(undefined),
    )
    : device('human');
  delete row.owner_type;
  if (shape === 'accessor') {
    Object.defineProperty(row, 'owner_type', {
      enumerable: true,
      get: () => 'human',
    });
  }
  return row;
}

function fakeDb(row: Record<string, unknown>, state: FakeState): Firestore {
  const query = {
    where: (_field: string, _operator: string, _value: unknown) => query,
    orderBy: (_field: string, _direction: string) => query,
    get: async () => ({
      docs: [{ data: () => row }],
    }),
  };
  return {
    collection: (_collectionName: string) => ({
      ...query,
      doc: (_documentId: string) => ({
        get: async () => ({ exists: true, data: () => row }),
        update: async (value: Record<string, unknown>) => {
          state.updates.push(value);
        },
      }),
    }),
  } as unknown as Firestore;
}

function appFor(row: Record<string, unknown>) {
  const state: FakeState = { updates: [] };
  const peBuffer = { enqueue: jest.fn() };
  const recordPEAccrual = jest.fn(async () => undefined);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.user = { id: 'human_user', device_id: 'auth_device' };
    next();
  });
  app.use(createDeviceRouter({
    db: fakeDb(row, state),
    cache: {
      checkRateLimit: async () => ({ allowed: true }),
      get: async () => null,
      set: async () => undefined,
    },
    peBuffer,
    recordPEAccrual,
  }));
  return { app, state, peBuffer, recordPEAccrual };
}

describe('device management owner_type boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([...INVALID_OWNER_TYPES, 'agent'])(
    'DELETE rejects invalid or contradictory ownership %p with no PE or economic effect',
    async (ownerType) => {
      const harness = appFor(device(ownerType));
      const response = await request(harness.app).delete('/dev_management');

      expect(response.status).toBe(403);
      expect(harness.state.updates).toEqual([]);
      expect(harness.peBuffer.enqueue).not.toHaveBeenCalled();
      expect(harness.recordPEAccrual).not.toHaveBeenCalled();
    },
  );

  it.each([...INVALID_OWNER_TYPES, 'agent'])(
    'PATCH rejects invalid or contradictory ownership %p with no mutation',
    async (ownerType) => {
      const harness = appFor(device(ownerType));
      const response = await request(harness.app)
        .patch('/dev_management')
        .send({ device_name: 'Changed' });

      expect(response.status).toBe(403);
      expect(harness.state.updates).toEqual([]);
      expect(harness.peBuffer.enqueue).not.toHaveBeenCalled();
      expect(harness.recordPEAccrual).not.toHaveBeenCalled();
    },
  );

  it.each([...INVALID_OWNER_TYPES, 'agent'])(
    'GET rejects invalid or contradictory ownership %p instead of inferring human',
    async (ownerType) => {
      const harness = appFor(device(ownerType));
      const response = await request(harness.app).get('/');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Invalid device ownership record' });
      expect(harness.state.updates).toEqual([]);
      expect(harness.peBuffer.enqueue).not.toHaveBeenCalled();
      expect(harness.recordPEAccrual).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_MANAGEMENT_CASES)(
    '%s rejects a %s ownership document before mutation, PE, or accrual',
    async (verb, shape) => {
      const harness = appFor(malformedOwnerDocument(shape));
      const response = verb === 'get'
        ? await request(harness.app).get('/')
        : verb === 'patch'
          ? await request(harness.app).patch('/dev_management').send({ device_name: 'Changed' })
          : await request(harness.app).delete('/dev_management');

      expect(response.status).toBe(403);
      expect(harness.state.updates).toEqual([]);
      expect(harness.peBuffer.enqueue).not.toHaveBeenCalled();
      expect(harness.recordPEAccrual).not.toHaveBeenCalled();
    },
  );
});
