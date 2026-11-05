import type { BiometricAction } from '../security/biometricAction';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import RiskEngine from '../risk/RiskEngine';
import { RiskLevel } from '../provenance/types';

export interface TokenApproval {
    id: string;
    tokenName: string;
    tokenSymbol: string;
    tokenAddress: string;
    spenderAddress: string;
    spenderName: string;
    amount: string;
    isUnlimited: boolean;
    riskLevel: RiskLevel;
    lastUsed: number;
    chainId: number;
    ownerAddress: string;
}

export interface PreparedRevokeTx {
    to: string;
    data: string;
    chainId: number;
    description: string;
}

class ApprovalManager {
    private static instance: ApprovalManager;
    private approvalsIndex: Map<string, TokenApproval[]> = new Map(); // Key: chainId_ownerAddress

    private constructor() { }

    static getInstance(): ApprovalManager {
        if (!ApprovalManager.instance) {
            ApprovalManager.instance = new ApprovalManager();
        }
        return ApprovalManager.instance;
    }

    /**
     * Get approvals for a specific account
     */
    async getApprovalsForAccount(chainId: number, ownerAddress: string): Promise<TokenApproval[]> {
        const key = this.getIndexKey(chainId, ownerAddress);
        if (!this.approvalsIndex.has(key)) {
            await this.indexApprovals(chainId, ownerAddress);
        }
        return this.approvalsIndex.get(key) || [];
    }

    /**
     * Get only risky approvals (High/Critical)
     */
    async getRiskyApprovals(chainId: number, ownerAddress: string): Promise<TokenApproval[]> {
        const all = await this.getApprovalsForAccount(chainId, ownerAddress);
        return all.filter(a => a.riskLevel === 'high' || a.riskLevel === 'critical');
    }

    /**
     * Build a revocation transaction (Internal Stub)
     */
    async buildRevokeTransaction(approval: TokenApproval): Promise<PreparedRevokeTx> {
        // Mock ERC20 approve(spender, 0) data
        const data = `0x095ea7b3000000000000000000000000${approval.spenderAddress.replace('0x', '')}0000000000000000000000000000000000000000000000000000000000000000`;

        return {
            to: approval.tokenAddress,
            data,
            chainId: approval.chainId,
            description: `Revoke ${approval.tokenSymbol} approval for ${approval.spenderName}`
        };
    }

    /**
     * Execute revocation (creates PE + simulates tx)
     */
    async executeRevocation(approval: TokenApproval, biometricAction?: BiometricAction): Promise<boolean> {
        try {
            const tx = await this.buildRevokeTransaction(approval);

            // 1. Create Provenance Envelope
            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'REVOKE_APPROVAL',
                intentText: tx.description,
                assetSymbol: approval.tokenSymbol,
                amount: '0',
                chainId: approval.chainId,
                counterparty: approval.spenderAddress,
                contract: approval.tokenAddress,
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow'
            }, biometricAction);

            // 2. Update Local Index (Optimistic)
            this.removeApprovalFromIndex(approval);

            console.log(`Revoked approval: ${approval.id}`);
            return true;

        } catch (error) {
            console.error('Revocation failed:', error);
            return false;
        }
    }

    /**
     * Index ERC-20 approvals for an address on a chain.
     *
     * NOT YET IMPLEMENTED. The previous implementation hardcoded two fake
     * approvals (an "Unknown Contract" with critical risk that the user
     * never actually granted) and stored them in the index. That misled
     * users about their real on-chain security posture and could prompt
     * them to "revoke" approvals that don't exist.
     *
     * Real implementation would query historical Approval events from the
     * Alchemy/Etherscan indexer for the owner address, dedupe by
     * (token, spender), filter to approvals where the current allowance
     * is non-zero (via on-chain `allowance()` calls), and classify spender
     * risk against a known-contract registry.
     *
     * Until that's wired up the index is left empty so the UI shows
     * "no approvals found" - strictly more honest than fake data.
     */
    private async indexApprovals(chainId: number, ownerAddress: string): Promise<void> {
        console.warn('[ApprovalManager] indexApprovals is not yet implemented; returning empty list');
        this.approvalsIndex.set(this.getIndexKey(chainId, ownerAddress), []);
    }

    private removeApprovalFromIndex(approval: TokenApproval) {
        const key = this.getIndexKey(approval.chainId, approval.ownerAddress);
        const current = this.approvalsIndex.get(key) || [];
        this.approvalsIndex.set(key, current.filter(a => a.id !== approval.id));
    }

    private getIndexKey(chainId: number, owner: string): string {
        return `${chainId}_${owner.toLowerCase()}`;
    }
}

export default ApprovalManager.getInstance();
