import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { yourAgentsCardMode } from './yourAgentsCard';

describe('"Your Agents" card', () => {
    it('while the first answer is on its way it is loading, never "Connect an agent"', () => {
        expect(yourAgentsCardMode('loading', 0)).toBe('loading');
    });
    it('every read failed with nothing saved: an error with a retry, never "Connect an agent"', () => {
        expect(yourAgentsCardMode('failed', 0)).toBe('failed');
    });
    it('"Connect an agent" only for an answer that held zero agents', () => {
        for (const phase of ['fresh', 'updating', 'saved'] as const) {
            expect(yourAgentsCardMode(phase, 0)).toBe('connect');
            expect(yourAgentsCardMode(phase, 2)).toBe('agents');
        }
    });

    it('Earn only enables the agent connector after its connection status is known', () => {
        const src = readFileSync(resolve(__dirname, '../Earn/EarnHubScreen.tsx'), 'utf8');
        expect(src).toContain("getLinkedAgentIdentities({ throwOnError: true })");
        expect(src).toContain('disabled={loading}');
        expect(src).toContain("navigation.navigate('AgentHub')");
    });
});
