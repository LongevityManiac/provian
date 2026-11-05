/**
 * finding #1 — import human-wallet registration ordering.
 *
 * The seed-import recovery path used to chain registration behind credential
 * recovery, so a failing recovery skipped registration and the first
 * POST /v1/human-promises/create 404'd until an app restart. registration must
 * now be attempted INDEPENDENTLY of the recovery outcome.
 *
 * RED control : revert registerRecoveredHumanWallet to the old chained
 * form —
 * await deps.recoverRelayCredentials(address);
 * await deps.ensureHumanWalletRegistered(address);
 * with the recover() call NOT wrapped in its own try/catch (so a rejection
 * propagates past the registration leg) — and the "recovery rejects" case below
 * goes red (ensureHumanWalletRegistered is never called). Observed red on
 * 2026-09-11, then restored.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerRecoveredHumanWallet } from '../registerRecoveredWallet';

const ADDR = '0xAbCd000000000000000000000000000000000001';

describe('registerRecoveredHumanWallet — decoupled recovery + registration', () => {
    it('attempts registration even when recoverRelayCredentials REJECTS (finding #1)', async () => {
        const recoverRelayCredentials = vi.fn(async () => {
            throw new Error('recovery throttled');
        });
        const ensureHumanWalletRegistered = vi.fn(async () => {});

        await registerRecoveredHumanWallet(ADDR, {
            recoverRelayCredentials,
            ensureHumanWalletRegistered,
        });

        expect(recoverRelayCredentials).toHaveBeenCalledTimes(1);
        // The core regression guard: a failed recovery MUST NOT skip registration.
        expect(ensureHumanWalletRegistered).toHaveBeenCalledTimes(1);
        // round-robin fairness:...but WITHOUT permission to sign an address proof.
        expect(ensureHumanWalletRegistered).toHaveBeenCalledWith(ADDR, { allowAddressProof: false });
    });

    it('RED (defect 3): a TRANSIENT recovery failure (503 / 429) forbids the address proof - old code registered with proof allowed', async () => {
        for (const status of ['503 Service Unavailable', '429 Too Many Requests']) {
            const ensureHumanWalletRegistered = vi.fn(async (_a: string, _o: { allowAddressProof: boolean }) => {});
            await registerRecoveredHumanWallet(ADDR, {
                recoverRelayCredentials: vi.fn(async () => { throw new Error(status); }),
                ensureHumanWalletRegistered,
            });
            expect(ensureHumanWalletRegistered).toHaveBeenCalledTimes(1);
            expect(ensureHumanWalletRegistered.mock.calls[0][1]).toEqual({ allowAddressProof: false });
        }
    });

    it('a DEFINITIVE recovery (resolved) lets registration carry the proof', async () => {
        const ensureHumanWalletRegistered = vi.fn(async (_a: string, _o: { allowAddressProof: boolean }) => {});
        await registerRecoveredHumanWallet(ADDR, {
            recoverRelayCredentials: vi.fn(async () => ({ recovered: false })),
            ensureHumanWalletRegistered,
        });
        expect(ensureHumanWalletRegistered).toHaveBeenCalledWith(ADDR, { allowAddressProof: true });
    });

    it('runs both legs, recovery BEFORE registration, when recovery resolves', async () => {
        const order: string[] = [];
        const recoverRelayCredentials = vi.fn(async () => {
            order.push('recover');
        });
        const ensureHumanWalletRegistered = vi.fn(async () => {
            order.push('register');
        });

        await registerRecoveredHumanWallet(ADDR, {
            recoverRelayCredentials,
            ensureHumanWalletRegistered,
        });

        expect(order).toEqual(['recover', 'register']);
    });

    it('never throws even when BOTH legs reject (fire-and-forget, non-blocking)', async () => {
        const recoverRelayCredentials = vi.fn(async () => {
            throw new Error('recover failed');
        });
        const ensureHumanWalletRegistered = vi.fn(async () => {
            throw new Error('register failed');
        });

        await expect(
            registerRecoveredHumanWallet(ADDR, {
                recoverRelayCredentials,
                ensureHumanWalletRegistered,
            }),
        ).resolves.toBeUndefined();
        expect(ensureHumanWalletRegistered).toHaveBeenCalledTimes(1);
    });
});

describe('registerRecoveredHumanWallet — the Solana address proof leg', () => {
    it('runs AFTER both legs, even when both fail, and its failure never propagates', async () => {
        const order: string[] = [];
        const proveSolanaAddress = vi.fn(async () => { order.push('solana'); throw new Error('relay down'); });
        await expect(registerRecoveredHumanWallet(ADDR, {
            recoverRelayCredentials: vi.fn(async () => { order.push('recover'); throw new Error('throttled'); }),
            ensureHumanWalletRegistered: vi.fn(async () => { order.push('register'); throw new Error('network'); }),
            proveSolanaAddress,
        })).resolves.toBeUndefined();
        expect(order).toEqual(['recover', 'register', 'solana']);
        expect(proveSolanaAddress).toHaveBeenCalledTimes(1);
    });

    it('is optional: a caller without it runs exactly the two legs', async () => {
        const ensureHumanWalletRegistered = vi.fn(async () => {});
        await registerRecoveredHumanWallet(ADDR, { recoverRelayCredentials: vi.fn(async () => {}), ensureHumanWalletRegistered });
        expect(ensureHumanWalletRegistered).toHaveBeenCalledTimes(1);
    });
});
