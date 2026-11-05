/**
 * Witness 3 - Service Installs (Tier A custody, no stored credential).
 *
 * Stores the non-sensitive pointer "user X connected install Y on service Z"
 * for Tier A push-with-signature connectors (e.g. a user-installed GitHub
 * App that pushes signed webhooks to the relay).
 *
 * **Custody invariant (amended by B2, the design requires PER-INSTALL
 * SECRETS).** This collection holds NO access token, NO refresh token, and
 * NO OAuth scopes — nothing that can read from or act on the connected
 * service. It DOES hold, for the self-serve webhook providers (gitlab /
 * bitbucket), a Provian-MINTED per-install `webhook_secret` the token the
 * repo owner pastes into their forge's webhook settings so INBOUND
 * deliveries can be verified. That secret is an inbound-delivery
 * authenticator for Provian's receiver, not a forge credential — its
 * compromise lets an attacker forge deliveries FOR THAT ONE INSTALL only
 * (the invariant: forge-scope = own install), never read anything
 * from the service. It is stored plaintext for the same reason webhook
 * subscription HMAC secrets are (pitfall #26): the receiver needs the raw
 * value to verify. GitHub installs carry NO per-install secret — the
 * GitHub App model verifies deliveries with the App-level secret that is
 * never distributed to repo owners.
 *
 * The Tier B line is unchanged: if you find yourself wanting to add a
 * READ-capable secret/token (access token, refresh token, API key for the
 * service), STOP — that would convert this from Tier A to Tier B
 * (stored-token polling), which is deferred and requires a separate
 * security review before any code is written.
 *
 * CONSUMED (A10, this docblock previously said "not mounted by any
 * route yet", which went stale when the receivers landed): the GitHub,
 * GitLab and Bitbucket witness routers (`routes/witnesses-*.ts`) import this
 * module for install registration and per-delivery resolution.
 *
 * Doc id convention: `{provider}_{installation_id}` so a single Firestore
 * `.doc()` lookup serves the per-delivery resolution path the future
 * webhook verifier needs.
 */

import * as crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Supported Tier A providers. New providers are added by extension; each must
 * be a true push-with-signature surface (per-delivery signature verifiable
 * against an app-wide secret, no readable user credential stored).
 */
export type ServiceInstallProvider = 'github' | 'gitlab' | 'bitbucket';

/**
 * The complete on-disk shape. NO forge credential — see the file-level
 * custody invariant for what the per-install `webhook_secret` is and is not.
 */
export interface ServiceInstallDocument {
  /** Provian user / wallet that owns the installation. */
  user_id: string;
  /** Which connected service this install belongs to. */
  provider: ServiceInstallProvider;
  /** The opaque installation identifier issued by the service (e.g. GitHub installation_id). */
  installation_id: string;
  /** Unix ms when the install was recorded by the relay. */
  installed_at: number;
  /** Unix ms when the user revoked. Null/undefined while active. */
  revoked_at: number | null;
  /**
   * B2 : the Provian-minted per-install webhook verify secret
   * (gitlab/bitbucket only; github installs never carry one). Minted at
   * registration, returned ONCE by the /installs response, MASKED on every
   * list read, verified per-delivery by the receiver. Absent on legacy rows
   * registered before B2 — those grandfather onto the app-wide secret until
   * re-registered.
   */
  webhook_secret?: string | null;
  /**
   * 2026-08-16 re-key: the STABLE forge account this install serves — for
   * github the GitHub account databaseId of `repository.owner`, stamped from
   * the first HMAC-verified delivery (stampServiceInstallForgeAccount; the
   * relay holds no GitHub App private key by design, so a signed
   * delivery is the only trustworthy source). Author mappings are scoped to
   * THIS id, not to the ephemeral wallet or installation_id, so a GitHub-side
   * uninstall/reinstall (which mints a NEW installation_id) or a wallet
   * re-point never orphans existing mappings. gitlab/bitbucket installs do
   * not need the stamp: their self-serve `installation_id` (project id /
   * repo uuid) IS the stable forge scope — see installForgeAccountScope.
   * Absent on a github install until its first verified delivery.
   */
  forge_account_id?: string | null;
  /** Display-only login for the stamped forge account (github only). */
  forge_account_login?: string | null;
}

/**
 * Event-level dedup key. The future webhook verifier dedups inbound
 * deliveries by this triple before submitting a PE. Defined here as a
 * type so the dedup contract is co-located with the install record; no
 * logic uses it yet.
 */
export interface ServiceInstallEventDedupKey {
  user_id: string;
  provider: ServiceInstallProvider;
  event_id: string;
}

// -----------------------------------------------------------------------------
// Collection + doc-id helper
// -----------------------------------------------------------------------------

