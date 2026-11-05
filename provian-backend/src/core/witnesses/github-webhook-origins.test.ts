import { synthesizeFromGitHubPayload } from './github-webhook';

/**
 * Prompt 2 — the GitHub push synthesizer captures the commit's external origins
 * (repo, PARENT `before` commit, head URL domain) as resolvable input_origins,
 * witnessed by the HMAC-verified webhook (forge_webhook). The `before` commit was
 * dropped before Prompt 2 even though every push payload carries it.
 */
describe('github-webhook synthesizePush — input_origins (Prompt 2)', () => {
  const pushPayload = {
    ref: 'refs/heads/master',
    before: 'AAAA1111bbbb2222cccc3333dddd4444eeee5555',
    after: '1111222233334444555566667777888899990000',
    repository: { full_name: 'LongevityManiac/provian-wallet', owner: { id: 42, login: 'LongevityManiac', type: 'User' } },
    head_commit: { id: '1111222233334444555566667777888899990000', url: 'https://github.com/LongevityManiac/provian-wallet/commit/1111222233334444555566667777888899990000', added: ['a.ts'], removed: [], modified: ['b.ts'] },
    commits: [{ added: ['a.ts'], removed: [], modified: ['b.ts'] }],
  };

  it('captures repo + parent commit + head URL domain as forge_webhook-witnessed origins', () => {
    const ev = synthesizeFromGitHubPayload('push', pushPayload);
    expect(ev).not.toBeNull();
    const origins = ev!.input_origins ?? [];
    const ids = origins.map((o) => o.origin_identifier);
    expect(ids).toContain('repo:LongevityManiac/provian-wallet');
    expect(ids).toContain('commit:aaaa1111bbbb2222cccc3333dddd4444eeee5555'); // the PARENT, lowercased
    expect(ids).toContain('domain:github.com');
    expect(origins.every((o) => o.witnessed === true && o.witness?.type === 'forge_webhook')).toBe(true);
    // The commit URL path is private (hashed), never in the clear.
    expect(ids.some((id) => id.includes('/commit/'))).toBe(false);
  });

  // RED CONTROL: a brand-new branch pushes an all-zero `before` (no parent) — the
  // synthesizer MUST NOT record a zero-sha commit origin. Only the repo survives.
  it('RED: all-zero `before` (new branch) yields a repo origin but NO parent commit origin', () => {
    const ev = synthesizeFromGitHubPayload('push', {
      ...pushPayload,
      before: '0000000000000000000000000000000000000000',
    });
    const ids = (ev!.input_origins ?? []).map((o) => o.origin_identifier);
    expect(ids).toContain('repo:LongevityManiac/provian-wallet');
    expect(ids.some((id) => id.startsWith('commit:'))).toBe(false);
  });

  // Fact-base fixes item 4 (2026-09-23): the relay-derived subset the webhook witnesses at pricing is
  // the repo + the parent commit ONLY — the head URL's domain (the forge's own host) and its private
  // path are recorded but never relay-derived.
  it('relay_derived_origins = repo + parent commit; the forge host URL origins are excluded', () => {
    const ev = synthesizeFromGitHubPayload('push', pushPayload);
    const derived = (ev!.relay_derived_origins ?? []).map((o) => o.origin_identifier);
    expect(derived).toEqual(['repo:LongevityManiac/provian-wallet', 'commit:aaaa1111bbbb2222cccc3333dddd4444eeee5555']);
    const all = (ev!.input_origins ?? []).map((o) => o.origin_identifier);
    expect(all).toContain('domain:github.com');
    expect(derived).not.toContain('domain:github.com');
  });
});
