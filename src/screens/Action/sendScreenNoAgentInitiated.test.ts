/**
 * [F19] The agent-initiated Send path was deleted: SendScreen is first-party only
 * (the owner operating their own wallet, gated by mandatory review + biometric).
 * It executed an agent-attributed on-chain send through first-party
 * TransactionService, bypassing evaluateCryptoTransaction and the shelved
 * AGENT_CRYPTO_AUTHORITY guard — the exact carve-out CLAUDE.md pitfall #13 scopes
 * to the owner ONLY.
 *
 * This is a SOURCE scan (bound to source because RN screens can't be imported under
 * vitest) proving no PRODUCTION route constructs Send params with an agent-initiated
 * flag, and that SendScreen carries no `isAgentInitiated` branch. It ships with a RED
 * control proving the scan detects the construction form.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '..', '..');

/** All production .ts/.tsx under src/, excluding test files. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (entry === 'node_modules' || entry === '__mocks__') continue;
            collectSourceFiles(full, acc);
        } else if (
            (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
            !entry.includes('.test.') &&
            !entry.endsWith('.d.ts')
        ) {
            acc.push(full);
        }
    }
    return acc;
}

// The dangerous construction forms: a route object property (`isAgentInitiated:`)
// or a type/param declaration (`isAgentInitiated?`). Plain-comment mentions of the
// bare word are allowed (they document the removal); a colon/question-mark form is
// live code and must never reappear.
const CONSTRUCTION_FORMS = [/isAgentInitiated\s*:/, /isAgentInitiated\s*\?/];

describe('[F19] no production route constructs Send with an agent-initiated flag', () => {
    const files = collectSourceFiles(SRC);

    it('scans a non-trivial population (empty-population control)', () => {
        expect(files.length).toBeGreaterThan(200);
    });

    it('no production source constructs or declares isAgentInitiated', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            if (CONSTRUCTION_FORMS.some((re) => re.test(text))) {
                offenders.push(file.slice(SRC.length + 1));
            }
        }
        expect(offenders, `these files still construct/declare isAgentInitiated: ${offenders.join(', ')}`).toEqual([]);
    });

    it('SendScreen carries no isAgentInitiated branch', () => {
        const send = readFileSync(join(SRC, 'screens', 'Action', 'SendScreen.tsx'), 'utf8');
        // Any surviving `isAgentInitiated &&` / `isAgentInitiated ?` branch is a live
        // agent path; only prose comments may mention the removed name.
        expect(send).not.toMatch(/isAgentInitiated\s*&&/);
        expect(send).not.toMatch(/isAgentInitiated\s*\?/);
        expect(send).not.toMatch(/const\s+isAgentInitiated\s*=/);
    });

    // RED control: the same scan MUST report the construction form when present.
    it('RED — the scan detects a Send params object with isAgentInitiated', () => {
        const synthetic = "navigation.navigate('Send', { isAgentInitiated: true, agentId: 'x' })";
        expect(CONSTRUCTION_FORMS.some((re) => re.test(synthetic))).toBe(true);
    });
});