/** The Firestore collection of forge installs. Exported so the signer-identity-set
 * (, Prompt 3) reads the same one rather than redeclaring the literal. */
export const SERVICE_INSTALLS_COLLECTION = 'service_installs';
const COLLECTION = SERVICE_INSTALLS_COLLECTION;

function docIdFor(provider: ServiceInstallProvider, installationId: string): string {
  return `${provider}_${installationId}`;
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

/**
 * Providers whose installs are registered self-serve with a Provian-minted
 * per-install webhook secret (B2,). GitHub is deliberately absent:
 * the GitHub App's app-level secret verifies its deliveries and is never
 * distributed, so its installs carry no secret.
 */
export const PER_INSTALL_SECRET_PROVIDERS: ReadonlySet<ServiceInstallProvider> =
  new Set(['gitlab', 'bitbucket']);

/** 32 bytes of entropy, hex — the minted per-install webhook secret. */
export function mintInstallWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Thrown by `createServiceInstall` when an ACTIVE row for (provider,
 * installation_id) belongs to a different user. Callers map it to a 409 /
 * `conflict` answer; the row is never touched.
 */
export class ServiceInstallOwnedByOtherUserError extends Error {
  readonly code = 'install_owned_by_other_user' as const;
  constructor(readonly provider: ServiceInstallProvider, readonly installationId: string) {
    super(`service install ${provider}_${installationId} is owned by another user`);
    this.name = 'ServiceInstallOwnedByOtherUserError';
  }
}

export interface CreateServiceInstallResult {
  doc: ServiceInstallDocument;
  /**
   * True iff THIS call minted a fresh webhook secret (first registration, a
   * legacy secret-less row, or re-registration after revoke). The caller
   * returns the secret to the owner ONLY in that case — the once-only
   * disclosure rule (pitfall #26). False for github (never minted) and for
   * an idempotent re-POST on an active install that already has one.
   */
  secretIssued: boolean;
}

/**
 * Create the install pointer. Idempotent for re-installs of the same
 * (provider, installation_id): a re-install resets `installed_at` and
 * clears `revoked_at` so a user who uninstalls and reinstalls on the
 * service side re-enters an active state without manual reset.
 *
 * Per-install secret lifecycle (B2,), for gitlab/bitbucket only:
 * - fresh registration → mint;
 * - legacy secret-less active row → mint on re-registration (upgrade);
 * - re-registration AFTER revoke → mint a NEW secret (rotation: revoke +
 * re-register is the rotation path);
 * - re-POST on an active row that already has one → PRESERVE (no silent
 * rotation; the live forge webhook keeps working) and issue nothing.
 *
 * Throws if `installation_id` or `user_id` is empty - callers should
 * have validated upstream, but this is a cheap defensive check.
 */
export async function createServiceInstall(
  db: Firestore,
  params: {
    user_id: string;
    provider: ServiceInstallProvider;
    installation_id: string;
  },
): Promise<CreateServiceInstallResult> {
  if (!params.user_id) throw new Error('createServiceInstall: user_id is required');
  if (!params.installation_id) throw new Error('createServiceInstall: installation_id is required');

  const wantsSecret = PER_INSTALL_SECRET_PROVIDERS.has(params.provider);
  const ref = db.collection(COLLECTION).doc(docIdFor(params.provider, params.installation_id));
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as ServiceInstallDocument) : null;
    // HIJACK GUARD (2026-10-17): an ACTIVE row belongs to exactly one user, and
    // re-pointing it is refused HERE, inside the transaction, for every provider.
    // The GitHub connect flow had no owner check at all — its setup-callback is
    // unauthenticated and takes `installation_id` from GitHub's redirect query
    // string, so any user could complete their own pending state with a victim's
    // installation id and, on poll, take over the victim's webhook deliveries
    // (and so the minting of the victim's commits). The GitLab/Bitbucket route
    // checks were read-then-set races. A REVOKED row may be re-registered by
    // anyone: revoke + re-register is the documented rotation / re-point path.
    if (existing !== null && existing.revoked_at === null && existing.user_id !== params.user_id) {
      throw new ServiceInstallOwnedByOtherUserError(params.provider, params.installation_id);
    }
    const keepExistingSecret = wantsSecret
      && existing !== null
      && existing.revoked_at === null
      && typeof existing.webhook_secret === 'string'
      && existing.webhook_secret.length > 0;
    const secretIssued = wantsSecret && !keepExistingSecret;

    const doc: ServiceInstallDocument = {
      user_id: params.user_id,
      provider: params.provider,
      installation_id: params.installation_id,
      installed_at: Date.now(),
      revoked_at: null,
      ...(wantsSecret
        ? {
          webhook_secret: keepExistingSecret
            ? (existing!.webhook_secret as string)
            : mintInstallWebhookSecret(),
        }
        : {}),
    };
    // Merge, never replace: the stamped forge account (`forge_account_id` /
    // `forge_account_login`, the stable scope of every author mapping) survives
    // a same-owner re-install or a post-revoke re-point. Every field this call
    // owns is written explicitly above, so nothing stale can hide behind it.
    tx.set(ref, doc, { merge: true });
    return { doc, secretIssued };
  });
}

