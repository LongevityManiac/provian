/**
 * signer-identity-set — the signer's own identity, as canonical owner-party strings (, Prompt 3).
 *
 * Independence is measured against the OPERATOR/SIGNER, never the device. This resolves the signer's
 * identity set — the existing same-owner fence's notion of "owner", extended to origins: the signer
 * wallet plus every identity the relay already binds to it (its native + proven external + retired
 * addresses, its linked principal/agent relationship, and its forge identities), each expressed in
 * the SAME canonical scheme the owner-resolver emits (`evm:<addr>`, `repo-owner:<account>`), so an
 * origin's resolved owner can be tested for membership by a plain string compare.
 *
 * FAIL-CLOSED = CONSERVATIVE (Security Invariant #7). A missing identity would let a same-party origin
 * be counted as independent — an OVER-count. So ANY registry read that throws sets `unresolvable:true`
 * and the caller counts ZERO independent origins for the PE (the PE still mints its BASE — only the
 * independence BONUS is withheld). Absence after a successful read is genuine absence, not an error.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { resolveBeneficiary, type BeneficiaryCacheEntry } from './beneficiary';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../agent-wallet/key-rotation-transition';
import { SERVICE_INSTALLS_COLLECTION } from '../witnesses/service-installs';
import { isSolanaAddress } from '../external-address/solana-keys';
import { SOLANA_PROVEN_ADDRESSES_COLLECTION } from '../external-address/solana-link';

export interface SignerIdentitySet {
  /** Canonical owner-party strings the signer IS. A resolved origin owner in here is same-party. */
  readonly identities: ReadonlySet<string>;
  /** True when a read failed — the caller must count ZERO independent origins (never over-count). */
  readonly unresolvable: boolean;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;

function addEvm(set: Set<string>, address: unknown): void {
  if (typeof address === 'string' && EVM.test(address)) set.add(`evm:${address.toLowerCase()}`);
}

/** follow-up: a Solana address, exactly as written (base58 is case-sensitive). */
function addSolana(set: Set<string>, address: unknown): void {
  if (isSolanaAddress(address)) set.add(`solana:${address}`);
}

/**
 * Add the forge identity of a login under the common host-qualified forms the owner-resolver may
 * emit (`repo-owner:<login>` for a bare `owner/repo`, and `repo-owner:<host>/<login>` for a
 * `host/owner/repo`), so a repo owned by this account matches regardless of how the tool named it.
 */
function addForgeLogin(set: Set<string>, login: unknown): void {
  if (typeof login !== 'string' || login.trim().length === 0) return;
  const l = login.trim();
  set.add(`repo-owner:${l}`);
  for (const host of ['github.com', 'gitlab.com', 'bitbucket.org']) {
    set.add(`repo-owner:${host}/${l}`);
  }
}

/**
 * Resolve the signer's identity set. `economicActorId` is the PE's `user_id`/`economic_actor_id`
 * (the agent_id on an agent PE, the user_id on a human PE). `walletAddress` is the signer's own
 * native address when known.
 */
