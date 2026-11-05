import { describe, it, expect } from 'vitest';
import {
    translateDataCategories,
    translateActionType,
    friendlyDomain,
    friendlySource,
    generateCopy,
    generateDetailsExpander,
    copyNewEndpointRoutine,
    copyDataExfiltration,
    copyReclassification,
    copyTemporalExfiltration,
    copyTemporalAnomaly,
    copyEnvironmentDrift,
    copyNewPlugin,
    copyFinancialAction,
    copyCredentialAccess,
    copyUnusualBehavior,
    copyCommunicate,
    copyCommitment,
    type CopyContext,
} from '../copyTemplates';
import { assertJargonFree } from '../jargonBlocklist';

// =============================================================================
// HELPER TO CHECK ALL COPY IS JARGON-FREE
// =============================================================================

function assertCopyJargonFree(result: { headline: string; body: string }, context: string) {
    assertJargonFree(result.headline, `${context} headline`);
    assertJargonFree(result.body, `${context} body`);
}

// =============================================================================
// DATA CATEGORY TRANSLATIONS
// =============================================================================

describe('translateDataCategories', () => {
    it('translates single category', () => {
        expect(translateDataCategories(['geolocation'])).toBe('your location');
    });

    it('translates two categories with "and"', () => {
        expect(translateDataCategories(['credentials', 'contacts'])).toBe(
            'your passwords and your contacts'
        );
    });

    it('translates three categories with Oxford comma', () => {
        const result = translateDataCategories(['search_history', 'geolocation', 'credentials']);
        expect(result).toBe('your search history, your location, and your passwords');
    });

    it('returns "your information" for empty list', () => {
        expect(translateDataCategories([])).toBe('your information');
    });

    it('deduplicates equivalent categories', () => {
        const result = translateDataCategories(['geolocation', 'location']);
        expect(result).toBe('your location');
    });

    it('falls back gracefully for unknown categories', () => {
        const result = translateDataCategories(['unknown_category']);
        expect(result).toBe('unknown category');
    });
});

describe('translateActionType', () => {
    it('translates system_access', () => {
        expect(translateActionType('system_access')).toBe('run a command on your computer');
    });

    it('translates communicate', () => {
        expect(translateActionType('communicate')).toBe('send a message');
    });

    it('translates financial', () => {
        expect(translateActionType('financial')).toBe('make a payment');
    });

    it('falls back for unknown types', () => {
        expect(translateActionType('some_new_type')).toBe('some new type');
    });
});

describe('friendlyDomain', () => {
    it('extracts domain from full URL', () => {
        expect(friendlyDomain('https://api.notion.com/v1/pages')).toBe('notion.com');
    });

    it('strips www prefix', () => {
        expect(friendlyDomain('https://www.google.com/search')).toBe('google.com');
    });

    it('strips api prefix', () => {
        expect(friendlyDomain('https://api.github.com/repos')).toBe('github.com');
    });

    it('handles bare domain', () => {
        expect(friendlyDomain('notion.so')).toBe('notion.so');
    });

    it('handles invalid strings gracefully', () => {
        expect(friendlyDomain('not-a-url')).toBe('not-a-url');
    });
});

describe('friendlySource', () => {
    it('translates web source', () => {
        expect(friendlySource('web:tripadvisor.com')).toBe('a page on tripadvisor.com');
    });

    it('translates email source', () => {
        expect(friendlySource('email:inbox')).toBe('an email');
    });

    it('translates file source', () => {
        expect(friendlySource('file:readme.md')).toBe('a file');
    });

    it('translates api source', () => {
        expect(friendlySource('api:stripe.com')).toBe('a response from stripe.com');
    });

    it('falls back for unknown format', () => {
        expect(friendlySource('something-else')).toBe('outside content');
    });
});

// =============================================================================
// INDIVIDUAL COPY TEMPLATES - ALL MUST BE JARGON-FREE
// =============================================================================

const baseCopyCtx: CopyContext = {
    actionType: 'browse',
    endpoint: 'https://api.example.com/data',
    dataCategories: [],
    isNewEndpoint: false,
    reclassified: false,
    temporalAnomalyFired: false,
};

describe('copyNewEndpointRoutine', () => {
    it('generates jargon-free copy', () => {
        const result = copyNewEndpointRoutine({ ...baseCopyCtx, isNewEndpoint: true });
        assertCopyJargonFree(result, 'newEndpointRoutine');
    });

    it('includes the domain name', () => {
        const result = copyNewEndpointRoutine({
            ...baseCopyCtx,
            endpoint: 'https://api.notion.com/v1/pages',
        });
        expect(result.headline).toContain('notion.com');
    });
});

