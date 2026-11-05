/** A link invitation held until the person has a wallet and can consent. */
export type InviteRef = { kind: 'agent'; inviteId: string; agentWalletId: string };
export interface InviteCaptureDeps {
    stashPendingLinkAccept(target: { inviteId: string; agentWalletId: string }): void;
}
export async function captureInviteForNewWallet(invite: InviteRef, deps: InviteCaptureDeps): Promise<boolean> {
    deps.stashPendingLinkAccept({ inviteId: invite.inviteId, agentWalletId: invite.agentWalletId });
    return true;
}
