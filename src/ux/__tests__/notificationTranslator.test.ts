import { describe, it, expect } from 'vitest';
import {
    classifyTier,
    riskAssessmentToNotification,
    type RiskAssessment,
} from '../notificationTranslator';
import { assertJargonFree } from '../jargonBlocklist';

// =============================================================================
// BASE ASSESSMENT FACTORY
// =============================================================================

function makeAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
    return {
        anomalyScore: 0,
        reclassified: false,
        temporalAnomalyFired: false,
        isNewEndpoint: false,
        actionType: 'browse',
        dataCategories: [],
        ...overrides,
    };
}

// =============================================================================
// TIER CLASSIFICATION
// =============================================================================

describe('classifyTier', () => {
    describe('Tier 1 - routine', () => {
        it('classifies new endpoint with low anomaly as tier 1', () => {
            const tier = classifyTier(makeAssessment({
                isNewEndpoint: true,
                anomalyScore: 20,
            }));
            expect(tier).toBe(1);
        });

        it('classifies zero-risk as tier 1', () => {
            const tier = classifyTier(makeAssessment({ anomalyScore: 0 }));
            expect(tier).toBe(1);
        });

        it('classifies anomaly score 39 as tier 1', () => {
            const tier = classifyTier(makeAssessment({
                anomalyScore: 39,
                isNewEndpoint: true,
            }));
            expect(tier).toBe(1);
        });
    });

    describe('Tier 2 - suspicious', () => {
        it('classifies anomaly score 40 as tier 2', () => {
            const tier = classifyTier(makeAssessment({ anomalyScore: 40 }));
            expect(tier).toBe(2);
        });

        it('classifies anomaly score 84 as tier 2', () => {
            const tier = classifyTier(makeAssessment({ anomalyScore: 84 }));
            expect(tier).toBe(2);
        });

        it('classifies reclassification alone as tier 2', () => {
            const tier = classifyTier(makeAssessment({ reclassified: true }));
            expect(tier).toBe(2);
        });

        it('classifies temporal anomaly alone as tier 2', () => {
            const tier = classifyTier(makeAssessment({ temporalAnomalyFired: true }));
            expect(tier).toBe(2);
        });

        it('classifies reclassification + low anomaly as tier 2', () => {
            const tier = classifyTier(makeAssessment({
                reclassified: true,
                anomalyScore: 30,
            }));
            expect(tier).toBe(2);
        });
    });

    describe('Tier 3 - serious', () => {
        it('classifies anomaly score 85 as tier 3', () => {
            const tier = classifyTier(makeAssessment({ anomalyScore: 85 }));
            expect(tier).toBe(3);
        });

        it('classifies anomaly score 100 as tier 3', () => {
            const tier = classifyTier(makeAssessment({ anomalyScore: 100 }));
            expect(tier).toBe(3);
        });

        it('classifies temporal + reclassified + anomaly > 60 as tier 3', () => {
            const tier = classifyTier(makeAssessment({
                temporalAnomalyFired: true,
                reclassified: true,
                anomalyScore: 65,
            }));
            expect(tier).toBe(3);
        });

        it('does NOT classify temporal + reclassified + anomaly <= 60 as tier 3', () => {
            const tier = classifyTier(makeAssessment({
                temporalAnomalyFired: true,
                reclassified: true,
                anomalyScore: 55,
            }));
            // anomaly 55 >= 40, so tier 2
            expect(tier).toBe(2);
        });
    });
});

// =============================================================================
// FULL NOTIFICATION GENERATION
// =============================================================================

