import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolDeployment } from './pointer';
import { clearHomeBalanceVerification, claimHomeBalanceVerification, prepareHomeBalanceVerification } from './homeBalanceVerification';
import { currentProtocolDeployment, protocolDeploymentCandidate } from './runtime';

vi.mock('./runtime', () => ({
    currentProtocolDeployment: vi.fn(),
    protocolDeploymentCandidate: vi.fn(),
}));

const owner = '0x' + 'a'.repeat(40);
const other = '0x' + 'b'.repeat(40);

afterEach(() => {
    clearHomeBalanceVerification();
    vi.resetAllMocks();
});

describe('Home display verification started at unlock', () => {
    it('can only be claimed once, by the wallet that started it', () => {
        const candidate = Promise.resolve(undefined);
        const confirmation = new Promise<ProtocolDeployment>(() => {});
        vi.mocked(protocolDeploymentCandidate).mockReturnValue(candidate);
        vi.mocked(currentProtocolDeployment).mockReturnValue(confirmation);
        prepareHomeBalanceVerification(owner);
        prepareHomeBalanceVerification(owner);
        expect(currentProtocolDeployment).toHaveBeenCalledTimes(1);
        expect(claimHomeBalanceVerification(other)).toBeUndefined();
        expect(claimHomeBalanceVerification(owner)).toEqual({ candidate, confirmation });
        expect(claimHomeBalanceVerification(owner)).toBeUndefined();
    });

    it('drops a finished check so a later unlock gets fresh confirmation', async () => {
        vi.mocked(protocolDeploymentCandidate).mockResolvedValue(undefined);
        const check = Promise.reject(new Error('provider did not confirm'));
        vi.mocked(currentProtocolDeployment).mockReturnValue(check);
        prepareHomeBalanceVerification(owner);
        await expect(check).rejects.toThrow('provider did not confirm');
        expect(claimHomeBalanceVerification(owner)).toBeUndefined();
    });
});
