/**
 * forgeContributors - the pure logic behind ForgeContributorsScreen (
 * Part 2, owner side). Kept free of React and RelayAPIService so it is unit
 * testable: input validation, the handoff decision, the exact command the
 * owner hands the agent, and the display shape of a mapping.
 *
 * Attribution model (relay: routes/agent-attribution.ts): the forge webhook
 * credits a commit's git AUTHOR by a registered identity → wallet mapping,
 * scoped to the owner's forge account. Two ways an agent gets registered on
 * THIS owner's repository:
 * - linked_self: the agent is this owner's LINKED agent; the link is the
 * owner's standing authorization, so the agent registers
 * itself in one command with no challenge.
 * - owner_challenge: any other agent; the owner issues a claims-bound
 * challenge here (owner wallet auth) and the agent completes
 * it under its OWN auth — the signature comes back through
 * the relay, never pasted into this phone.
 *
 * Registering is attribution, not activity: it mints nothing. Eligible
 * verified pushes may mint PVT under protocol rules.
 */

import type { AuthorMapping, ForgeInstallProvider } from '../../services/RelayAPIService';

export type ContributorHandoff = 'linked_self' | 'owner_challenge';

/** The relay's mapping shape — ONE declaration (RelayAPIService), aliased here. */
export type ContributorMapping = AuthorMapping;

// Mirror the relay's validation (author-mappings.ts normalizeAuthorKey / the
// agent-wallet id shape) so obvious mistakes fail before a round-trip.
const AGENT_WALLET_ID_RE = /^wallet_aw_[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type ContributorInputError = 'agent_wallet_id' | 'email';

export interface ContributorInput {
    agentWalletId: string;
    email: string;
}

/** Trim + validate the two owner-entered fields. Null = valid. */
export function validateContributorInput(input: ContributorInput): ContributorInputError | null {
    if (!AGENT_WALLET_ID_RE.test(input.agentWalletId.trim())) return 'agent_wallet_id';
    if (!EMAIL_RE.test(input.email.trim().toLowerCase())) return 'email';
    return null;
}

/**
 * Which handoff applies. A LINKED agent (one of this owner's beneficiary-linked
 * agents) registers itself under the standing authorization of the link; any
 * other agent needs an owner-issued challenge. The linked set is the relay's
 * answer (`/v1/relay/agent/sessions` linked_agents), never inferred here.
 */
export function chooseContributorHandoff(agentWalletId: string, linkedAgentWalletIds: readonly string[]): ContributorHandoff {
    return linkedAgentWalletIds.includes(agentWalletId.trim()) ? 'linked_self' : 'owner_challenge';
}

export interface ContributorCommandInput {
    handoff: ContributorHandoff;
    provider: ForgeInstallProvider;
    installationId: string;
    email: string;
    /** Required for owner_challenge; ignored for linked_self. */
    challengeId?: string;
}

/**
 * The exact one-line command the owner shows the agent. Single source: pinned
 * by forgeContributors.test.ts and mirrors the SDK bin's flag names
 * (provian-agent-sdk/src/scripts/register-git-identity.ts).
 */
export function buildRegisterGitIdentityCommand(input: ContributorCommandInput): string {
    const email = input.email.trim().toLowerCase();
    const parts = ['npx @provian/agent-sdk register-git-identity', `--email ${email}`];
    if (input.handoff === 'owner_challenge') {
        if (!input.challengeId) {
            throw new Error('owner_challenge handoff requires a challengeId');
        }
        parts.push(`--challenge ${input.challengeId}`);
        return parts.join(' ');
    }
    if (input.provider !== 'github') parts.push(`--provider ${input.provider}`);
    parts.push(`--installation ${input.installationId}`);
    return parts.join(' ');
}

/** Mappings shown for ONE install: same provider, same forge account (the mapping's scope). */
export function mappingsForInstall(
    mappings: readonly ContributorMapping[],
    install: { provider: ForgeInstallProvider; forgeAccountId: string | null },
): ContributorMapping[] {
    if (!install.forgeAccountId) return [];
    return mappings
        .filter((m) => m.provider === install.provider && m.forge_account_id === install.forgeAccountId)
        .sort((a, b) => (a.status === b.status ? b.verified_at - a.verified_at : a.status === 'active' ? -1 : 1));
}

export interface MappingDisplay {
    title: string;
    kindKey: 'earn.forge.contributors.kindAgent' | 'earn.forge.contributors.kindOwner';
    statusKey: 'earn.forge.contributors.statusActive' | 'earn.forge.contributors.statusRevoked';
    revocable: boolean;
    keyLabel: string;
}

/**
 * Display shape for a mapping row. The owner may revoke only mappings it
 * VOUCHED (the vouching wallet is the sole revocation authority on the
 * owner side); owner-capture rows follow install ownership and are not
 * revoked here.
 */
export function describeMapping(mapping: ContributorMapping, ownerWalletId: string): MappingDisplay {
    const isOwnerCapture = mapping.verified_by === 'repo_owner_capture';
    return {
        title: isOwnerCapture ? mapping.agent_id : mapping.agent_wallet_id,
        kindKey: isOwnerCapture ? 'earn.forge.contributors.kindOwner' : 'earn.forge.contributors.kindAgent',
        statusKey: mapping.status === 'active' ? 'earn.forge.contributors.statusActive' : 'earn.forge.contributors.statusRevoked',
        revocable: mapping.status === 'active' && !isOwnerCapture && mapping.source_owner_wallet_id === ownerWalletId,
        keyLabel: `${mapping.author_key_type} ${mapping.author_key_hash.slice(0, 10)}…`,
    };
}

/** Human-readable remaining validity for an issued challenge, in whole minutes (never negative). */
export function challengeMinutesLeft(expiresAtMs: number, nowMs: number): number {
    return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 60_000));
}
