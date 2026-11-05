/**
 * PE METER — the speech made under a talking pass, by pass (burn id).
 *
 * When a talking pass's burn is revoked (`presentation/burn-finality.ts`), the speech made under it
 * is revoked: posts and wants and jobs hidden, votes reversed, flags removed. Before the meter that
 * sweep found each speech act's target (`post_id`, `want_id`, `job_id`, `vote_id`) in the act's
 * stored envelope; the meter keeps no envelope. So `generatePE` writes, in the same transaction
 * that chains a speech act made under a pass, this small record: which pass, which act, and the
 * entity ids the act touched — identifiers only, never content.
 *
 * It lives 31 days (the act-key lifetime; a pass lasts seven): long enough for a provisional burn
 * to finalize or be revoked, and per actor it never grows with history.
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { expireAt, METER_KEY_LIFETIME_MS } from '../meter/meter-store';

export const SPEECH_WINDOW_ACTS_COLLECTION = 'speech_window_acts_v1';

/** The entity ids a speech act's revocation needs (the keys `revokeSpeechAct` reads). */
export interface SpeechActRefs {
  readonly post_id: string | null;
  readonly want_id: string | null;
  readonly job_id: string | null;
  readonly vote_id: string | null;
}

export interface SpeechWindowActDoc {
  readonly schema: 'provian.speech-window-act.v1';
  readonly pe_id: string;
  readonly burn_id: string;
  readonly action_type: string;
  readonly refs: SpeechActRefs;
  readonly created_at_ms: number;
  readonly expire_at: FirebaseFirestore.Timestamp;
}

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null;
}

export function speechActRefsOf(metadata: Readonly<Record<string, unknown>> | null | undefined): SpeechActRefs {
  const m = metadata ?? {};
  return {
    post_id: idOrNull(m.post_id),
    want_id: idOrNull(m.want_id),
    job_id: idOrNull(m.job_id),
    vote_id: idOrNull(m.vote_id),
  };
}

export function buildSpeechWindowAct(input: {
  readonly peId: string;
  readonly burnId: string;
  readonly actionType: string;
  readonly metadata: Readonly<Record<string, unknown>> | null | undefined;
  readonly nowMs: number;
}): SpeechWindowActDoc {
  return {
    schema: 'provian.speech-window-act.v1',
    pe_id: input.peId,
    burn_id: input.burnId,
    action_type: input.actionType,
    refs: speechActRefsOf(input.metadata),
    created_at_ms: input.nowMs,
    expire_at: expireAt(input.nowMs + METER_KEY_LIFETIME_MS),
  };
}

export function stageSpeechWindowActInTransaction(txn: Transaction, db: Firestore, doc: SpeechWindowActDoc): void {
  txn.set(db.collection(SPEECH_WINDOW_ACTS_COLLECTION).doc(doc.pe_id), { ...doc });
}

/** Parse a stored record; null when it is not one (never guessed). */
export function readSpeechWindowAct(raw: Record<string, unknown> | undefined): SpeechWindowActDoc | null {
  if (!raw || raw.schema !== 'provian.speech-window-act.v1'
    || typeof raw.pe_id !== 'string' || typeof raw.burn_id !== 'string' || typeof raw.action_type !== 'string') {
    return null;
  }
  const refs = speechActRefsOf(raw.refs as Record<string, unknown> | undefined);
  return { ...(raw as unknown as SpeechWindowActDoc), refs };
}
