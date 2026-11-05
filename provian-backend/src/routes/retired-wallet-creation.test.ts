import express from 'express';
import request from 'supertest';

import { retiredLegacyAgentWalletCreateHandler } from './retired-wallet-creation';

describe('retired POST /v1/wallet/agent/create', () => {
  it('returns terminal canonical-route guidance without invoking any persistence dependency', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/wallet/agent/create', retiredLegacyAgentWalletCreateHandler);

    const response = await request(app)
      .post('/v1/wallet/agent/create')
      .send({ agentId: 'legacy-agent', publicKey: 'a'.repeat(128) });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      error: 'legacy_agent_wallet_creation_retired',
      migration: {
        challenge: 'GET /v1/agent/wallet/challenge?public_key=<public_key>&registration_id=<stable_registration_id>&agent_id=<stable_agent_id>',
        register: 'POST /v1/agent/wallet/create',
      },
    });
  });
});
