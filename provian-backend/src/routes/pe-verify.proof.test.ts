/**
 * The PE verification router on the PE meter (: the relay keeps no PEs).
 *
 * - `GET /:pe_id/proof` and `GET /export/:wallet_id` no longer serve a record — the relay has
 * none. They answer 410 `pe_kept_by_owner` and name where a metered act's proof lives
 * (`GET /v1/meter/proofs`). The export keeps its ownership guard, so another wallet learns
 * nothing (not even the 410).
 * - `POST /verify` is unchanged: it derives the leaf from the envelope hash itself and checks it
 * against the anchor contract. Its fixtures build the anchored tree directly from envelope-hash
 * leaves into a FAKE anchor contract (so the suite proves the ALGORITHM, not that anything is
 * anchored in production), and it never reads relay PE state.
 *
 * Every 410 is paired with a planted legacy `pe_history` / `provenance_envelopes` row that the
 * route must NOT serve — the RED control that the relay never answers from a record it is no
 * longer supposed to hold.
 */

import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { jest } from '@jest/globals';

/**
 * Stub the CREDENTIAL check only. The ownership guard (`req.agentWallet?.id !== :wallet_id` →
 * 403) is under test and stays real.
 */
jest.mock('./middleware/agent-auth', () => ({
  createAgentAuthMiddleware: () => (
    req: { headers: Record<string, unknown>; agentWallet?: { id: string } },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    const id = req.headers['x-test-agent-wallet'];
    if (typeof id !== 'string') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.agentWallet = { id };
    next();
  },
}));
import { createPEVerifyRouter, METER_PROOFS_PATH, type PEVerifyRouterDeps } from './pe-verify';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { buildMerkleTreeFromLeafHashes, generateProof, hashEnvelopeHashLeaf } from '../core/pvt/merkle';
import { PE_KEPT_BY_OWNER_BODY } from '../core/meter/owner-reads';

const ENVELOPE_HASHES = ['0x' + 'a1'.repeat(32), '0x' + 'b2'.repeat(32), '0x' + 'c3'.repeat(32)];
const BATCH_ID = ethers.id('meter-day:2026-10-02');

function makeFakeAnchorContract(): ethers.Contract & { anchorBatch(batchId: string, root: string): Promise<void> } {
  const anchored = new Map<string, string>();
  return {
    getBatch: async (batchId: string) =>
      anchored.has(batchId)
        ? [anchored.get(batchId)!, 3n, 0n, 0n, true]
        : ['0x' + '0'.repeat(64), 0n, 0n, 0n, false],
    anchorBatch: async (batchId: string, merkleRoot: string) => { anchored.set(batchId, merkleRoot); },
    // Mirrors ProvianPEAnchor.verifyPE exactly: the caller's hash is taken as the leaf with NO
    // 0x00 check, internal nodes carry 0x01, pairs sorted.
    verifyPE: async (batchId: string, leaf: string, proof: string[]) => {
      if (!anchored.has(batchId)) throw new Error('BatchNotFound');
      let h = leaf.toLowerCase();
      for (const p of proof) {
        const e = p.toLowerCase();
        h = BigInt(h) <= BigInt(e)
          ? ethers.keccak256(ethers.solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', h, e]))
          : ethers.keccak256(ethers.solidityPacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', e, h]));
      }
      return h === anchored.get(batchId)!.toLowerCase();
    },
  } as unknown as ethers.Contract & { anchorBatch(batchId: string, root: string): Promise<void> };
}

/** A planted pre-meter record the routes must never serve. */
function plantLegacyRecords(db: FakeFirestore): void {
  db.store.set('agent_wallets/w1', { id: 'w1', agent_id: 'agent_1' });
  db.store.set('pe_history/pe_1', {
    peId: 'pe_1', userId: 'agent_1', timestamp: 1000, actionType: 'send', peHash: 'hash_1',
    inputSummary: 'SECRET INPUT', mint_status: 'eligible',
  });
  db.store.set('provenance_envelopes/pe_1', { prev_hash: 'genesis', hash: 'hash_1', user_id: 'agent_1' });
}

function buildApp(db: FakeFirestore, contract: ethers.Contract | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/v1/pe', createPEVerifyRouter({ db, peAnchorContract: contract } as unknown as PEVerifyRouterDeps));
  return app;
}

async function withLaunch<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PUBLIC_LAUNCH;
  if (value === undefined) delete process.env.PUBLIC_LAUNCH;
  else process.env.PUBLIC_LAUNCH = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PUBLIC_LAUNCH;
    else process.env.PUBLIC_LAUNCH = prior;
  }
}

/** A real tree over envelope-hash leaves, anchored into the fake contract. */
async function anchoredFixture() {
  const contract = makeFakeAnchorContract();
  const leaves = ENVELOPE_HASHES.map((h) => hashEnvelopeHashLeaf(h));
  const tree = buildMerkleTreeFromLeafHashes(leaves);
  await contract.anchorBatch(BATCH_ID, tree.root);
  return { contract, tree, proofFor: (i: number) => generateProof(tree, i).proof };
}