describe('riskAssessmentToNotification', () => {
    it('generates tier 1 notification without auto-pause', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            isNewEndpoint: true,
            anomalyScore: 15,
            endpoint: 'https://api.notion.com',
            actionType: 'browse',
        }));

        expect(notification.tier).toBe(1);
        expect(notification.autoPaused).toBe(false);
    });

    it('generates tier 2 notification without auto-pause', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            anomalyScore: 55,
            actionType: 'share_data',
            dataCategories: ['geolocation'],
            endpoint: 'https://suspicious-site.com',
        }));

        expect(notification.tier).toBe(2);
        expect(notification.autoPaused).toBe(false);
    });

    it('generates tier 3 notification with auto-pause', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            anomalyScore: 90,
            actionType: 'egress_data',
            dataCategories: ['credentials', 'file_contents'],
            endpoint: 'https://evil.com',
        }));

        expect(notification.tier).toBe(3);
        expect(notification.autoPaused).toBe(true);
    });

    it('carries no approval action buttons (the wallet no longer approves agent actions)', () => {
        const notification = riskAssessmentToNotification(makeAssessment({ anomalyScore: 15 }));
        expect(notification).not.toHaveProperty('buttons');
    });

    it('produces jargon-free headline and body for tier 1', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            isNewEndpoint: true,
            anomalyScore: 10,
            endpoint: 'https://api.weather.gov',
            actionType: 'browse',
        }));
        assertJargonFree(notification.headline, 'tier1 headline');
        assertJargonFree(notification.body, 'tier1 body');
    });

    it('produces jargon-free copy for reclassification', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            reclassified: true,
            originalActionType: 'communicate',
            reclassifiedActionType: 'system_access',
            reclassificationReason: 'shell_command_pattern',
            anomalyScore: 45,
        }));
        assertJargonFree(notification.headline, 'reclassify headline');
        assertJargonFree(notification.body, 'reclassify body');
        expect(notification.body).toContain('send a message');
        expect(notification.body).toContain('run a command');
    });

    it('produces jargon-free copy for temporal + exfil (tier 3)', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            anomalyScore: 90,
            temporalAnomalyFired: true,
            reclassified: true,
            dataCategories: ['credentials'],
            actionType: 'egress_data',
            intentContext: {
                externalInputsUsed: ['web:phishing-site.com'],
                reasoningSummary: 'User asked to check email',
            },
        }));
        assertJargonFree(notification.headline, 'tier3 headline');
        assertJargonFree(notification.body, 'tier3 body');
        expect(notification.autoPaused).toBe(true);
    });

    it('produces jargon-free details expander', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            anomalyScore: 70,
            isNewEndpoint: true,
            temporalAnomalyFired: true,
            reclassified: true,
            originalActionType: 'browse',
            reclassifiedActionType: 'share_data',
            reclassificationReason: 'sensitive_data_detected',
            dataCategories: ['medical'],
            endpoint: 'https://unknown-api.com',
            intentContext: {
                reasoningSummary: 'Looking up health info',
                externalInputsUsed: ['web:health-blog.com'],
            },
        }));
        expect(notification.details).toBeTruthy();
        assertJargonFree(notification.details!, 'details expander');
    });

    it('handles financial action assessment', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            actionType: 'financial',
            amount: 150.00,
            currency: 'USD',
            merchant: 'Best Buy',
            isNewEndpoint: true,
            anomalyScore: 15,
        }));
        assertJargonFree(notification.headline, 'financial headline');
        assertJargonFree(notification.body, 'financial body');
        expect(notification.headline).toContain('Best Buy');
    });

    it('handles environment drift assessment', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            environmentDriftFields: ['system_prompt_hash'],
            anomalyScore: 10,
        }));
        assertJargonFree(notification.headline, 'drift headline');
        assertJargonFree(notification.body, 'drift body');
        expect(notification.body).toContain('instructions');
    });

    it('handles plugin install assessment', () => {
        const notification = riskAssessmentToNotification(makeAssessment({
            pluginName: 'PDF Analyzer',
            anomalyScore: 5,
        }));
        assertJargonFree(notification.headline, 'plugin headline');
        assertJargonFree(notification.body, 'plugin body');
        expect(notification.headline).toContain('PDF Analyzer');
    });
});