/**
 * Resolve an install by (provider, installation_id). The future webhook
 * verifier uses this to map an inbound delivery's `installation_id` to
 * the owning Provian `user_id` before it submits the PE.
 *
 * Returns null when no install exists. Returns the document including
 * `revoked_at` when revoked - callers decide whether a revoked install
 * is still acceptable (the webhook verifier rejects it).
 */
export async function getServiceInstallByInstallationId(
  db: Firestore,
  provider: ServiceInstallProvider,
  installationId: string,
): Promise<ServiceInstallDocument | null> {
  const snap = await db.collection(COLLECTION).doc(docIdFor(provider, installationId)).get();
  if (!snap.exists) return null;
  return snap.data() as ServiceInstallDocument;
}

/**
 * Mark an install as revoked. Idempotent - calling on an already-revoked
 * install is a no-op (the original `revoked_at` is preserved).
 *
 * The user revokes on the service's own domain (e.g. github.com); the
 * relay learns about it via a webhook-side signal in a later step. This
 * function is the write path for that signal.
 *
 * Returns true if the install existed (whether or not the call changed
 * state), false if no such install was found.
 */
export async function markServiceInstallRevoked(
  db: Firestore,
  provider: ServiceInstallProvider,
  installationId: string,
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(docIdFor(provider, installationId));
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data() as ServiceInstallDocument;
  if (data.revoked_at != null) return true; // already revoked; idempotent no-op
  await ref.update({ revoked_at: Date.now() });
  return true;
}

/**
 * The stable forge-account scope an install serves — the id author mappings
 * are keyed to. ONE definition, shared by the webhook receivers, the
 * registration route, and the revocation authority check, so the scope rule
 * cannot drift between them (self-referential-control doctrine).
 *
 * - github: the stamped `forge_account_id` (from the first HMAC-verified
 * delivery's `repository.owner.id`). NULL until stamped — a never-pushed
 * github install cannot scope anything yet (Unknown = Block, never a
 * guess). installation_id is deliberately NOT a fallback here: GitHub
 * installation ids and account ids are different numbering spaces, and a
 * cross-space compare could collide.
 * - gitlab / bitbucket: the self-serve `installation_id` (GitLab project id
 * / Bitbucket repo uuid) IS the stable scope — it survives a wallet
 * re-point because createServiceInstall keys the row by
 * (provider, installation_id) and only overwrites user_id.
 */
export function installForgeAccountScope(install: ServiceInstallDocument): string | null {
  if (install.provider === 'github') {
    return typeof install.forge_account_id === 'string' && install.forge_account_id.length > 0
      ? install.forge_account_id
      : null;
  }
  return install.installation_id;
}

/**
 * Stamp the forge account a github install serves, learned from an
 * HMAC-verified delivery's `repository.owner`. Idempotent: writes only when
 * the stored value is missing or changed, never creates a row, and MUST only
 * be called after the delivery's signature has verified (the stamp is what
 * authorizes explicit contributor-registration scoping, so it can only ever
 * derive from an authenticated payload). Returns true iff a write happened.
 */
export async function stampServiceInstallForgeAccount(
  db: Firestore,
  provider: ServiceInstallProvider,
  installationId: string,
  account: { id: string; login: string | null },
): Promise<boolean> {
  if (!account.id) return false;
  const ref = db.collection(COLLECTION).doc(docIdFor(provider, installationId));
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data() as ServiceInstallDocument;
  if (data.forge_account_id === account.id && (data.forge_account_login ?? null) === account.login) {
    return false;
  }
  await ref.update({
    forge_account_id: account.id,
    forge_account_login: account.login,
  });
  return true;
}

/**
 * List all installs for a given user. Used by the future user-facing
 * "connected services" view and by revocation flows that need to clean
 * up all of a user's installs at once.
 */
export async function getServiceInstallsByUser(
  db: Firestore,
  userId: string,
): Promise<ServiceInstallDocument[]> {
  if (!userId) return [];
  const snaps = await db
    .collection(COLLECTION)
    .where('user_id', '==', userId)
    .get();
  return snaps.docs.map((d) => d.data() as ServiceInstallDocument);
}
