import { ProvenanceEnvelope, RiskLevel } from '../provenance/types';
import DrainerDetector, { DrainerRisk } from './DrainerDetector';
import TokenVerifier, { TokenImpersonationResult } from './TokenVerifier';
import SimulationEngine, { SimulationResult } from '../simulation/SimulationEngine';
import ApprovalManager from '../approvals/ApprovalManager';
import AddressHistoryService from '../protection/AddressHistoryService';
import { getChainById } from '../chains/evm/config';
import { KNOWN_SCAM_CONTRACTS, KNOWN_SCAM_DEPLOYERS } from '../../data/scam-contracts';
import { translate } from '../../i18n/translate';

export interface RiskInput {
    tx: {
        from: string;
        to: string;
        data: string;
        value: string;
        chainId: number;
        assetSymbol?: string;
        assetDecimals?: number;
    };
    simulationResult?: SimulationResult;
}

export interface RiskSignal {
    source: 'drainer' | 'impersonation' | 'simulation' | 'approval' | 'contract' | 'null_state' | 'reputation';
    riskLevel: RiskLevel;
    score: number; // 0-100
    details: string;
}

export interface AggregatedRisk {
    overallRisk: RiskLevel;
    score: number; // 0-100
    signals: RiskSignal[];
    recommendedFriction: number; // 1-5
    recommendedAction: 'allow' | 'require_confirmation' | 'block';
}

class RiskEngine {
    private static instance: RiskEngine;

    private constructor() { }

    static getInstance(): RiskEngine {
        if (!RiskEngine.instance) {
            RiskEngine.instance = new RiskEngine();
        }
        return RiskEngine.instance;
    }

    /**
     * Calculate comprehensive risk score for a transaction
     */
    async calculateRiskScore(input: RiskInput): Promise<AggregatedRisk> {
        const signals: RiskSignal[] = [];

        // 1. Drainer Detection
        const drainerResult = await DrainerDetector.detectDrainer(input.tx);
        if (drainerResult.isDrainer) {
            signals.push({
                source: 'drainer',
                riskLevel: drainerResult.riskLevel,
                score: drainerResult.confidence * 100,
                details: drainerResult.reasons.join(', ')
            });
        }

        // 2. Token Verification (if applicable)
        if (input.simulationResult?.stateChanges) {
            for (const change of input.simulationResult.stateChanges) {
                if (change.tokenAddress) {
                    const tokenRisk = await TokenVerifier.verifyToken({
                        address: change.tokenAddress,
                        symbol: change.asset,
                        decimals: input.tx.assetDecimals ?? 18,
                        chainId: input.tx.chainId,
                    });
                    if (tokenRisk.isImpersonator) {
                        signals.push({
                            source: 'impersonation',
                            riskLevel: tokenRisk.severity as RiskLevel,
                            score: 90, // Default score for impersonation
                            details: tokenRisk.reason
                        });
                    }
                }
            }
        }

        // 3. Simulation Risks
        if (input.simulationResult) {
            for (const factor of input.simulationResult.riskFactors) {
                signals.push({
                    source: 'simulation',
                    riskLevel: 'medium', // Default
                    score: 30, // Default score for a simulation risk factor
                    details: factor
                });
            }
        }
        // Note: previously injected a high-severity null_state signal here when
        // no simulation result was provided. That made every unsimulated tx
        // appear "high risk" and effectively blocked normal sends, which is why
        // RiskEngine sat orphaned. Until SimulationEngine is wired into the
        // send/swap pipeline, we treat missing simulation as informational.

        // 4. Recipient Reputation (New)
        const recipientRisk = await this.checkRecipientRisk(input.tx.to, input.tx.chainId);
        if (recipientRisk) {
            signals.push(recipientRisk);
        }

        // 5. Deep Approval Safety (New)
        if (input.tx.data.startsWith('0x095ea7b3')) { // approve
            // Check for max uint256
            if (input.tx.data.includes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')) {
                signals.push({
                    source: 'approval',
                    riskLevel: 'high',
                    score: 80, // High score for infinite approval
                    details: translate('riskEngine.infiniteApproval', 'Granting infinite approval to contract')
                });
            }
        }

        return this.aggregateSignals(signals);
    }

