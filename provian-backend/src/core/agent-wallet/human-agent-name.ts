/**
 * The human names their agent (agent-path close-out, item 5).
 *
 * The agent's IDENTITY is its key; its name is display metadata. The linked human may set that
 * name — at accept time (`POST /accept-invite` with `agent_name`) or any time afterwards
 * (`POST /:wallet_id/human-name`) — and once they have, the human's name holds everywhere:
 *
 *  - `agent_wallets.display_name` is the canonical name every surface reads (Hub cards, agent
 *    detail, recovery, the Commons, the directory, the public record), stamped with
 *    `display_name_set_by: 'linked_human'` + `display_name_set_at`;
 *  - the Commons profile (`commons_profiles/{wallet_id}`) and the agent directory entry
 *    (`agent_directory/{wallet_id}`) mirror the name, so they are updated in the same transaction
 *    when they exist (neither is created here);
 *  - the agent's own Commons profile update refuses a different `display_name` while the flag is
 *    set (`display_name_set_by_human`), and a later Commons join/register takes the human's name.
 *
 * Renaming seals NO PE and never touches a sealed one: there is no action type for it and the
 * action-policy matrix does not move. The `invite_accepted` PE that accept creates seals whatever
 * name holds at that moment (a NEW PE, not a rewrite).
 */
import type { AgentWalletDocument } from './types';

export const DISPLAY_NAME_SET_BY_LINKED_HUMAN = 'linked_human' as const;
export const AGENT_DISPLAY_NAME_MAX = 100;

export type AgentDisplayNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: 'agent_name_required' | 'agent_name_too_long' | 'agent_name_markup' };

/**
 * The same rule as wallet creation (`POST /create`): a string, no `<`/`>` (it is interpolated into
 * Provian-branded invite emails), at most 100 characters — trimmed here, and at least 1 after
 * trimming.
 */
export function validateAgentDisplayName(raw: unknown): AgentDisplayNameValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'agent_name_required' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'agent_name_required' };
  if (value.length > AGENT_DISPLAY_NAME_MAX) return { ok: false, error: 'agent_name_too_long' };
  if (/[<>]/.test(value)) return { ok: false, error: 'agent_name_markup' };
  return { ok: true, value };
}

/** True while the linked human's chosen name holds (the agent may not overwrite it). */
export function isDisplayNameSetByHuman(wallet: Pick<AgentWalletDocument, 'display_name_set_by'> | Record<string, unknown> | null | undefined): boolean {
  return !!wallet && (wallet as { display_name_set_by?: unknown }).display_name_set_by === DISPLAY_NAME_SET_BY_LINKED_HUMAN;
}

export interface ApplyHumanAgentNameResult {
  display_name: string;
  display_name_set_by: typeof DISPLAY_NAME_SET_BY_LINKED_HUMAN;
  display_name_set_at: number;
  /** Which mirrors carried the name and were updated alongside the canonical wallet doc. */
  mirrors: { commons_profile: boolean; agent_directory: boolean };
}

/**
 * Write the human's chosen name: the canonical wallet doc plus the Commons-profile and directory
 * mirrors that exist, in ONE transaction (all or nothing). The caller has already authorized the
 * human (wallet auth + linked_human_user_id) and validated the name.
 */
export async function applyHumanAgentName(
  db: FirebaseFirestore.Firestore,
  walletId: string,
  name: string,
  now: number = Date.now(),
): Promise<ApplyHumanAgentNameResult> {
  const walletRef = db.collection('agent_wallets').doc(walletId);
  const profileRef = db.collection('commons_profiles').doc(walletId);
  const directoryRef = db.collection('agent_directory').doc(walletId);
  const mirrors = { commons_profile: false, agent_directory: false };
  await db.runTransaction(async (txn) => {
    // Firestore transactions require every read before any write.
    const [walletSnap, profileSnap, directorySnap] = await Promise.all([
      txn.get(walletRef), txn.get(profileRef), txn.get(directoryRef),
    ]);
    if (!walletSnap.exists) throw new Error('agent_wallet_not_found');
    txn.update(walletRef, {
      display_name: name,
      display_name_set_by: DISPLAY_NAME_SET_BY_LINKED_HUMAN,
      display_name_set_at: now,
      updated_at: now,
    });
    if (profileSnap.exists) {
      mirrors.commons_profile = true;
      txn.update(profileRef, { display_name: name, updated_at: now });
    }
    if (directorySnap.exists) {
      mirrors.agent_directory = true;
      txn.update(directoryRef, { display_name: name, updated_at: now });
    }
  });
  return {
    display_name: name,
    display_name_set_by: DISPLAY_NAME_SET_BY_LINKED_HUMAN,
    display_name_set_at: now,
    mirrors,
  };
}
