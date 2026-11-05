/**
 * retire-held-legacy-claims — retire the two carried-over pre-meter claims the
 * recovery-escrow gate held after the 2026-10-04 forced settlement (OPEN_ITEMS L107).
 *
 * retire both. They are pre-meter earnings on two
 * unlinked test agents, and pre-meter carry-over is expendable except
 * the operator’s and Atlas's. No linking, no escrow, no grandfathering: the gate is untouched and the
 * claims never pay.
 *
 * The retirement is the meter's own terminal claim state: `state: 'void'` with `voided_by` /
 * `voided_at_ms`, the shape a demotion writes (`meter-claims.ts` `withoutAct`). `state` is outside
 * the claim's integrity commitment, so the sealed record is otherwise byte-unchanged; the act key,
 * the act's sealed snapshot and every PE stay as they are. Each claim is voided only inside a
 * transaction that re-reads it and finds exactly: the expected claim key and wallet, unit `act`,
 * batch `legacy_pre_meter`, state `pending`, and no `payout_key` and only after Base says the
 * kernel has NOT settled its claim id. Anything else refuses and writes nothing.
 *
 * FIRESTORE_DATABASE_ID=relay npx tsx scripts/retire-held-legacy-claims.ts # dry run
 * FIRESTORE_DATABASE_ID=relay npx tsx scripts/retire-held-legacy-claims.ts --execute
 */

import { scriptDb, relayDatabaseId } from './lib/script-db';

export const HELD_CLAIMS = [
  { claim_key: 'ma_pe_31ae8854-1fb8-484e-8a5b-80550a563397_sole', wallet_id: 'wallet_aw_ddd686e3-4b62-4ee7-8d54-5f5ba2323403' },
  { claim_key: 'ma_pe_62f7b855-203c-4b17-8dbf-d1c4924ba019_sole', wallet_id: 'wallet_aw_0ce78bbf-cc0b-4a50-a20a-20efd4c55d32' },
] as const;

const KERNEL = '0x8811441914381143b9408c5C32247367F86F173A';
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const VOIDED_BY = 'retired:frank_2026-10-06_pre_meter_test_agent_carry_over';

/** `claimSettled(bytes32)` on the kernel, read from Base. */
async function claimSettledOnChain(claimId: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(claimId)) throw new Error(`bad claim id ${claimId}`);
  // keccak256("claimSettled(bytes32)")[:4]
  const { keccak256, toUtf8Bytes } = await import('ethers');
  const selector = keccak256(toUtf8Bytes('claimSettled(bytes32)')).slice(0, 10);
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'provian-relay-maintenance/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: KERNEL, data: selector + claimId.slice(2) }, 'latest'] }),
  });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (typeof body.result !== 'string' || body.result.length !== 66) throw new Error(`claimSettled read failed: ${JSON.stringify(body)}`);
  return BigInt(body.result) !== 0n;
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (relayDatabaseId() !== 'relay') throw new Error(`refusing: FIRESTORE_DATABASE_ID must be relay (got ${relayDatabaseId()})`);
  const db = scriptDb();
  for (const held of HELD_CLAIMS) {
    const ref = db.collection('meter_pending_claims_v1').doc(held.claim_key);
    const pre = (await ref.get()).data();
    if (!pre) { console.log(JSON.stringify({ claim_key: held.claim_key, outcome: 'absent' })); continue; }
    if (pre.state === 'void' && pre.voided_by === VOIDED_BY) { console.log(JSON.stringify({ claim_key: held.claim_key, outcome: 'already_retired' })); continue; }
    const settled = await claimSettledOnChain(String(pre.claim_id));
    const summary = {
      claim_key: held.claim_key, claim_id: pre.claim_id, unit: pre.unit, batch_hash: pre.batch_hash,
      state: pre.state, contributor: pre.contributor, record_points_atomic: pre.record_points_atomic,
      act: (pre.act_identity as Record<string, unknown> | undefined)?.id ?? null, claim_settled_on_chain: settled,
    };
    if (settled) throw new Error(`refusing: ${held.claim_key} is settled on-chain`);
    if (!execute) { console.log(JSON.stringify({ ...summary, outcome: 'would_retire' })); continue; }
    await db.runTransaction(async (txn) => {
      const c = (await txn.get(ref)).data();
      const wallet = String((c?.act_identity as Record<string, unknown> | undefined)?.wallet_id ?? c?.wallet_id ?? '');
      const problems: string[] = [];
      if (!c) problems.push('absent');
      else {
        if (c.state !== 'pending') problems.push(`state ${String(c.state)}`);
        if (c.unit !== 'act') problems.push(`unit ${String(c.unit)}`);
        if (c.batch_hash !== 'legacy_pre_meter') problems.push(`batch ${String(c.batch_hash)}`);
        if (c.payout_key) problems.push('has payout_key');
        if (c.claim_id !== pre.claim_id) problems.push('claim id moved');
        if (wallet && wallet !== held.wallet_id) problems.push(`wallet ${wallet}`);
      }
      if (problems.length) throw new Error(`refusing ${held.claim_key}: ${problems.join(', ')}`);
      txn.update(ref, { state: 'void', voided_by: VOIDED_BY, voided_at_ms: Date.now() });
    });
    console.log(JSON.stringify({ ...summary, outcome: 'retired', voided_by: VOIDED_BY }));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