    private async checkRecipientRisk(address: string, chainId: number): Promise<RiskSignal | null> {
        const lower = address.toLowerCase();

        // Known address-poisoning / drainer / scam-pattern address - hard
        // block regardless of history or contract status. This list already
        // existed (src/data/scam-contracts.ts) but was previously only
        // consulted for token-approval targets, never for a plain send
        // recipient - so a listed address-poisoning address sailed through
        // an ordinary send unchecked. Checked first: a match here makes
        // every other signal moot.
        if (KNOWN_SCAM_CONTRACTS.has(lower) || KNOWN_SCAM_DEPLOYERS.has(lower)) {
            return {
                source: 'reputation',
                riskLevel: 'critical',
                score: 95,
                details: translate('riskEngine.knownScamAddress', 'This address matches a known scam / address-poisoning pattern reported by the security community. Do not send here - it is very likely to belong to an attacker, not your intended recipient.'),
            };
        }

        // Address-poisoning lookalike: an attacker crafts a vanity address
        // that shares the same visible prefix and suffix as an address this
        // wallet already trusts (a saved contact or a prior send), then
        // dusts the wallet so the lookalike shows up in activity. This is
        // exactly the pattern a truncated "0x1234...5678" display cannot
        // catch, so it is checked against the full stored address.
        const lookalike = await AddressHistoryService.findLookalikeMatch(address);
        if (lookalike) {
            const known = lookalike.name ? `"${lookalike.name}" (${lookalike.address})` : lookalike.address;
            return {
                source: 'reputation',
                riskLevel: 'critical',
                score: 92,
                details: translate('riskEngine.lookalikeAddress', `This address starts and ends the same as ${known}, an address you've used before - but the middle is different, so it is NOT the same address. This is the classic address-poisoning trick: verify the full address character-by-character, or send to the saved contact instead of a pasted address.`, { known }),
            };
        }

        const isNewRecipient = await AddressHistoryService.isFirstTimeSend(address);

        // Check if address is a contract via eth_getCode
        let isContract = true; // Default to true ("Unknown = Block")
        try {
            const chain = getChainById(chainId);
            if (chain) {
                const response = await fetch(chain.rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'eth_getCode',
                        params: [address, 'latest'],
                    }),
                });
                const data = await response.json();
                // EOA returns '0x', contract returns bytecode
                isContract = data.result && data.result !== '0x' && data.result !== '0x0';
            }
        } catch {
            // On error, default to isContract = true (conservative)
        }

        if (isNewRecipient && isContract) {
            return {
                source: 'reputation',
                riskLevel: 'medium',
                score: 40,
                details: translate('riskEngine.newContract', 'Interacting with a new contract'),
            };
        }

        if (isNewRecipient && !isContract) {
            return {
                source: 'reputation',
                riskLevel: 'low',
                score: 15,
                details: translate('riskEngine.firstTimeSend', 'First-time send to new address'),
            };
        }

        return null;
    }

    /**
     * Aggregate multiple risk signals into a final score and decision
     */
    aggregateSignals(signals: RiskSignal[]): AggregatedRisk {
        let maxScore = 0;
        let criticalCount = 0;
        let highCount = 0;

        for (const signal of signals) {
            maxScore = Math.max(maxScore, signal.score);
            if (signal.riskLevel === 'critical') criticalCount++;
            if (signal.riskLevel === 'high') highCount++;
        }

        // Determine Overall Risk Level
        let overallRisk: RiskLevel = 'low';
        if (criticalCount > 0 || maxScore >= 80) overallRisk = 'critical';
        else if (highCount > 0 || maxScore >= 50) overallRisk = 'high';
        else if (maxScore >= 20) overallRisk = 'medium';

        // Map to Friction & Action
        const frictionLevel = this.mapScoreToFrictionLevel(maxScore, overallRisk);
        let recommendedAction: AggregatedRisk['recommendedAction'] = 'allow';

        if (overallRisk === 'critical') recommendedAction = 'block';
        else if (overallRisk === 'high') recommendedAction = 'require_confirmation';
        else if (overallRisk === 'medium') recommendedAction = 'require_confirmation';

        return {
            overallRisk,
            score: maxScore,
            signals,
            recommendedFriction: frictionLevel,
            recommendedAction
        };
    }

    /**
     * Map numeric score to friction level (1-5)
     */
    mapScoreToFrictionLevel(score: number, level: RiskLevel): number {
        if (level === 'critical') return 5;
        if (level === 'high') return 4;
        if (score >= 40) return 3;
        if (score >= 20) return 2;
        return 1;
    }

    /**
     * Generate a summary for Provenance Envelopes
     */
    getRiskSummaryForProvenance(risk: AggregatedRisk): string {
        const topSignals = risk.signals
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map(s => `${s.source}: ${s.details}`);

        return `Risk: ${risk.overallRisk} (${risk.score}). ${topSignals.join(' | ')}`;
    }

    /**
     * Get UI-ready translation keys for risk summary
     */
    getRiskSummaryForUI(risk: AggregatedRisk): { titleKey: string; badge: RiskLevel; details: string[] } {
        const badge = risk.overallRisk;
        let titleKey = 'transaction_review.safety_check';

        if (badge === 'critical') titleKey = 'transaction_review.risk_badge.critical';
        else if (badge === 'high') titleKey = 'transaction_review.risk_badge.high';
        else if (badge === 'medium') titleKey = 'transaction_review.risk_badge.medium';
        else titleKey = 'transaction_review.risk_badge.low';

        // Map signals to i18n keys if possible, or pass details
        // Ideally, signals should return codes, but for now we wrap details
        const details = risk.signals.map(s => s.details);

        return { titleKey, badge, details };
    }
}

export default RiskEngine.getInstance();
