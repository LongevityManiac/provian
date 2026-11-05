import { RiskLevel } from '../provenance/types';
import { translate } from '../../i18n/translate';

export interface PolicyResult {
    decision: 'allow' | 'override' | 'block';
    riskScore: number;
    riskCategory: RiskLevel;
    reasons: string[];
}

export interface TransactionContext {
    amount: number;
    asset: string;
    recipient: string;
    chainId: number | string;
    isContractInteraction: boolean;
    isLockdownActive: boolean;
}

class PolicyEngine {
    private static instance: PolicyEngine;

    private constructor() { }

    static getInstance(): PolicyEngine {
        if (!PolicyEngine.instance) {
            PolicyEngine.instance = new PolicyEngine();
        }
        return PolicyEngine.instance;
    }

    async evaluate(context: TransactionContext): Promise<PolicyResult> {
        const reasons: string[] = [];
        let riskScore = 0;

        // 0. Lockdown Check (Highest Priority)
        if (context.isLockdownActive) {
            return {
                decision: 'block',
                riskScore: 100,
                riskCategory: 'critical',
                reasons: [translate('policyEngine.lockdownActive', 'EMERGENCY LOCKDOWN ACTIVE. All outbound transactions blocked.')],
            };
        }

        // 1. Subscription Check (Removed)

        // 2. Null State Checks (Mocked)
        if (!context.asset) {
            return {
                decision: 'block',
                riskScore: 100,
                riskCategory: 'null_state',
                reasons: [translate('policyEngine.unknownAsset', 'Unknown asset (Null State).')],
            };
        }

        // 3. Risk Scoring
        if (context.amount > 1000) {
            riskScore += 50;
            reasons.push(translate('policyEngine.highValue', 'High value transaction.'));
        }

        if (context.isContractInteraction) {
            riskScore += 20;
            reasons.push(translate('policyEngine.contractInteraction', 'Contract interaction.'));
        }

        // 4. Determine Category
        let category: RiskLevel = 'low';
        if (riskScore > 80) category = 'critical';
        else if (riskScore > 50) category = 'high';
        else if (riskScore > 20) category = 'medium';

        // 5. Final Decision
        let decision: 'allow' | 'override' | 'block' = 'allow';
        if (category === 'critical') decision = 'block'; // Or override with extra auth
        if (category === 'high') decision = 'override';

        return {
            decision,
            riskScore,
            riskCategory: category,
            reasons,
        };
    }
}

export default PolicyEngine.getInstance();