describe('copyDataExfiltration', () => {
    it('generates jargon-free copy', () => {
        const result = copyDataExfiltration({
            ...baseCopyCtx,
            dataCategories: ['geolocation', 'contacts'],
        });
        assertCopyJargonFree(result, 'dataExfiltration');
    });

    it('mentions the data types in plain language', () => {
        const result = copyDataExfiltration({
            ...baseCopyCtx,
            dataCategories: ['credentials'],
        });
        expect(result.headline).toContain('your passwords');
    });
});

describe('copyReclassification', () => {
    it('generates jargon-free copy', () => {
        const result = copyReclassification({
            ...baseCopyCtx,
            reclassified: true,
            originalActionType: 'communicate',
            reclassifiedActionType: 'system_access',
        });
        assertCopyJargonFree(result, 'reclassification');
    });

    it('explains the mismatch in plain English', () => {
        const result = copyReclassification({
            ...baseCopyCtx,
            reclassified: true,
            originalActionType: 'communicate',
            reclassifiedActionType: 'system_access',
        });
        expect(result.body).toContain('send a message');
        expect(result.body).toContain('run a command on your computer');
    });
});

describe('copyTemporalExfiltration', () => {
    it('generates jargon-free copy', () => {
        const result = copyTemporalExfiltration({
            ...baseCopyCtx,
            temporalAnomalyFired: true,
            externalSources: ['web:malicious-site.com'],
            dataCategories: ['credentials'],
        });
        assertCopyJargonFree(result, 'temporalExfiltration');
    });

    it('mentions the sequence: read → act', () => {
        const result = copyTemporalExfiltration({
            ...baseCopyCtx,
            temporalAnomalyFired: true,
            externalSources: ['web:evil.com'],
            dataCategories: ['file_contents'],
            actionType: 'egress_data',
        });
        expect(result.body).toContain('Right after reading');
        expect(result.body).toContain('evil.com');
    });

    it('says bot may have been tricked', () => {
        const result = copyTemporalExfiltration({
            ...baseCopyCtx,
            temporalAnomalyFired: true,
            dataCategories: ['search_history'],
        });
        expect(result.headline).toContain('tricked');
    });
});

describe('copyTemporalAnomaly', () => {
    it('generates jargon-free copy', () => {
        const result = copyTemporalAnomaly({
            ...baseCopyCtx,
            temporalAnomalyFired: true,
            externalSources: ['email:inbox'],
        });
        assertCopyJargonFree(result, 'temporalAnomaly');
    });
});

describe('copyEnvironmentDrift', () => {
    it('generates jargon-free copy for prompt change', () => {
        const result = copyEnvironmentDrift({
            ...baseCopyCtx,
            environmentDriftFields: ['system_prompt_hash'],
        });
        assertCopyJargonFree(result, 'envDrift-prompt');
        expect(result.body).toContain('instructions');
    });

    it('generates jargon-free copy for skills change', () => {
        const result = copyEnvironmentDrift({
            ...baseCopyCtx,
            environmentDriftFields: ['skills_hash'],
        });
        assertCopyJargonFree(result, 'envDrift-skills');
        expect(result.body).toContain('tools');
    });

    it('generates jargon-free copy for config change', () => {
        const result = copyEnvironmentDrift({
            ...baseCopyCtx,
            environmentDriftFields: ['config_hash'],
        });
        assertCopyJargonFree(result, 'envDrift-config');
        expect(result.body).toContain('settings');
    });
});

describe('copyNewPlugin', () => {
    it('generates jargon-free copy', () => {
        const result = copyNewPlugin({ ...baseCopyCtx, pluginName: 'Web Scraper Pro' });
        assertCopyJargonFree(result, 'newPlugin');
        expect(result.headline).toContain('Web Scraper Pro');
    });
});

describe('copyFinancialAction', () => {
    it('generates jargon-free copy', () => {
        const result = copyFinancialAction({
            ...baseCopyCtx,
            actionType: 'financial',
            amount: 49.99,
            currency: 'USD',
            merchant: 'Amazon',
        });
        assertCopyJargonFree(result, 'financial');
        expect(result.headline).toContain('Amazon');
        expect(result.body).toContain('49.99');
    });
});

