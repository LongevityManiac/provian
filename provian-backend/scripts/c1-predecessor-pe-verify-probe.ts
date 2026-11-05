/**
 * C1 probe (, READ-ONLY): PE records sealed before the contract
 * succession still verify on-chain.
 *
 * Mounts the REAL `createPEVerifyRouter` in-process with the discovery gate open
 * (PUBLIC_LAUNCH=true in THIS process only — production is untouched), reading
 * production Firestore and calling the deployed PEAnchor over Base with eth_call.
 * It writes nothing: the router's proof and verify routes are reads, and the
 * anchor contract is the read-only one `server.ts` builds.
 *
 * For each sampled PE sealed before `--before` (default 2026-09-26T00:00:00Z, the
 * migration day) that carries an anchor batch id:
 * 1. GET /v1/pe/:pe_id/proof → the bundle the public API will serve
 * 2. POST /v1/pe/verify → the relay's on-chain inclusion verdict
 * and prints the bundle so `scripts/verify-pe-proof.ts` can re-check it with
 * zero trust in the relay.
 *
 * PE_ANCHOR_CONTRACT_ADDRESS=0x… BASE_RPC_URL=… \
 * npx ts-node scripts/c1-predecessor-pe-verify-probe.ts [--before <iso>] [--limit N] [--out dir]
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { createPEVerifyRouter, type PEVerifyRouterDeps } from '../src/routes/pe-verify';
import { buildPeAnchorReadContract } from '../src/core/pvt/pe-anchor-runtime';
import { scriptDb } from './lib/script-db';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const before = Date.parse(arg('--before', '2026-09-26T00:00:00Z'));
  const limit = Number(arg('--limit', '3'));
  const outDir = arg('--out', '');
  const rpc = process.env.BASE_RPC_URL;
  if (!rpc || !process.env.PE_ANCHOR_CONTRACT_ADDRESS) {
    throw new Error('PE_ANCHOR_CONTRACT_ADDRESS and BASE_RPC_URL are required');
  }
  process.env.PUBLIC_LAUNCH = 'true'; // this process only

  if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
  const db = scriptDb();
  const contract = buildPeAnchorReadContract(() => new ethers.JsonRpcProvider(rpc, 8453));
  if (contract === null) throw new Error('anchor contract not built');

  const app = express();
  app.use(express.json());
  app.use('/v1/pe', createPEVerifyRouter({ db, peAnchorContract: contract } as unknown as PEVerifyRouterDeps));

  // Newest anchored PEs sealed before the cut (anchor_batch_id set by the daily anchor).
  const snap = await db.collection('pe_history')
    .where('anchor_batch_id', '!=', null)
    .orderBy('anchor_batch_id')
    .limit(500)
    .get();
  const candidates = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .filter((d) => {
      const t = typeof d.data.timestamp === 'number' ? d.data.timestamp : Number(d.data.timestamp);
      return Number.isFinite(t) && t < before;
    })
    .sort((a, b) => Number(b.data.timestamp) - Number(a.data.timestamp))
    .slice(0, limit);

  console.log(`sampled ${candidates.length} anchored PE(s) sealed before ${new Date(before).toISOString()}`);
  let verified = 0;
  for (const c of candidates) {
    const proof = await request(app).get(`/v1/pe/${c.id}/proof`);
    const body = proof.body as Record<string, unknown>;
    const anchor = (body.anchor ?? {}) as Record<string, unknown>;
    const batchId = anchor.batch_id as string | undefined;
    const merkleProof = body.merkle_proof as unknown;
    const rawHash = body.envelope_hash as string | undefined;
    const envelopeHash = rawHash && !rawHash.startsWith('0x') ? `0x${rawHash}` : rawHash;
    const verify = await request(app).post('/v1/pe/verify')
      .send({ batch_id: batchId, envelope_hash: envelopeHash, merkle_proof: merkleProof });
    const ok = verify.status === 200 && (verify.body as { valid?: boolean }).valid === true;
    if (ok) verified += 1;
    console.log(JSON.stringify({
      pe_id: c.id,
      sealed_at: new Date(Number(c.data.timestamp)).toISOString(),
      action_type: c.data.action_type,
      proof_status: proof.status,
      anchored: body.anchored,
      batch_id: batchId,
      anchor_contract: anchor.contract_address,
      anchor_tx: anchor.anchor_tx_hash,
      anchor_day: anchor.day,
      verify_status: verify.status,
      verify: verify.body,
    }));
    if (outDir) fs.writeFileSync(path.join(outDir, `${c.id}.proof.json`), JSON.stringify(body, null, 2));
  }
  console.log(`verified on-chain: ${verified}/${candidates.length}`);
  if (candidates.length === 0 || verified !== candidates.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
