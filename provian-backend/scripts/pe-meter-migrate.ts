/**
 * PE METER — retire the relay's stored PEs (, item 10). See
 * `src/core/meter/legacy-migration.ts` for what happens to each PE.
 *
 * tsx scripts/pe-meter-migrate.ts [--execute] [--phase identity|rows|orphans|all]
 * [--hand-back human:<user_id>] [--hand-back agent:<agent_id>] [--limit N]
 *
 * Dry run unless --execute. Phases:
 * identity copy every identity-bearing envelope into identity_pes_legacy_v1 (additive; run it
 * BEFORE deploying the relay that reads identity PEs from there);
 * rows retire every pe_history row (and its envelope);
 * orphans retire every envelope that has no row.
 * Re-runnable: a retired PE is gone; one still waiting (an unsettled legacy claim, a Genesis
 * grant, an owner with no key yet) is reported and retried on the next run.
 */
import admin from 'firebase-admin';
import { CLAIM_LEDGER_COLLECTION } from '../src/core/pvt/wp4/durable-settlement-store';
import stableStringify from 'json-stable-stringify';
import {
  PE_HISTORY,
  PROVENANCE_ENVELOPES,
  retireLegacyPe,
  isLegacyIdentityPe,
  type HandBackOwner,
  type LegacyOutcome,
} from '../src/core/meter/legacy-migration';
import { IDENTITY_ACT_TYPES } from '../src/core/meter/identity-acts';
import { LEGACY_IDENTITY_PES_COLLECTION } from '../src/core/meter/meter-store';
import { readMessageKey } from '../src/core/commons/message-keys';
import { AGENT_BADGE_AWARD_OUTBOX_COLLECTION } from '../src/core/agent-wallet/badge-provenance';
import { scriptDb } from './lib/script-db';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'provian-ai' });
const db = scriptDb();

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const phaseArg = args[args.indexOf('--phase') + 1];
const phase = args.includes('--phase') ? phaseArg : 'all';
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const handBackSpecs = args.flatMap((a, i) => (a === '--hand-back' ? [args[i + 1]] : []));

async function resolveHandBack(): Promise<Map<string, HandBackOwner>> {
  const owners = new Map<string, HandBackOwner>();
  for (const spec of handBackSpecs) {
    const [kind, id] = spec.split(':');
    if ((kind !== 'human' && kind !== 'agent') || !id) throw new Error(`bad --hand-back ${spec}`);
    let keyParty: string | null = null;
    if (kind === 'human') {
      const wallets = await db.collection('wallets').where('user_id', '==', id).get();
      keyParty = wallets.docs.find((d) => d.data().type === 'human')?.id ?? null;
    } else {
      const wallets = await db.collection('agent_wallets').where('agent_id', '==', id).get();
      keyParty = wallets.docs[0]?.id ?? null;
    }
    const key = keyParty ? await readMessageKey(db, keyParty) : null;
    owners.set(id, { actorId: id, recipient: `${kind}:${id}`, pubkeyB64u: key?.pubkey_b64u ?? null });
    console.log(`hand-back ${kind}:${id} key_party=${keyParty ?? 'none'} key=${key ? 'published' : 'MISSING (their PEs wait)'}`);
  }
  return owners;
}

/** PE ids an identity record pins whose type is not itself identity-bearing (badge sources). */
async function pinnedIdentityIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const outbox = await db.collection(AGENT_BADGE_AWARD_OUTBOX_COLLECTION).get();
  for (const doc of outbox.docs) {
    for (const [field, value] of Object.entries(doc.data())) {
      if (field.endsWith('pe_id') && typeof value === 'string' && value.startsWith('pe_')) ids.add(value);
    }
  }
  const rels = await db.collection('agent_beneficiary_relationships_v1').get();
  for (const doc of rels.docs) {
    const v = doc.data().source_pe_id;
    if (typeof v === 'string') ids.add(v);
  }
  return ids;
}

async function identityPhase(pinned: Set<string>): Promise<void> {
  const ids = new Set(pinned);
  const types = [...IDENTITY_ACT_TYPES];
  for (let i = 0; i < types.length; i += 30) {
    for (const field of ['action_type', 'policy_action_type']) {
      const snap = await db.collection(PROVENANCE_ENVELOPES).where(field, 'in', types.slice(i, i + 30)).select().get();
      snap.docs.forEach((d) => ids.add(d.id));
    }
  }
  let copied = 0;
  let present = 0;
  let conflict = 0;
  let missing = 0;
  for (const id of ids) {
    const [env, copy] = await Promise.all([
      db.collection(PROVENANCE_ENVELOPES).doc(id).get(),
      db.collection(LEGACY_IDENTITY_PES_COLLECTION).doc(id).get(),
    ]);
    if (!env.exists) {
      if (copy.exists) present += 1; else missing += 1;
      continue;
    }
    const data = env.data() as Record<string, unknown>;
    if (!isLegacyIdentityPe(data, pinned, id)) continue;
    if (copy.exists) {
      if (stableStringify(copy.data()) === stableStringify(data)) present += 1;
      else { conflict += 1; console.log(`identity conflict ${id}`); }
      continue;
    }
    if (execute) await db.collection(LEGACY_IDENTITY_PES_COLLECTION).doc(id).create(data);
    copied += 1;
  }
  console.log(`identity: candidates=${ids.size} ${execute ? 'copied' : 'would_copy'}=${copied} already=${present} conflict=${conflict} pinned_but_missing=${missing}`);
}

