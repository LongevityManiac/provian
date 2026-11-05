import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { commitClaimDocId, prepareCommitMintClaim } from './commit-mint-claim';
import {
  applyMintOnceClaimDecision,
  hashMintOnceClaimEvidence,
  inspectPreparedMintOnceClaimInTransaction,
  MintOnceClaimRaceError,
  type PreparedMintOnceClaim,
} from './mint-once-claim';

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

async function commitPlan(db: FakeFirestore, plan: PreparedMintOnceClaim): Promise<void> {
  const evidence = [plan.evidence];
  await db.runTransaction(async (txn) => {
    const decision = await inspectPreparedMintOnceClaimInTransaction(
      db as unknown as Firestore,
      txn as unknown as FirebaseFirestore.Transaction,
      plan,
    );
    applyMintOnceClaimDecision(
      db as unknown as Firestore,
      txn as unknown as FirebaseFirestore.Transaction,
      decision,
    );
    txn.create(db.collection('pe_history').doc(plan.current_pe_id), {
      peId: plan.current_pe_id,
      userId: plan.current_user_id,
      mint_once_claim_evidence: evidence,
      mint_once_claim_evidence_hash: hashMintOnceClaimEvidence(evidence),
    });
  });
}

describe('atomic cross-witness commit mint claim', () => {
  it('preparation is read-only and the claim commits with its owning PE', async () => {
    const db = createFakeFirestore();
    const plan = await prepareCommitMintClaim(
      db as unknown as Firestore,
      'user_1',
      SHA,
      'pe_local',
      100,
    );
    expect(plan.evidence.relation).toBe('owner');
    expect([...db.store.keys()].filter((key) => key.startsWith('commit_mint_claims/')))
      .toHaveLength(0);

    await commitPlan(db, plan);
    expect(db.store.get(`commit_mint_claims/${commitClaimDocId('user_1', SHA)}`))
      .toMatchObject({
        schema_version: 'pvt-mint-once-claim/v1',
        owner_pe_id: 'pe_local',
        owner_user_id: 'user_1',
      });
    expect(db.store.get('pe_history/pe_local')).toBeDefined();
  });

  it('rolls back the claim if the owning pe_history write fails', async () => {
    const db = createFakeFirestore({ failTxnWriteTo: 'pe_history' });
    const plan = await prepareCommitMintClaim(
      db as unknown as Firestore,
      'user_1',
      SHA,
      'pe_local',
      100,
    );
    await expect(commitPlan(db, plan)).rejects.toThrow();
    expect([...db.store.keys()].filter((key) => key.startsWith('commit_mint_claims/')))
      .toHaveLength(0);
    expect(db.store.get('pe_history/pe_local')).toBeUndefined();
  });

  it('retries a concurrent loser against the committed winner as a duplicate', async () => {
    const db = createFakeFirestore();
    const first = await prepareCommitMintClaim(
      db as unknown as Firestore, 'user_1', SHA, 'pe_local', 100,
    );
    const staleSecond = await prepareCommitMintClaim(
      db as unknown as Firestore, 'user_1', SHA, 'pe_webhook', 101,
    );
    await commitPlan(db, first);
    await expect(commitPlan(db, staleSecond)).rejects.toBeInstanceOf(MintOnceClaimRaceError);
    expect(db.store.get('pe_history/pe_webhook')).toBeUndefined();

    const retry = await prepareCommitMintClaim(
      db as unknown as Firestore, 'user_1', SHA, 'pe_webhook', 102,
    );
    expect(retry.evidence.relation).toBe('duplicate');
    await commitPlan(db, retry);
    expect(db.store.get('pe_history/pe_webhook')).toBeDefined();
  });

  it('fails closed on a legacy, malformed, or contradictory claim row', async () => {
    const db = createFakeFirestore();
    db.store.set(`commit_mint_claims/${commitClaimDocId('user_1', SHA)}`, {
      user_id: 'user_1',
      commit_sha: SHA,
      pe_id: 'pe_legacy',
      claimed_at: 1,
    });
    await expect(prepareCommitMintClaim(
      db as unknown as Firestore, 'user_1', SHA, 'pe_new', 100,
    )).rejects.toThrow('mint_once_claim_schema_mismatch');
    expect(db.store.get('pe_history/pe_new')).toBeUndefined();
  });

  it('scopes the same commit independently per user', async () => {
    const db = createFakeFirestore();
    const one = await prepareCommitMintClaim(
      db as unknown as Firestore, 'user_1', SHA, 'pe_u1', 100,
    );
    await commitPlan(db, one);
    const two = await prepareCommitMintClaim(
      db as unknown as Firestore, 'user_2', SHA, 'pe_u2', 101,
    );
    expect(two.evidence.relation).toBe('owner');
  });
});
