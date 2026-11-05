/**
 * [F18] The device-key agent-signing oracle is DELETED and must never return.
 *
 * `executeAgentSign` let an agent request drive a signature from a device-held
 * key, and `AgentManager` was its (zero-caller) dispatcher. Both were removed in
 * the 2026-09-10 security pass. The fabrication / kill-switch rigor moved onto the
 * shared `validateAndCheckKillSwitch` (see AgentAuthorizationGate.test.ts); this
 * file is the DELETION guard — a source scan proving no production module defines,
 * calls, or imports the removed oracle, so a future change cannot silently
 * reintroduce a device-signing path for agents.
 *
 * SOURCE scan (bound to source: these are removals, not runtime behavior). It
 * ships with a RED control proving the scan detects the live-code forms, and it
 * ignores prose comments — the tree still documents the removal by name.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(__dirname, '..', '..');

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

/** Strip // line comments and block comments so a documented removal by NAME is
 *  allowed, while a live definition/call/import is not. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Live-code forms only (never a bare word that a comment could carry):
//  - executeAgentSign as a call / assignment / member / type field
//  - AgentManager as an imported module, a class, or an instantiation
//  - AgentSignRequest as a declared interface/type
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
    { label: 'executeAgentSign call/def/member', re: /executeAgentSign\s*[(=:]/ },
    { label: "import from an AgentManager module", re: /from\s+['"][^'"]*AgentManager['"]/ },
    { label: 'class AgentManager', re: /class\s+AgentManager\b/ },
    { label: 'new AgentManager', re: /new\s+AgentManager\b/ },
    { label: 'AgentSignRequest declaration', re: /(interface|type)\s+AgentSignRequest\b/ },
];

describe('[F18] the device-key agent-signing oracle stays deleted', () => {
    const files = collectSourceFiles(SRC);

    it('scans a non-trivial population (empty-population control)', () => {
        expect(files.length).toBeGreaterThan(200);
    });

    it('the AgentManager module file no longer exists', () => {
        expect(existsSync(join(SRC, 'core', 'agents', 'AgentManager.ts'))).toBe(false);
    });

    it('no production source defines, calls, or imports the removed oracle', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const code = stripComments(readFileSync(file, 'utf8'));
            for (const { label, re } of FORBIDDEN) {
                if (re.test(code)) offenders.push(`${file.slice(SRC.length + 1)} :: ${label}`);
            }
        }
        expect(offenders, `removed agent-signing oracle reappeared:\n${offenders.join('\n')}`).toEqual([]);
    });

    // RED: the scan MUST fire on each live-code form (and comments MUST be ignored).
    it('RED — the scan detects each forbidden live-code form', () => {
        const live = [
            "const s = await executeAgentSign(token, req);",
            "import AgentManager from './AgentManager';",
            "class AgentManager {}",
            "new AgentManager()",
            "interface AgentSignRequest { agentId: string }",
        ];
        for (const sample of live) {
            expect(FORBIDDEN.some(({ re }) => re.test(stripComments(sample)))).toBe(true);
        }
    });

    it('RED — a prose comment naming the removal is NOT flagged (comment stripping works)', () => {
        const comment = "// [F18] executeAgentSign — DELETED; AgentManager.executeApprovedAction removed";
        expect(FORBIDDEN.some(({ re }) => re.test(stripComments(comment)))).toBe(false);
    });
});
