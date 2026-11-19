import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentsLoadOnEnd, agentsLoadOnStart, yourAgentsCardMode } from './yourAgentsCard';

describe('"Your Agents" card', () => {
    it('while the first load is on its way it is loading, never "Connect an agent"', () => {
        expect(yourAgentsCardMode('loading', 0)).toBe('loading');
    });
    it('a failed load is an error with a retry, never "Connect an agent"', () => {
        expect(yourAgentsCardMode('failed', 0)).toBe('failed');
    });
    it('"Connect an agent" only after a load that returned zero agents', () => {
        expect(yourAgentsCardMode('loaded', 0)).toBe('connect');
        expect(yourAgentsCardMode('loaded', 2)).toBe('agents');
    });
    it('a refresh keeps an answer already on screen, and a failed refresh does not replace it', () => {
        expect(agentsLoadOnStart('loaded')).toBe('loaded');
        expect(agentsLoadOnEnd('loaded', false)).toBe('loaded');
    });
    it('a retry after a failure shows loading again, then the outcome', () => {
        expect(agentsLoadOnStart('failed')).toBe('loading');
        expect(agentsLoadOnEnd('loading', false)).toBe('failed');
        expect(agentsLoadOnEnd('loading', true)).toBe('loaded');
    });

    it('the Wallet home renders the card from yourAgentsCardMode and records both load outcomes', () => {
        const src = readFileSync(resolve(__dirname, 'DashboardScreen.tsx'), 'utf8');
        expect(src).toMatch(/useState<AgentsLoad>\('loading'\)/);
        const start = src.indexOf('const renderYourAgentsCard = ');
        expect(start).toBeGreaterThanOrEqual(0);
        const card = src.slice(start, src.indexOf("t('yourAgents.connectTitle')", start));
        expect(card).toMatch(/const mode = yourAgentsCardMode\(agentsLoad, linkedAgents\.length\);/);
        // The connect entry is reached only in 'connect' mode — never by an empty list alone.
        expect(card).toMatch(/if \(mode === 'connect'\) \{/);
        expect(card).not.toMatch(/if \(linkedAgents\.length === 0\)/);
        // One end-of-load call records both outcomes: an answered list, or a load whose retries all failed.
        expect(src).toMatch(/setAgentsLoad\(\(prev\) => agentsLoadOnEnd\(prev, list !== null\)\)/);
    });
});