describe('copyCredentialAccess', () => {
    it('generates jargon-free copy', () => {
        const result = copyCredentialAccess({ ...baseCopyCtx });
        assertCopyJargonFree(result, 'credentialAccess');
        expect(result.headline).toContain('passwords');
    });
});

describe('copyUnusualBehavior', () => {
    it('generates jargon-free copy', () => {
        const result = copyUnusualBehavior({ ...baseCopyCtx });
        assertCopyJargonFree(result, 'unusualBehavior');
    });
});

describe('copyCommunicate', () => {
    it('generates jargon-free copy', () => {
        const result = copyCommunicate({ ...baseCopyCtx, actionType: 'communicate' });
        assertCopyJargonFree(result, 'communicate');
        expect(result.headline).toContain('message');
    });
});

describe('copyCommitment', () => {
    it('generates jargon-free copy', () => {
        const result = copyCommitment({ ...baseCopyCtx, actionType: 'commit' });
        assertCopyJargonFree(result, 'commitment');
        expect(result.headline).toContain('agree');
    });
});

// =============================================================================
// generateCopy - TEMPLATE SELECTION
// =============================================================================

describe('generateCopy', () => {
    it('selects temporal exfiltration for tier 3 combo', () => {
        const result = generateCopy(
            {
                ...baseCopyCtx,
                temporalAnomalyFired: true,
                dataCategories: ['credentials'],
            },
            3
        );
        assertCopyJargonFree(result, 'generateCopy-t3-temporal');
        expect(result.headline).toContain('tricked');
    });

    it('selects reclassification template when reclassified', () => {
        const result = generateCopy(
            {
                ...baseCopyCtx,
                reclassified: true,
                originalActionType: 'communicate',
                reclassifiedActionType: 'system_access',
            },
            2
        );
        assertCopyJargonFree(result, 'generateCopy-reclassified');
        expect(result.body).toContain('send a message');
    });

    it('selects new endpoint routine for tier 1', () => {
        const result = generateCopy(
            { ...baseCopyCtx, isNewEndpoint: true },
            1
        );
        assertCopyJargonFree(result, 'generateCopy-t1-newEndpoint');
    });

    it('selects financial template for payment actions', () => {
        const result = generateCopy(
            {
                ...baseCopyCtx,
                actionType: 'financial',
                amount: 25.00,
                currency: 'USD',
                merchant: 'Amazon',
            },
            1
        );
        assertCopyJargonFree(result, 'generateCopy-financial');
        expect(result.headline).toContain('Amazon');
    });

    it('produces a valid fallback for unknown context', () => {
        const result = generateCopy(baseCopyCtx, 1);
        assertCopyJargonFree(result, 'generateCopy-fallback');
        expect(result.headline).toBeTruthy();
        expect(result.body).toBeTruthy();
    });
});

// =============================================================================
// generateDetailsExpander
// =============================================================================

describe('generateDetailsExpander', () => {
    it('generates jargon-free details', () => {
        const result = generateDetailsExpander({
            ...baseCopyCtx,
            anomalyScore: 70,
            isNewEndpoint: true,
            reclassified: true,
            originalActionType: 'communicate',
            reclassifiedActionType: 'system_access',
            reclassificationReason: 'shell_command_detected',
            temporalAnomalyFired: true,
            externalSources: ['web:evil.com'],
            dataCategories: ['credentials'],
            intentReasoning: 'User asked me to check email',
        });
        assertJargonFree(result, 'detailsExpander');
    });

    it('mentions new endpoint when applicable', () => {
        const result = generateDetailsExpander({
            ...baseCopyCtx,
            anomalyScore: 30,
            isNewEndpoint: true,
        });
        expect(result).toContain('never connected to');
    });

    it('includes intent reasoning in quotes', () => {
        const result = generateDetailsExpander({
            ...baseCopyCtx,
            anomalyScore: 30,
            intentReasoning: 'User asked me to book a flight',
        });
        expect(result).toContain('User asked me to book a flight');
    });

    it('includes safety language for high scores', () => {
        const result = generateDetailsExpander({
            ...baseCopyCtx,
            anomalyScore: 75,
        });
        expect(result).toContain('safety checks');
    });

    it('has a fallback for empty context', () => {
        const result = generateDetailsExpander({
            ...baseCopyCtx,
            anomalyScore: 10,
        });
        expect(result).toContain('routine safety checks');
    });
});
