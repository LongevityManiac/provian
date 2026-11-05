import type { BiometricAction } from '../security/biometricAction';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import { RiskLevel } from '../provenance/types';

export interface MessageAnalysisResult {
    isSafe: boolean;
    type: 'eip712' | 'personal_sign' | 'eth_sign' | 'unknown';
    riskLevel: RiskLevel;
    warnings: string[];
    summary: string;
    structuredData?: any;
}

class MessageSafetyEngine {
    private static instance: MessageSafetyEngine;

    private constructor() { }

    static getInstance(): MessageSafetyEngine {
        if (!MessageSafetyEngine.instance) {
            MessageSafetyEngine.instance = new MessageSafetyEngine();
        }
        return MessageSafetyEngine.instance;
    }

    /**
     * Analyze a message signature request
     */
    async analyzeMessage(params: {
        type: 'eth_signTypedData_v4' | 'personal_sign' | 'eth_sign';
        data: any;
        origin: string;
    }, biometricAction?: BiometricAction): Promise<MessageAnalysisResult> {
        const warnings: string[] = [];
        let riskLevel: RiskLevel = 'low';
        let msgType: MessageAnalysisResult['type'] = 'unknown';

        // 1. Analyze Type
        if (params.type === 'eth_signTypedData_v4') {
            msgType = 'eip712';
            this.analyzeEIP712(params.data, warnings);
        } else if (params.type === 'personal_sign') {
            msgType = 'personal_sign';
            if (this.isHex(params.data) && params.data.length > 64) {
                warnings.push('Signing opaque hex data (Blind Signing)');
                riskLevel = 'medium';
            }
        } else if (params.type === 'eth_sign') {
            msgType = 'eth_sign';
            warnings.push('Legacy eth_sign is dangerous and can sign transactions');
            riskLevel = 'critical';
        }

        // 2. Determine Risk
        if (warnings.some(w => w.includes('Permit'))) {
            riskLevel = 'high';
        }

        const result: MessageAnalysisResult = {
            isSafe: riskLevel === 'low',
            type: msgType,
            riskLevel,
            warnings,
            summary: warnings.length > 0 ? warnings[0] : 'Standard Message Signature',
            structuredData: params.data
        };

        // 3. Log PE
        await ProvenanceEnvelopeManager.createEnvelope({
            actionType: 'approve', // Using approve as proxy for signing
            intentText: `Sign Message: ${result.summary}`,
            assetSymbol: 'N/A',
            amount: '0',
            chainId: 0,
            riskScore: riskLevel === 'critical' ? 100 : riskLevel === 'high' ? 80 : 0,
            riskCategory: riskLevel,
            policyDecision: riskLevel === 'critical' ? 'block' : 'allow',
            originBinding: params.origin
        } as any, biometricAction);

        return result;
    }

    private analyzeEIP712(data: any, warnings: string[]) {
        try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;

            // Check for Permit
            if (parsed.primaryType === 'Permit' || parsed.types?.Permit) {
                warnings.push('Off-chain Permit Signature (Unlimited Approval Risk)');
            }

            // Check for missing ChainId
            if (!parsed.domain?.chainId) {
                warnings.push('Missing Chain ID in domain (Replay Attack Risk)');
            }

            // Check for verifying contract
            if (!parsed.domain?.verifyingContract) {
                warnings.push('Missing verifying contract (Phishing Risk)');
            }

        } catch (e) {
            warnings.push('Malformed EIP-712 Data');
        }
    }

    private isHex(str: string): boolean {
        return /^0x[0-9a-fA-F]*$/.test(str);
    }
}

export default MessageSafetyEngine.getInstance();