export async function resolveSignerIdentitySet(
  db: Firestore,
  cache: RedisCache,
  params: { economicActorId: string; walletAddress: string | null },
  /** Injected for tests; production uses the real chain-validating resolver. */
  resolveBeneficiaryFn: (
    userId: string, cache: RedisCache, db: Firestore,
  ) => Promise<BeneficiaryCacheEntry> = resolveBeneficiary,
): Promise<SignerIdentitySet> {
  const identities = new Set<string>();
  const actor = params.economicActorId;
  if (typeof actor !== 'string' || actor.length === 0) {
    return { identities, unresolvable: true };
  }
  // 0. Trust Layer build (§2.1): the signer's OWN graph id. A `pe:` origin resolves to
  //    `signer:<cited actor id>`, so citing one's own PE is same-party by a plain string compare.
  identities.add(`signer:${actor}`);
  try {
    // 1. The signer's own native address, when the caller knows it.
    addEvm(identities, params.walletAddress);
    addSolana(identities, params.walletAddress);

    // 2. The signer's proven external addresses (one address, one agent, by protocol).
    const proven = await db.collection(PROVEN_ADDRESSES_COLLECTION)
      .where('agent_id', '==', actor).get();
    for (const doc of proven.docs) addEvm(identities, (doc.data() as { address?: unknown }).address);
    // 2b. The signer's proven SOLANA addresses ( follow-up; one registry for both).
    const solanaProven = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION)
      .where('agent_id', '==', actor).get();
    for (const doc of solanaProven.docs) addSolana(identities, (doc.data() as { address?: unknown }).address);

    // 3. Addresses this signer rotated AWAY from — still the same owner (rotation is not a wash).
    const retired = await db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION)
      .where('agent_id', '==', actor).get();
    for (const doc of retired.docs) {
      const d = doc.data() as { old_address?: unknown; address?: unknown };
      addEvm(identities, d.old_address ?? d.address);
    }

    // 4. The linked principal/agent relationship: the human beneficiary of a linked agent, that
    //    human's address, and — via (5) — that human's other linked agents.
    const beneficiary = await resolveBeneficiaryFn(actor, cache, db);
    let humanUserId: string | null = null;
    if (beneficiary.linked) {
      humanUserId = beneficiary.humanUserId;
      addEvm(identities, beneficiary.humanAddress);
      // The linked human's PEs are the same party as this agent's (§2.1: a `pe:` cite of the
      // principal's own approval PE is accountability, not consumption).
      if (typeof humanUserId === 'string' && humanUserId.length > 0) identities.add(`signer:${humanUserId}`);
    }

    // 4b. 2026-10-01: a PERSON's proven external addresses — the signer's own (a human signer)
    //     or its linked human's (a linked agent signer). Same owner, so never an independent origin.
    for (const personId of new Set<string>([actor, ...(humanUserId ? [humanUserId] : [])])) {
      const personProven = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION)
        .where('user_id', '==', personId).get();
      for (const doc of personProven.docs) addEvm(identities, (doc.data() as { address?: unknown }).address);
      const personSolana = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION)
        .where('user_id', '==', personId).get();
      for (const doc of personSolana.docs) addSolana(identities, (doc.data() as { address?: unknown }).address);
    }

    // 5. The human's OTHER linked agents (sibling agents share the human owner) + the human's
    //    forge identities. When the signer IS a human, use its own user_id for the forge read.
    //    When the signer is itself a human, its OWN linked agents are the same party the same way
    //: the relationship binds them in both directions.
    const forgeUserId = humanUserId ?? actor;
    const siblingWalletDocIds: string[] = [];
    {
      const siblings = await db.collection('agent_wallets')
        .where('linked_human_user_id', '==', forgeUserId).get();
      for (const doc of siblings.docs) {
        const d = doc.data() as { address?: unknown; agent_id?: unknown };
        addEvm(identities, d.address);
        if (typeof d.agent_id === 'string' && d.agent_id.length > 0) identities.add(`signer:${d.agent_id}`);
        siblingWalletDocIds.push(doc.id);
      }
    }

    // 6. Forge identities (GitHub/GitLab/Bitbucket) bound via the install → owner mapping.
    //    An install's `user_id` is the WALLET DOC id the connect flow authenticated
    //    (`wallet_…` for a human, `wallet_aw_…` for an agent), while a PE's economic actor is the
    //    wallet's `user_id` / `agent_id`. So the install read
    //    covers every key the signer (and, for a linked agent, its human) is known by: the actor
    //    id itself, the human's user id, and the wallet doc ids that map to either.
    const ownerKeys = new Set<string>([actor, forgeUserId]);
    for (const userKey of new Set<string>([actor, forgeUserId])) {
      const humanWallets = await db.collection('wallets').where('user_id', '==', userKey).get();
      for (const doc of humanWallets.docs) ownerKeys.add(doc.id);
    }
    const agentWallets = await db.collection('agent_wallets').where('agent_id', '==', actor).get();
    for (const doc of agentWallets.docs) ownerKeys.add(doc.id);
    // Sibling agents (and a human signer's own agents) connect forges under THEIR wallet doc ids.
    for (const id of siblingWalletDocIds) ownerKeys.add(id);
    for (const ownerKey of ownerKeys) {
      const installs = await db.collection(SERVICE_INSTALLS_COLLECTION)
        .where('user_id', '==', ownerKey).get();
      for (const doc of installs.docs) {
        addForgeLogin(identities, (doc.data() as { forge_account_login?: unknown }).forge_account_login);
      }
    }

    return { identities, unresolvable: false };
  } catch {
    // A registry read failed. Never over-count on an incomplete set.
    return { identities, unresolvable: true };
  }
}
