/**
 * forgeContributors — the owner-side Contributors logic (Part 2). Every
 * decision has a constructible violating input, so each guard is observed RED.
 * The command builder is pinned literally against the SDK bin's flag names.
 */
import { describe, expect, it } from 'vitest';
import {
    buildRegisterGitIdentityCommand,
    challengeMinutesLeft,
    chooseContributorHandoff,
    describeMapping,
    mappingsForInstall,
    validateContributorInput,
    type ContributorMapping,
} from './forgeContributors';

const MAPPING: ContributorMapping = {
    mapping_id: 'github_abc', provider: 'github', forge_account_id: '21031067', forge_account_login: 'frank',
    source_owner_wallet_id: 'wallet_frank', agent_wallet_id: 'wallet_aw_atlas', agent_id: 'atlas',
    author_key_type: 'email', author_key_hash: 'ff'.repeat(32), verified_by: 'agent_wallet_signature',
    status: 'active', created_at: 1, verified_at: 10, revoked_at: null,
};

describe('validateContributorInput', () => {
    it('accepts a wallet_aw_ id and an email (trimmed, any case)', () => {
        expect(validateContributorInput({ agentWalletId: ' wallet_aw_atlas ', email: ' Atlas@Example.com ' })).toBeNull();
    });
    it('RED: a human wallet id, a bare name, or a non-email is refused before any round-trip', () => {
        expect(validateContributorInput({ agentWalletId: 'wallet_frank', email: 'a@b.co' })).toBe('agent_wallet_id');
        expect(validateContributorInput({ agentWalletId: 'atlas', email: 'a@b.co' })).toBe('agent_wallet_id');
        expect(validateContributorInput({ agentWalletId: 'wallet_aw_atlas', email: 'not an email' })).toBe('email');
    });
});

describe('chooseContributorHandoff', () => {
    it('a linked agent registers itself; anyone else needs an owner-issued challenge', () => {
        expect(chooseContributorHandoff('wallet_aw_atlas', ['wallet_aw_atlas'])).toBe('linked_self');
        expect(chooseContributorHandoff('wallet_aw_other', ['wallet_aw_atlas'])).toBe('owner_challenge');
    });
    it('RED: an empty linked set never yields linked_self', () => {
        expect(chooseContributorHandoff('wallet_aw_atlas', [])).toBe('owner_challenge');
    });
});

describe('buildRegisterGitIdentityCommand (pinned to the SDK bin flags)', () => {
    it('linked_self: install-scoped, provider only when not github', () => {
        expect(buildRegisterGitIdentityCommand({ handoff: 'linked_self', provider: 'github', installationId: '777', email: 'Atlas@Example.com' }))
            .toBe('npx @provian/agent-sdk register-git-identity --email atlas@example.com --installation 777');
        expect(buildRegisterGitIdentityCommand({ handoff: 'linked_self', provider: 'gitlab', installationId: '42', email: 'a@b.co' }))
            .toBe('npx @provian/agent-sdk register-git-identity --email a@b.co --provider gitlab --installation 42');
    });
    it('owner_challenge: carries the challenge id and nothing that could re-scope it', () => {
        expect(buildRegisterGitIdentityCommand({ handoff: 'owner_challenge', provider: 'github', installationId: '777', email: 'a@b.co', challengeId: 'ch_1' }))
            .toBe('npx @provian/agent-sdk register-git-identity --email a@b.co --challenge ch_1');
    });
    it('RED: owner_challenge without a challenge id throws rather than emitting a self-registration command', () => {
        expect(() => buildRegisterGitIdentityCommand({ handoff: 'owner_challenge', provider: 'github', installationId: '777', email: 'a@b.co' }))
            .toThrow(/challengeId/);
    });
});

describe('mappingsForInstall', () => {
    it('keeps only mappings on this install\'s forge account and provider, active first', () => {
        const other = { ...MAPPING, mapping_id: 'gitlab_x', provider: 'gitlab' as const, forge_account_id: 'proj_9' };
        const revoked = { ...MAPPING, mapping_id: 'github_old', status: 'revoked' as const, verified_at: 99 };
        const rows = mappingsForInstall([revoked, other, MAPPING], { provider: 'github', forgeAccountId: '21031067' });
        expect(rows.map((r) => r.mapping_id)).toEqual(['github_abc', 'github_old']);
    });
    it('RED: an unstamped install (no forge account yet) lists nothing — never a guess', () => {
        expect(mappingsForInstall([MAPPING], { provider: 'github', forgeAccountId: null })).toEqual([]);
    });
});

describe('describeMapping', () => {
    it('an agent-signed mapping vouched by this owner is revocable', () => {
        const d = describeMapping(MAPPING, 'wallet_frank');
        expect(d).toMatchObject({ title: 'wallet_aw_atlas', kindKey: 'earn.forge.contributors.kindAgent', statusKey: 'earn.forge.contributors.statusActive', revocable: true });
        expect(d.keyLabel).toBe(`email ${'ff'.repeat(5)}…`);
    });
    it('RED: not revocable when revoked, when owner-captured, or when vouched by someone else', () => {
        expect(describeMapping({ ...MAPPING, status: 'revoked' }, 'wallet_frank').revocable).toBe(false);
        expect(describeMapping({ ...MAPPING, verified_by: 'repo_owner_capture', agent_id: 'frank' }, 'wallet_frank')).toMatchObject({ revocable: false, kindKey: 'earn.forge.contributors.kindOwner', title: 'frank' });
        expect(describeMapping(MAPPING, 'wallet_someone_else').revocable).toBe(false);
    });
});

describe('challengeMinutesLeft', () => {
    it('rounds up and never goes negative', () => {
        expect(challengeMinutesLeft(1_000 + 4 * 60_000 + 1, 1_000)).toBe(5);
        expect(challengeMinutesLeft(1_000, 2_000)).toBe(0);
    });
});
