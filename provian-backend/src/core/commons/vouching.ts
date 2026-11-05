/**
 * Provian Commons - Peer Vouching
 *
 * Established participants vouch for others, building trust through
 * skin-in-the-game reputation. Reciprocal vouch detection prevents gaming.
 */

import { v4 as uuidv4 } from 'uuid';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type PeerVouch,
  type VouchRequest,
} from './types';

const L = COMMONS_SAFETY_LIMITS;

/**
 * RETIRED (F27, S2 2026-09-10): the FREE vouch path. No live route calls this any
 * more — `POST /v1/commons/vouch` now returns 410 and the vouch signal is
 * burn-vouches only (`core/commons/burn-vouch.ts`), per (a vouch is a
 * gated trust act carrying a live reputation-presentation burn). This function
 * and `getVouches` below are retained ONLY so the WS4 atomicity control
 * (`commons-atomicity.test.ts`) keeps exercising generatePE-transaction
 * atomicity; do not re-route them to a live endpoint.
 */
export async function vouchForParticipant(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: VouchRequest,
): Promise<PeerVouch> {
  // Rate limit
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:vouch:${walletId}`,
    L.RATE_LIMIT_VOUCH,
    60,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Self-vouch check
  if (body.vouchee_wallet_id === walletId) {
    throw new ValidationError('Cannot vouch for yourself');
  }

  // Verify voucher profile
  const voucherDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!voucherDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to vouch');
  }
  const voucher = voucherDoc.data()!;

  // no governance-score gate on vouching (the signal is deleted; no
  // eligibility path reads it). Vouching is bounded by Commons tenure and the
  // duplicate / reciprocal anti-gaming checks below.

  // Commons tenure check
  const daysSinceJoin = (Date.now() - voucher.commons_join_date) / (1000 * 60 * 60 * 24);
  if (daysSinceJoin < L.VOUCH_MIN_COMMONS_DAYS) {
    throw new ValidationError(
      `Must be on the Commons for at least ${L.VOUCH_MIN_COMMONS_DAYS} days to vouch`,
    );
  }

  // Verify vouchee profile
  const voucheeDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(body.vouchee_wallet_id)
    .get();
  if (!voucheeDoc.exists) {
    throw new NotFoundError('Vouchee not found on the Commons');
  }

  // Check for duplicate vouch
  const existingVouch = await deps.db
    .collection(COMMONS_COLLECTIONS.VOUCHES)
    .where('voucher_wallet_id', '==', walletId)
    .where('vouchee_wallet_id', '==', body.vouchee_wallet_id)
    .limit(1)
    .get();
  if (!existingVouch.empty) {
    throw new ValidationError('Already vouched for this participant');
  }

  // Anti-gaming: check for reciprocal vouch in the same 7-day window
  const sevenDaysAgo = Date.now() - L.RECIPROCAL_VOUCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const reciprocalVouch = await deps.db
    .collection(COMMONS_COLLECTIONS.VOUCHES)
    .where('voucher_wallet_id', '==', body.vouchee_wallet_id)
    .where('vouchee_wallet_id', '==', walletId)
    .where('created_at', '>', sevenDaysAgo)
    .limit(1)
    .get();
  if (!reciprocalVouch.empty) {
    throw new ValidationError(
      'Reciprocal vouching within 7 days is not allowed (anti-gaming)',
    );
  }

  const now = Date.now();
  const vouchId = `vouch_${uuidv4()}`;
  const vouchRef = deps.db.collection(COMMONS_COLLECTIONS.VOUCHES).doc(vouchId);
  // Pure builder — safe to re-materialise on transaction retry.
  const buildVouch = (peId: string): PeerVouch => ({
    vouch_id: vouchId,
    pe_id: peId,
    voucher_wallet_id: walletId,
    vouchee_wallet_id: body.vouchee_wallet_id,
    statement: body.statement?.trim(),
    created_at: now,
  });

  // Generate PE for voucher. WS4: the vouch document commits in the SAME
  // transaction as the voucher PE + chain-tip advance (atomicEntityWrite), so the
  // vouch can never reference a PE whose document failed to persist, and the
  // voucher PE can never land without its vouch.
  const { peId: voucherPeId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_vouch_given',
    metadata: {
      vouchee_wallet_id: body.vouchee_wallet_id,
      statement: body.statement,
    },
    atomicEntityWrite: (txn, generatedPeId) => {
      txn.set(vouchRef, buildVouch(generatedPeId));
    },
  });

  // Generate PE for vouchee. This is a separate chain (vouchee_wallet_id) with no
  // bound entity; it is independently durable via its own provisional write, so
  // cross-PE atomicity with the voucher PE is neither required nor attempted.
  await generatePE(deps, {
    walletId: body.vouchee_wallet_id,
    agentId: body.vouchee_wallet_id, // Use wallet ID as agent ID for humans
    actorAddress: body.vouchee_wallet_id,
    actionType: 'commons_vouch_received',
    metadata: {
      voucher_wallet_id: walletId,
    },
  });

  const vouch = buildVouch(voucherPeId);

  // Check if vouchee qualifies for peer_vouched upgrade
  const allVouches = await deps.db
    .collection(COMMONS_COLLECTIONS.VOUCHES)
    .where('vouchee_wallet_id', '==', body.vouchee_wallet_id)
    .get();

  if (allVouches.size >= L.VOUCHES_FOR_UPGRADE) {
    const vouchee = voucheeDoc.data()!;
    if (vouchee.identity_verification_level === 'device_attested' ||
        vouchee.identity_verification_level === 'biometric_enrolled') {
      await deps.db
        .collection(COMMONS_COLLECTIONS.PROFILES)
        .doc(body.vouchee_wallet_id)
        .update({
          identity_verification_level: 'peer_vouched',
          updated_at: now,
        });

      // Generate verification upgrade PE
      await generatePE(deps, {
        walletId: body.vouchee_wallet_id,
        agentId: body.vouchee_wallet_id,
        actorAddress: body.vouchee_wallet_id,
        actionType: 'commons_verification_upgraded',
        metadata: {
          new_level: 'peer_vouched',
          vouch_count: allVouches.size,
        },
      });
    }
  }

  return vouch;
}

export async function getVouches(
  deps: CommonsDeps,
  walletId: string,
): Promise<PeerVouch[]> {
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.VOUCHES)
    .where('vouchee_wallet_id', '==', walletId)
    .orderBy('created_at', 'desc')
    .get();
  return snap.docs.map(d => d.data() as PeerVouch);
}
