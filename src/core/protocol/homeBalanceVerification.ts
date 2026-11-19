import type { ProtocolDeployment } from './pointer';
import { currentProtocolDeployment, protocolDeploymentCandidate } from './runtime';

export interface HomeBalanceVerification {
    readonly candidate: Promise<ProtocolDeployment | undefined>;
    readonly confirmation: Promise<ProtocolDeployment>;
}

let pending: { wallet: string; read: HomeBalanceVerification } | undefined;

/** Start the display-only check while the owner is unlocking. A completed
 * check cannot be claimed by a later launch or reused by signing. */
export function prepareHomeBalanceVerification(address: string): void {
    const wallet = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || pending?.wallet === wallet) return;
    const candidate = protocolDeploymentCandidate();
    const confirmation = currentProtocolDeployment();
    const entry = { wallet, read: { candidate, confirmation } };
    pending = entry;
    // Both promises may reject before the Home screen has mounted.
    void candidate.catch(() => {});
    const clear = () => { if (pending === entry) pending = undefined; };
    void confirmation.then(clear, clear);
}

export function claimHomeBalanceVerification(address: string): HomeBalanceVerification | undefined {
    if (pending?.wallet !== address.toLowerCase()) return undefined;
    const { read } = pending;
    pending = undefined;
    return read;
}

export function clearHomeBalanceVerification(): void {
    pending = undefined;
}
