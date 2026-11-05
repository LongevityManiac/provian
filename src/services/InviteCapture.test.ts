import {describe, expect, it, vi} from 'vitest';
import {captureInviteForNewWallet} from './InviteCapture';

describe('agent link invitation capture', () => {
    const invite = {kind: 'agent' as const, inviteId: 'inv_abcdefgh', agentWalletId: 'wallet_aw_abcdefgh'};
    it('holds the destination until onboarding can open the consent screen', async () => {
        const stashPendingLinkAccept = vi.fn();
        expect(await captureInviteForNewWallet(invite, {stashPendingLinkAccept})).toBe(true);
        expect(stashPendingLinkAccept).toHaveBeenCalledWith({inviteId: invite.inviteId, agentWalletId: invite.agentWalletId});
    });
    it('can hold a carrier that finishes after onboarding', async () => {
        const stashPendingLinkAccept = vi.fn();
        expect(await captureInviteForNewWallet(invite, {stashPendingLinkAccept})).toBe(true);
        expect(stashPendingLinkAccept).toHaveBeenCalledWith({inviteId: invite.inviteId, agentWalletId: invite.agentWalletId});
    });
});
