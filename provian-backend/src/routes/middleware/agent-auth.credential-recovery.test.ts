import { describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';

const cacheGet = jest.fn<() => Promise<unknown>>();
const cacheDel = jest.fn<(key: string) => Promise<void>>(async () => undefined);
jest.mock('../../cache', () => ({
  cache: {
    get: () => cacheGet(),
    set: jest.fn(async () => undefined),
    del: (key: string) => cacheDel(key),
  },
}));

import { createFakeFirestore } from '../../core/pvt/__test-helpers__/fake-firestore';
import { createAgentAuthMiddleware } from './agent-auth';

describe('agent auth credential recovery invalidation', () => {
  test('a cached wallet cannot keep a deleted superseded API prefix alive', async () => {
    const oldKey = `pvn_live_${'a'.repeat(32)}`;
    const oldPrefix = oldKey.slice(0, 24);
    cacheGet.mockResolvedValueOnce({
      id: 'wallet_aw_recovered',
      agent_id: 'recovered-agent',
      api_key_prefix: oldPrefix,
      api_key_hash: '00',
      api_key_salt: '00',
      status: 'active',
    });
    const fake = createFakeFirestore();
    const app = express();
    app.get('/protected', createAgentAuthMiddleware(fake as unknown as Firestore), (_req, res) => {
      res.json({ ok: true });
    });

    const response = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${oldKey}:pvns_${'b'.repeat(64)}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid credentials' });
    expect(cacheDel).toHaveBeenCalledWith(`agent_wallet:${oldPrefix}`);
  });
});
