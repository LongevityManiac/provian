import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PVT9_TOKEN } from '../chains/evm/config';
import { isPvtMintTransfer, ZERO_ADDRESS } from './pvtMintClassifier';
import { PREDECESSOR_PVT9_KERNEL_FOR_HISTORY } from './pvtHistoricalKernels';

const SRC = join(__dirname, '..', '..');
/** The retired kernel, from the deployment record — not a second literal in app source. */
const RETIRED = (JSON.parse(readFileSync(join(SRC, '..', 'contracts', 'deployments', 'base-pvt9-institutions.json'), 'utf8')) as {
    predecessor: { pvt9Kernel: string };
}).predecessor.pvt9Kernel.toLowerCase();

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

describe('the retired PVT kernel is history recognition only', () => {
    it('is the kernel from the deployment record, and never the live token', () => {
        expect(PREDECESSOR_PVT9_KERNEL_FOR_HISTORY.toLowerCase()).toBe(RETIRED);
        expect(PVT9_TOKEN.address.toLowerCase()).not.toBe(RETIRED);
    });

    it('a mint on it still classifies as an earning (and a mint on the live token too)', () => {
        for (const pvtAddress of [PVT9_TOKEN.address, PREDECESSOR_PVT9_KERNEL_FOR_HISTORY]) {
            expect(isPvtMintTransfer({ isReceived: true, from: ZERO_ADDRESS, contractAddress: pvtAddress, pvtAddress })).toBe(true);
        }
    });

    it('only the history service imports it — no send, balance, approve or burn path does', () => {
        const importers = walk(SRC)
            .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
            .filter((f) => /from\s+['"][^'"]*pvtHistoricalKernels['"]/.test(readFileSync(f, 'utf8')))
            .map((f) => relative(SRC, f));
        expect(importers).toEqual(['core/history/TransactionHistoryService.ts']);
    });

    it('RED — no other app source names the retired kernel', () => {
        const naming = walk(SRC)
            .filter((f) => /\.(ts|tsx|json)$/.test(f) && !f.endsWith('pvt9-base-config.generated.ts'))
            .filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(RETIRED))
            .map((f) => relative(SRC, f));
        expect(naming).toEqual(['core/history/pvtHistoricalKernels.ts']);
    });
});
