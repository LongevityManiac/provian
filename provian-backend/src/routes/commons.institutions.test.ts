import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../core/commons/feed', () => {
  const actual = jest.requireActual('../core/commons/feed') as Record<string, unknown>;
  return {
    ...actual,
    getActivityFeed: async () => [{
      id: 'pe-private-control',
      type: 'pe_published',
      actor_wallet_id: 'wallet-control',
      actor_display_name: 'Control',
      actor_attestation_tier: 'software',
      institution: 'provenance',
      summary: 'Safe public summary',
      timestamp: 1,
      description: 'must never leave the router',
      secret: 'must never leave the router',
    }],
  };
});

import { createCommonsRouter } from './commons';

const RECOURSE_DESCRIPTION = 'Protect the PVT you hold. Bind your addresses, register independent recovery, and choose Recourse Pool membership for discretionary theft restoration. Reversal first; member-funded reserves for the remainder. Other recourse programs can follow.';

function makeDeps() {
  const count = { get: async () => ({ data: () => ({ count: 0 }) }) };
  // A chainable query: getInstitutions filters with one or two `.where()` calls before `.count()`
  // (the prelaunch-visibility counts chain a second filter).
  // `get` answers the hidden-account marker reads (no hidden account here).
  const query: { where: () => typeof query; count: () => typeof count; get: () => Promise<{ docs: never[] }> } = {
    where: () => query,
    count: () => count,
    get: async () => ({ docs: [] }),
  };
  const db = {
    batch: () => ({ set: () => undefined, commit: async () => undefined }),
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true }) }),
      where: () => query,
      count: () => count,
    }),
  };
  return {
    db,
    cache: {
      get: async () => null,
      set: async () => undefined,
    },
  } as unknown as Parameters<typeof createCommonsRouter>[0];
}

describe('GET /institutions static-copy projection', () => {
  it('serves the live Recourse description without weakening the Commons Tier-3 strip-pass', async () => {
    const app = express();
    app.use(createCommonsRouter(makeDeps()));

    const response = await request(app).get('/institutions').expect(200);
    const recourse = response.body.institutions.find(
      (institution: { id?: string }) => institution.id === 'recourse',
    );

    expect(recourse).toEqual({
      id: 'recourse',
      name: 'Recourse',
      description: RECOURSE_DESCRIPTION,
      route: '/commons/recourse',
      status: 'live',
      audience: 'both',
    });
    expect(Object.keys(recourse).sort()).toEqual([
      'audience', 'description', 'id', 'name', 'route', 'status',
    ]);
  });

  it('keeps the Tier-3 strip-pass on every ordinary Commons route', async () => {
    const app = express();
    app.use(createCommonsRouter(makeDeps()));

    const response = await request(app).get('/feed').expect(200);
    expect(response.body.items[0]).toMatchObject({
      id: 'pe-private-control',
      summary: 'Safe public summary',
    });
    expect(response.body.items[0].description).toBeUndefined();
    expect(response.body.items[0].secret).toBeUndefined();
  });
});