/**
 * The prev_hash of every PE whose legacy claim is registered and unsettled: the approver re-checks
 * that link, so the predecessor envelope stays until the claim settles.
 */
async function pinnedPredecessors(): Promise<Set<string>> {
  const snap = await db.collection(CLAIM_LEDGER_COLLECTION).where('settled', '==', false).select('pe_id').get();
  const peIds = [...new Set(snap.docs.map((d) => String(d.get('pe_id') ?? '')).filter((id) => id.length > 0))];
  const hashes = new Set<string>();
  for (let i = 0; i < peIds.length; i += 300) {
    const envs = await db.getAll(...peIds.slice(i, i + 300).map((id) => db.collection(PROVENANCE_ENVELOPES).doc(id)));
    for (const e of envs) {
      const prev = e.exists ? e.get('prev_hash') : null;
      if (typeof prev === 'string' && prev.length > 0) hashes.add(prev);
    }
  }
  console.log(`unsettled legacy claims: ${snap.size} on ${peIds.length} PEs; predecessor pins: ${hashes.size}`);
  return hashes;
}

/** PE ids whose Genesis qualification is denied: a terminal state (no reservation, completed). */
async function deniedGenesisPeIds(): Promise<Set<string>> {
  const snap = await db.collection('genesis_qualification_outbox_v2').get();
  const ids = new Set<string>();
  for (const d of snap.docs) {
    const x = d.data();
    if (x.status === 'denied' && typeof x.denial_reason === 'string' && x.denial_reason.length > 0
      && x.completed_at_ms !== null && typeof x.pe_id === 'string' && x.pe_id.length > 0) ids.add(x.pe_id);
  }
  console.log(`genesis qualifications: ${snap.size}; denied with a PE: ${ids.size}`);
  return ids;
}

async function retirePhase(collection: string, pinned: Set<string>, owners: Map<string, HandBackOwner>, predecessors: Set<string>, genesisDenied: Set<string>): Promise<void> {
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  let handedBack = 0;
  let converted = 0;
  let held = 0;
  let identity = 0;
  let after: string | null = null;
  let seen = 0;
  const nowMs = Date.now();
  for (;;) {
    let query = db.collection(collection).orderBy(admin.firestore.FieldPath.documentId()).select().limit(200);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    const ids = page.docs.map((d) => d.id);
    after = ids[ids.length - 1];
    for (let i = 0; i < ids.length; i += 8) {
      const outcomes = await Promise.all(ids.slice(i, i + 8).map(async (id): Promise<LegacyOutcome> => {
        try {
          return await retireLegacyPe(db, id, { nowMs, apply: execute, handBack: owners, identityPinned: pinned, predecessorPinned: predecessors, genesisDenied });
        } catch (err) {
          return { kind: 'waiting', reason: `error:${err instanceof Error ? err.message.slice(0, 60) : 'unknown'}` };
        }
      }));
      for (const o of outcomes) {
        if (o.kind === 'retired') {
          bump('retired');
          if (o.handedBack) handedBack += 1;
          converted += o.converted;
          if (o.held) held += 1;
          if (o.identity) identity += 1;
        } else if (o.kind === 'waiting') bump(`waiting:${o.reason}`);
        else bump('gone');
      }
    }
    seen += ids.length;
    if (seen >= limit) break;
    if (seen % 2000 === 0) console.log(`  ${collection}: ${seen} …`);
  }
  console.log(`${collection}: seen=${seen} ${JSON.stringify(Object.fromEntries(tally))} handed_back=${handedBack} claims_created=${converted} held_acts=${held} identity=${identity}${execute ? '' : ' (dry run)'}`);
}

(async () => {
  console.log(`pe-meter-migrate ${execute ? 'EXECUTE' : 'dry run'} phase=${phase}`);
  const owners = await resolveHandBack();
  const pinned = await pinnedIdentityIds();
  console.log(`identity pins from records: ${pinned.size}`);
  if (phase === 'identity' || phase === 'all') await identityPhase(pinned);
  const predecessors = phase === 'identity' ? new Set<string>() : await pinnedPredecessors();
  const genesisDenied = phase === 'identity' ? new Set<string>() : await deniedGenesisPeIds();
  if (phase === 'rows' || phase === 'all') await retirePhase(PE_HISTORY, pinned, owners, predecessors, genesisDenied);
  if (phase === 'orphans' || phase === 'all') await retirePhase(PROVENANCE_ENVELOPES, pinned, owners, predecessors, genesisDenied);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
