import { RiskLevel } from '../provenance/types';

export interface DrainerRisk {
    isDrainer: boolean;
    confidence: number; // 0-1
    riskLevel: RiskLevel;
    reasons: string[];
    block: boolean;
}

interface DrainerRule {
    id: string;
    check: (tx: any) => boolean;
    riskLevel: RiskLevel;
    reason: string;
    confidence: number;
}

class DrainerDetector {
    private static instance: DrainerDetector;
    private rules: DrainerRule[] = [];

    private constructor() {
        this.initializeRules();
    }

    static getInstance(): DrainerDetector {
        if (!DrainerDetector.instance) {
            DrainerDetector.instance = new DrainerDetector();
        }
        return DrainerDetector.instance;
    }

    private initializeRules() {
        // Rule 1: Infinite Approval (Permit2 or standard)
        this.rules.push({
            id: 'infinite_approval',
            check: (tx) => {
                // Mock check for infinite approval signature
                return tx.data && tx.data.includes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            },
            riskLevel: 'high',
            reason: 'Granting infinite approval',
            confidence: 0.9
        });

        // Rule 2: Dangerous method signatures in unsolicited contexts
        // These selectors have legitimate uses but are high-risk when unexpected
        this.rules.push({
            id: 'dangerous_method',
            check: (tx) => {
                const dangerousSelectors = [
                    '0xa22cb465', // setApprovalForAll(address,bool)
                    '0x42842e0e', // safeTransferFrom(address,address,uint256)
                    '0x23b872dd', // transferFrom(address,address,uint256)
                    '0x2eb2c2d6', // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
                    '0xd505accf', // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
                ];
                return dangerousSelectors.some((sig: string) => tx.data && tx.data.startsWith(sig));
            },
            riskLevel: 'high',
            reason: 'Dangerous method signature detected (approval/transfer)',
            confidence: 0.7
        });

        // Rule 3: Zero-value transfer with large data (Phishing)
        this.rules.push({
            id: 'phishing_transfer',
            check: (tx) => {
                return tx.value === '0' && tx.data && tx.data.length > 500;
            },
            riskLevel: 'medium',
            reason: 'Suspicious zero-value transfer with large payload',
            confidence: 0.6
        });
    }

    async detectDrainer(tx: {
        to: string;
        data: string;
        value: string;
        chainId: number;
    }): Promise<DrainerRisk> {
        const reasons: string[] = [];
        let maxRisk: RiskLevel = 'low';
        let maxConfidence = 0;
        let shouldBlock = false;

        for (const rule of this.rules) {
            if (rule.check(tx)) {
                reasons.push(rule.reason);
                maxConfidence = Math.max(maxConfidence, rule.confidence);

                if (rule.riskLevel === 'critical') {
                    maxRisk = 'critical';
                    shouldBlock = true;
                } else if (rule.riskLevel === 'high' && maxRisk !== 'critical') {
                    maxRisk = 'high';
                } else if (rule.riskLevel === 'medium' && maxRisk === 'low') {
                    maxRisk = 'medium';
                }
            }
        }

        return {
            isDrainer: reasons.length > 0,
            confidence: maxConfidence,
            riskLevel: maxRisk,
            reasons,
            block: shouldBlock
        };
    }
}

export default DrainerDetector.getInstance();
