import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREEN = readFileSync(resolve(__dirname, 'NetworkConstitutionScreen.tsx'), 'utf8');
const STORE = readFileSync(resolve(__dirname, '../../store/walletStore.ts'), 'utf8');

describe('canonical Network Constitution reader', () => {
  it('renders the generated root document and carries no competing hardcoded articles', () => {
    expect(SCREEN).toContain("from '../../generated/networkConstitution'");
    expect(SCREEN).toContain('charter.sections.map');
    expect(SCREEN).toContain('NETWORK_CONSTITUTION_SOURCE_SHA256');
    expect(SCREEN).toContain('getNetworkConstitution(i18n.resolvedLanguage || i18n.language)');
    expect(SCREEN).toContain("t('constitutionScreen.canonicalNote')");
    expect(SCREEN).not.toContain('const ARTICLES');
    expect(STORE).not.toContain('HUMAN_AGENTIC_CONSTITUTION_VERSION');
    expect(STORE).not.toContain('NETWORK_CONSTITUTION_VERSION');
  });
});
