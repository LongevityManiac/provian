import express from 'express';
import request from 'supertest';
import { createGitHubPrGateRouter } from './github-pr-gate';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { PR_GATE_REPOSITORIES } from '../core/witnesses/github-pr-api';
it('returns an exempt zero-price owner status and refuses both paid paths without gate writes', async () => {
  const before = process.env.GITHUB_PR_GATE_ENABLED; process.env.GITHUB_PR_GATE_ENABLED = 'true';
  const fake = createFakeFirestore();
  const api = { call: jest.fn(async () => ({ number: 9, user: { id: 229043875, login: 'LongevityManiac' },
    head: { sha: 'a'.repeat(40) }, base: { ref: 'master', sha: 'b'.repeat(40), repo: { id: PR_GATE_REPOSITORIES.provian.id } }, state: 'open' })) };
  const app = express(); app.use(express.json());
  app.use('/v1/gates/github', createGitHubPrGateRouter(fake as never, { checkRateLimit: async () => ({ allowed: true }) } as never, { api }));
  try {
    const response = await request(app).get('/v1/gates/github/provian/9');
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ exempt: true, minimum_burn_atomic: '0' });
    const challenge = await request(app).get('/v1/gates/github/provian/9/challenge');
    expect(challenge.status).toBe(409); expect(challenge.body.error).toBe('repository_owner_exempt');
    const present = await request(app).post('/v1/gates/github/provian/9/present').send({ token: 'unused' });
    expect(present.status).toBe(409); expect(fake.store.size).toBe(0);
  } finally { if (before === undefined) delete process.env.GITHUB_PR_GATE_ENABLED; else process.env.GITHUB_PR_GATE_ENABLED = before; }
});
