/**
 * fix 1: the Agent Wallet card's action buttons STACK full-width. Three across on a 320dp
 * Android phone left each ~80dp wide, so words broke mid-word ("Reco/ver agent", "Re-k/ey agent")
 * and "Set up a device for this agent" ran to six lines.
 *
 * RED baseline: the pre-fix styles were `walletActions: { flexDirection: 'row', … }` with
 * `walletActionButton: { flex: 1, … }` both assertions below fail against them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, 'AgentDetailScreen.tsx'), 'utf8');

function styleBlock(name: string): string {
    const start = src.indexOf(`    ${name}: {`);
    expect(start, `style ${name} exists`).toBeGreaterThan(0);
    return src.slice(start, src.indexOf('    },', start));
}

describe('Agent Wallet card actions (fix 1)', () => {
    it('the actions container is a column, never a row of three', () => {
        const block = styleBlock('walletActions');
        expect(block).toContain("flexDirection: 'column'");
        expect(block).not.toContain("flexDirection: 'row'");
    });

    it('a button does not share the row width (no flex: 1 squeeze); its label takes the rest of the button', () => {
        expect(styleBlock('walletActionButton')).not.toMatch(/\n\s+flex: 1,/);
        expect(styleBlock('walletActionText')).toMatch(/\n\s+flex: 1,/);
    });
});