describe('GET /v1/pe/:pe_id/proof — the relay keeps no PEs', () => {
  it('answers 410 pe_kept_by_owner and names GET /v1/meter/proofs', async () => {
    await withLaunch('true', async () => {
      const db = createFakeFirestore();
      plantLegacyRecords(db);
      const res = await request(buildApp(db, makeFakeAnchorContract())).get('/v1/pe/pe_1/proof');
      expect(res.status).toBe(410);
      expect(res.body.error).toBe(PE_KEPT_BY_OWNER_BODY.error);
      expect(res.body.error).toBe('pe_kept_by_owner');
      expect(res.body.proofs).toBe(METER_PROOFS_PATH);
      expect(METER_PROOFS_PATH).toBe('GET /v1/meter/proofs');
      expect(res.body.pe_id).toBe('pe_1');
      expect(res.body.anchor_runtime_configured).toBe(true);
    });
  });

  // RED CONTROL: a planted legacy record is NOT served — no hash, no chain link, no content.
  it('never serves a planted legacy record (no envelope hash, no chain link, no content)', async () => {
    await withLaunch('true', async () => {
      const db = createFakeFirestore();
      plantLegacyRecords(db);
      const res = await request(buildApp(db, null)).get('/v1/pe/pe_1/proof');
      const serialized = JSON.stringify(res.body);
      for (const leaked of ['hash_1', 'genesis', 'SECRET INPUT', 'envelope_hash', 'merkle_proof']) {
        expect(serialized).not.toContain(leaked);
      }
      expect(res.body.anchor_runtime_configured).toBe(false);
    });
  });

  it('404s before the launch flip, like every public surface', async () => {
    await withLaunch(undefined, async () => {
      const res = await request(buildApp(createFakeFirestore(), null)).get('/v1/pe/pe_1/proof');
      expect(res.status).toBe(404);
    });
  });
});

describe('GET /v1/pe/export/:wallet_id — the chain lives with its owner', () => {
  const asWallet = (app: express.Express, walletId: string | null, path: string) => {
    const req = request(app).get(path);
    return walletId === null ? req : req.set('x-test-agent-wallet', walletId);
  };

  it('answers the owner 410 pe_kept_by_owner, naming where its proofs live', async () => {
    const db = createFakeFirestore();
    plantLegacyRecords(db);
    const res = await asWallet(buildApp(db, null), 'w1', '/v1/pe/export/w1');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('pe_kept_by_owner');
    expect(res.body.detail).toBe(PE_KEPT_BY_OWNER_BODY.detail);
    expect(res.body.wallet_id).toBe('w1');
    expect(res.body.proofs).toBe(METER_PROOFS_PATH);
    // RED CONTROL: the planted legacy chain is not exported.
    expect(res.body).not.toHaveProperty('pes');
    expect(JSON.stringify(res.body)).not.toContain('hash_1');
  });

  it('keeps the ownership guard — 403 on another wallet, 401 unauthenticated (never the 410)', async () => {
    const db = createFakeFirestore();
    plantLegacyRecords(db);
    const other = await asWallet(buildApp(db, null), 'w2', '/v1/pe/export/w1');
    expect(other.status).toBe(403);
    const anon = await asWallet(buildApp(db, null), null, '/v1/pe/export/w1');
    expect(anon.status).toBe(401);
  });
});

describe('POST /v1/pe/verify — the relay derives the leaf', () => {
  it('verifies a genuine inclusion proof from the envelope hash', async () => {
    await withLaunch('true', async () => {
      const { contract, proofFor } = await anchoredFixture();
      const res = await request(buildApp(createFakeFirestore(), contract)).post('/v1/pe/verify').send({
        batch_id: BATCH_ID, envelope_hash: ENVELOPE_HASHES[1], merkle_proof: proofFor(1),
      });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.batch_details.pe_count).toBe(3);
    });
  });

  it('RED control: the root itself with an empty proof would pass the bare contract call', async () => {
    await withLaunch('true', async () => {
      const { contract, tree, proofFor } = await anchoredFixture();
      const app = buildApp(createFakeFirestore(), contract);
      // The on-chain primitive accepts it — which is why the route must not pass a caller hash through.
      expect(await contract.verifyPE(BATCH_ID, tree.root, [])).toBe(true);

      // The old request shape (caller-chosen leaf, no envelope hash) is refused outright.
      const legacy = await request(app).post('/v1/pe/verify').send({ batch_id: BATCH_ID, pe_hash: tree.root, merkle_proof: [] });
      expect(legacy.status).toBe(400);

      // Presenting the root as the envelope hash derives a real leaf, which is not the root.
      const forged = await request(app).post('/v1/pe/verify').send({ batch_id: BATCH_ID, envelope_hash: tree.root, merkle_proof: [] });
      expect(forged.status).toBe(200);
      expect(forged.body.valid).toBe(false);

      // A proof for one leaf does not verify another envelope hash.
      const crossed = await request(app).post('/v1/pe/verify').send({
        batch_id: BATCH_ID, envelope_hash: ENVELOPE_HASHES[2], merkle_proof: proofFor(1),
      });
      expect(crossed.body.valid).toBe(false);

      // A pe_hash that disagrees with the derived leaf is refused.
      const mismatch = await request(app).post('/v1/pe/verify').send({
        batch_id: BATCH_ID, envelope_hash: ENVELOPE_HASHES[1], pe_hash: tree.root, merkle_proof: proofFor(1),
      });
      expect(mismatch.status).toBe(400);
    });
  });

  it('fails closed with a self-citing 503 when no anchor runtime is configured, never a verdict', async () => {
    await withLaunch('true', async () => {
      const res = await request(buildApp(createFakeFirestore(), null))
        .post('/v1/pe/verify')
        .send({ batch_id: 'b', envelope_hash: '0x1', merkle_proof: [] });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('anchor_runtime_unconfigured');
      expect(res.body).not.toHaveProperty('valid');
      expect(res.body.message).toContain('GET /v1/meter/proofs');
    });
  });

  it('404s before the launch flip', async () => {
    await withLaunch(undefined, async () => {
      const res = await request(buildApp(createFakeFirestore(), null)).post('/v1/pe/verify').send({});
      expect(res.status).toBe(404);
    });
  });
});
