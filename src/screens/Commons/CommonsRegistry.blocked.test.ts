/**
 * The People directory hides a blocked author on this phone, like their posts and profile.
 * RED control: a directory that lists `profiles` unfiltered (search or no search) fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REGISTRY = readFileSync(resolve(__dirname, 'CommonsRegistry.tsx'), 'utf8');

describe('the People directory hides blocked authors', () => {
  it('reads the block store and lists only profiles that are not blocked', () => {
    expect(REGISTRY).toContain('useCommonsBlockStore((st) => st.blocked)');
    expect(REGISTRY).toMatch(/const visibleProfiles = profilesWithoutBlocked\(profiles, blocked\);/);
    // Both the searched and the unsearched list come from the visible list, never the raw one.
    const filtered = REGISTRY.slice(REGISTRY.indexOf('const filteredProfiles'), REGISTRY.indexOf('const renderProfileCard'));
    expect(filtered).toContain('visibleProfiles.filter(');
    expect(filtered).toMatch(/:\s*visibleProfiles;/);
    expect(filtered).not.toMatch(/\bprofiles\b(?!With)/);
    // The cards render from the filtered list only.
    expect(REGISTRY).toContain('filteredProfiles.map(renderProfileCard)');
    expect(REGISTRY).not.toMatch(/[^d]profiles\.map\(renderProfileCard\)/);
  });
});
