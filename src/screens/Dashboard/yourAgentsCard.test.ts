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

    it('the Wallet home renders the card from the agents loader, and its read reports failure', () => {
        const src = readFileSync(resolve(__dirname, 'DashboardScreen.tsx'), 'utf8');
        const start = src.indexOf('const renderYourAgentsCard = ');
        expect(start).toBeGreaterThanOrEqual(0);
        const card = src.slice(start, src.indexOf("t('yourAgents.connectTitle')", start));
        expect(card).toMatch(/const mode = yourAgentsCardMode\(agents\.phase, linkedAgents\.length\);/);
        // The connect entry is reached only in 'connect' mode — never by an empty list alone.
        expect(card).toMatch(/if \(mode === 'connect'\) \{/);
        expect(card).not.toMatch(/if \(linkedAgents\.length === 0\)/);
        // A failed read must throw, not resolve to an empty list that would read as "no agents".
        expect(src).toMatch(/getLinkedAgents\(\{ throwOnError: true \}\)/);
    });
});
