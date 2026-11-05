/**
 * Copy Templates - Plain-English Notification Copy for Provian UX
 *
 * Every template function produces copy that a non-technical user can
 * understand at a glance. NEVER use terms from the jargon blocklist.
 *
 * Rules:
 * - Use "your bot" (not "agent", "model", "AI system")
 * - Translate technical data categories to everyday language
 * - Explain *what happened* and *why it matters*, not *how the engine works*
 * - Tier 1: casual, reassuring. Tier 2: concerned, direct. Tier 3: warning, protective.
 */

// =============================================================================
// DATA CATEGORY TRANSLATIONS
// =============================================================================

/** Maps internal data category keys to plain-English labels */
const DATA_CATEGORY_LABELS: Record<string, string> = {
    search_history: 'your search history',
    geolocation: 'your location',
    location: 'your location',
    credentials: 'your passwords',
    password: 'your passwords',
    file_contents: 'files from your computer',
    files: 'files from your computer',
    contact_info: 'your contacts',
    contacts: 'your contacts',
    browsing_history: 'your browsing history',
    browsing: 'your browsing history',
    financial: 'your financial information',
    financial_data: 'your financial information',
    medical: 'your medical records',
    medical_data: 'your medical records',
    identity: 'your personal identity info',
    identity_data: 'your personal identity info',
    email: 'your emails',
    email_contents: 'your emails',
    messages: 'your messages',
    photos: 'your photos',
    calendar: 'your calendar',
    documents: 'your documents',
    business_data: 'business information',
    api_keys: 'your account keys',
    tokens: 'your account access',
    cookies: 'your saved logins',
    clipboard: 'your clipboard contents',
};

/** Maps internal action type keys to plain-English descriptions */
const ACTION_TYPE_LABELS: Record<string, string> = {
    system_access: 'run a command on your computer',
    agent_system_access: 'run a command on your computer',
    communicate: 'send a message',
    agent_communicate: 'send a message',
    financial: 'make a payment',
    approval_only: 'make a payment',
    browse: 'visit a website',
    data_export: 'send your information somewhere',
    share_data: 'share your information',
    agent_share_data: 'share your information',
    commit: 'agree to something on your behalf',
    agent_commit: 'agree to something on your behalf',
    public_post: 'post publicly',
    agent_public_post: 'post publicly',
    uncategorized: 'do something',
    agent_uncategorized: 'do something',
    egress_data: 'send data to an outside service',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Translate a list of internal data categories to plain English.
 * Deduplicates and joins with commas + "and".
 */
export function translateDataCategories(categories: string[]): string {
    if (categories.length === 0) return 'your information';

    const translated = new Set<string>();
    for (const cat of categories) {
        translated.add(DATA_CATEGORY_LABELS[cat] ?? cat.replace(/_/g, ' '));
    }

    const items = Array.from(translated);
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Translate an internal action type to a plain-English verb phrase.
 */
export function translateActionType(actionType: string): string {
    return ACTION_TYPE_LABELS[actionType] ?? actionType.replace(/_/g, ' ');
}

/**
 * Extract a human-readable domain label from a URL or domain string.
 * "https://api.notion.com/v1/pages" → "notion.com"
 */
export function friendlyDomain(endpoint: string): string {
    try {
        // Handle both full URLs and bare domains
        const url = endpoint.startsWith('http')
            ? new URL(endpoint)
            : new URL(`https://${endpoint}`);

        let host = url.hostname;
        // Strip common API prefixes
        host = host.replace(/^(api|www|v\d+)\./, '');
        return host;
    } catch {
        // If URL parsing fails, return the endpoint trimmed
        return endpoint.split('/')[0] || endpoint;
    }
}

/**
 * Extract a human-readable source label from an external input string.
 * "web:tripadvisor.com" → "a TripAdvisor page"
 * "email:inbox" → "an email"
 */
export function friendlySource(source: string): string {
    if (source.startsWith('web:')) {
        const domain = source.slice(4);
        return `a page on ${friendlyDomain(domain)}`;
    }
    if (source.startsWith('email:')) {
        return 'an email';
    }
    if (source.startsWith('file:')) {
        return 'a file';
    }
    if (source.startsWith('api:')) {
        return `a response from ${friendlyDomain(source.slice(4))}`;
    }
    return 'outside content';
}

// =============================================================================
// COPY TEMPLATE CONTEXT
// =============================================================================

/** Minimal context needed to generate copy - subset of RiskAssessment */
export interface CopyContext {
    actionType: string;
    endpoint?: string;
    dataCategories: string[];
    isNewEndpoint: boolean;
    reclassified: boolean;
    originalActionType?: string;
    reclassifiedActionType?: string;
    temporalAnomalyFired: boolean;
    externalSources?: string[];
    intentReasoning?: string;
    environmentDriftFields?: string[];
    pluginName?: string;
    amount?: number;
    currency?: string;
    merchant?: string;
}

// =============================================================================
// COPY TEMPLATE FUNCTIONS
// =============================================================================

/**
 * Template 1: New endpoint, routine check.
 * "Your bot wants to use a site it hasn't used before."
 */
export function copyNewEndpointRoutine(ctx: CopyContext): { headline: string; body: string } {
    const domain = ctx.endpoint ? friendlyDomain(ctx.endpoint) : 'a new site';
    return {
        headline: `Your bot wants to use ${domain}`,
        body: `This is the first time your bot has tried to reach ${domain}. It wants to ${translateActionType(ctx.actionType)}. Would you like to allow it?`,
    };
}

/**
 * Template 2: Data exfiltration attempt - bot trying to send sensitive data.
 * Tier 2-3 depending on severity.
 */
export function copyDataExfiltration(ctx: CopyContext): { headline: string; body: string } {
    const dataLabel = translateDataCategories(ctx.dataCategories);
    const domain = ctx.endpoint ? friendlyDomain(ctx.endpoint) : 'an outside service';
    return {
        headline: `Your bot wants to send ${dataLabel}`,
        body: `Your bot is trying to send ${dataLabel} to ${domain}. Make sure you asked it to do this.`,
    };
}

/**
 * Template 3: Reclassification - bot says one thing, doing another.
 */
export function copyReclassification(ctx: CopyContext): { headline: string; body: string } {
    const original = translateActionType(ctx.originalActionType ?? ctx.actionType);
    const actual = translateActionType(ctx.reclassifiedActionType ?? ctx.actionType);
    return {
        headline: 'Something doesn\'t add up',
        body: `Your bot says it wants to ${original}, but it looks like it's actually trying to ${actual}. This is unusual - review carefully before allowing it.`,
    };
}

/**
 * Template 4: Temporal + exfiltration combo - the most suspicious pattern.
 * Bot reads external content then immediately tries to send data out.
 */
export function copyTemporalExfiltration(ctx: CopyContext): { headline: string; body: string } {
    const sources = ctx.externalSources ?? [];
    const sourceLabel = sources.length > 0
        ? friendlySource(sources[0])
        : 'outside content';
    const action = translateActionType(ctx.actionType);
    const dataLabel = ctx.dataCategories.length > 0
        ? translateDataCategories(ctx.dataCategories)
        : 'your information';

    return {
        headline: 'Your bot may have been tricked',
        body: `Right after reading ${sourceLabel}, your bot tried to ${action} and send ${dataLabel}. This pattern can mean the bot was manipulated by something it read. We've paused it to keep you safe.`,
    };
}

/**
 * Template 5: Temporal anomaly without data exfil - suspicious sequence.
 */
export function copyTemporalAnomaly(ctx: CopyContext): { headline: string; body: string } {
    const sources = ctx.externalSources ?? [];
    const sourceLabel = sources.length > 0
        ? friendlySource(sources[0])
        : 'outside content';
    const action = translateActionType(ctx.actionType);

    return {
        headline: 'Unusual timing detected',
        body: `Right after reading ${sourceLabel}, your bot tried to ${action}. This is unusual - your bot normally doesn't act this quickly after reading outside content.`,
    };
}

/**
 * Template 6: Environment drift - bot's setup changed.
 */
export function copyEnvironmentDrift(ctx: CopyContext): { headline: string; body: string } {
    const fields = ctx.environmentDriftFields ?? [];
    let changeDescription: string;

    if (fields.includes('system_prompt_hash')) {
        changeDescription = 'Its instructions were updated';
    } else if (fields.includes('skills_hash') || fields.includes('installed_skills')) {
        changeDescription = 'Its available tools changed';
    } else if (fields.includes('config_hash')) {
        changeDescription = 'Its settings were changed';
    } else {
        changeDescription = 'Something about its setup changed';
    }

    return {
        headline: 'Your bot\'s setup changed',
        body: `${changeDescription} since you last checked. Want to review what's different?`,
    };
}

/**
 * Template 7: New plugin/skill install.
 */
export function copyNewPlugin(ctx: CopyContext): { headline: string; body: string } {
    const name = ctx.pluginName ?? 'an unknown plugin';
    return {
        headline: `New plugin: ${name}`,
        body: `A new plugin was added to your bot: ${name}. Want to review what it can do?`,
    };
}

/**
 * Template 8: Financial action - payment or purchase.
 */
export function copyFinancialAction(ctx: CopyContext): { headline: string; body: string } {
    const amount = ctx.amount !== undefined && ctx.currency
        ? `${ctx.currency} ${ctx.amount.toFixed(2)}`
        : 'a payment';
    const merchant = ctx.merchant ?? 'a merchant';

    return {
        headline: `Your bot wants to pay ${merchant}`,
        body: `Your bot is trying to send ${amount} to ${merchant}. Make sure you asked it to make this purchase.`,
    };
}

/**
 * Template 9: Credential access attempt.
 */
export function copyCredentialAccess(ctx: CopyContext): { headline: string; body: string } {
    const domain = ctx.endpoint ? friendlyDomain(ctx.endpoint) : 'a service';
    return {
        headline: 'Your bot wants to use your passwords',
        body: `Your bot is trying to access your saved passwords to log into ${domain}. Only allow this if you asked it to sign in somewhere.`,
    };
}

/**
 * Template 10: Unusual behavior pattern (high anomaly, generic).
 */
export function copyUnusualBehavior(ctx: CopyContext): { headline: string; body: string } {
    const action = translateActionType(ctx.actionType);
    return {
        headline: 'Something unusual is happening',
        body: `Your bot is acting differently than it normally does. It's trying to ${action} in a way that doesn't match its usual patterns. We've paused it to be safe.`,
    };
}

/**
 * Template 13: Hard block - action was denied outright.
 * Reframes the block as protection, not punishment.
 */
export function copyBlockedAction(ctx: CopyContext): { headline: string; body: string } {
    const action = translateActionType(ctx.actionType);
    return {
        headline: 'We protected you',
        body: `Your bot tried to ${action}, but our safety checks determined this action is too risky to allow. This is your trust layer working - every block keeps your accounts safe.`,
    };
}

/**
 * Template 11: Bot trying to send a message (communicate).
 */
export function copyCommunicate(ctx: CopyContext): { headline: string; body: string } {
    return {
        headline: 'Your bot wants to send a message',
        body: 'Your bot is trying to send a message on your behalf. Review the content before allowing it.',
    };
}

/**
 * Template 12: Bot trying to agree to something (commit).
 */
export function copyCommitment(ctx: CopyContext): { headline: string; body: string } {
    return {
        headline: 'Your bot wants to agree to something',
        body: 'Your bot is trying to accept an agreement or sign up for something on your behalf. Review the details before allowing it.',
    };
}

// =============================================================================
// COPY GENERATOR - Selects the right template based on assessment context
// =============================================================================

/**
 * Generate plain-English copy for a notification.
 *
 * Selection priority (most specific wins):
 * 1. Temporal + data exfil combo
 * 2. Reclassification
 * 3. Temporal anomaly (without exfil)
 * 4. Credential access
 * 5. Data exfiltration
 * 6. Financial action
 * 7. New endpoint routine
 * 8. Environment drift / plugin install
 * 9. Communicate / commit
 * 10. Generic unusual behavior
 */
export function generateCopy(
    ctx: CopyContext,
    tier: 1 | 2 | 3,
    isBlocked?: boolean,
): { headline: string; body: string } {
    // Hard blocks get protective framing
    if (isBlocked) {
        return copyBlockedAction(ctx);
    }

    // Tier 3 combos first
    if (ctx.temporalAnomalyFired && ctx.dataCategories.length > 0 && tier === 3) {
        return copyTemporalExfiltration(ctx);
    }

    if (ctx.reclassified) {
        return copyReclassification(ctx);
    }

    if (ctx.temporalAnomalyFired) {
        return copyTemporalAnomaly(ctx);
    }

    // Credential access
    if (ctx.dataCategories.some(c => ['credentials', 'password', 'api_keys', 'tokens'].includes(c))) {
        return copyCredentialAccess(ctx);
    }

    // Data exfiltration
    if (ctx.dataCategories.length > 0 && ctx.endpoint) {
        return copyDataExfiltration(ctx);
    }

    // Financial
    if (['financial', 'approval_only'].includes(ctx.actionType) && ctx.amount !== undefined) {
        return copyFinancialAction(ctx);
    }

    // Environment drift
    if (ctx.environmentDriftFields && ctx.environmentDriftFields.length > 0) {
        return copyEnvironmentDrift(ctx);
    }

    // Plugin install
    if (ctx.pluginName) {
        return copyNewPlugin(ctx);
    }

    // New endpoint routine
    if (ctx.isNewEndpoint && tier === 1) {
        return copyNewEndpointRoutine(ctx);
    }

    // Communication
    if (['communicate', 'agent_communicate'].includes(ctx.actionType)) {
        return copyCommunicate(ctx);
    }

    // Commitment
    if (['commit', 'agent_commit'].includes(ctx.actionType)) {
        return copyCommitment(ctx);
    }

    // Generic fallback
    if (tier >= 2) {
        return copyUnusualBehavior(ctx);
    }

    // Tier 1 new endpoint fallback
    if (ctx.isNewEndpoint) {
        return copyNewEndpointRoutine(ctx);
    }

    // Absolute fallback
    const action = translateActionType(ctx.actionType);
    return {
        headline: `Your bot wants to ${action}`,
        body: `Your bot is requesting permission to ${action}. Would you like to allow it?`,
    };
}

/**
 * Generate the "why am I seeing this?" expander content for power users.
 * This is allowed to be more technical but should still avoid raw jargon.
 */
export function generateDetailsExpander(ctx: CopyContext & {
    anomalyScore: number;
    reclassificationReason?: string;
}): string {
    const parts: string[] = [];

    if (ctx.isNewEndpoint && ctx.endpoint) {
        parts.push(`Your bot has never connected to ${friendlyDomain(ctx.endpoint)} before.`);
    }

    if (ctx.reclassified && ctx.reclassificationReason) {
        const original = translateActionType(ctx.originalActionType ?? ctx.actionType);
        const actual = translateActionType(ctx.reclassifiedActionType ?? ctx.actionType);
        parts.push(
            `Your bot described this as "${original}" but our checks suggest it's actually "${actual}". ` +
            `Reason: ${ctx.reclassificationReason.replace(/_/g, ' ')}`
        );
    }

    if (ctx.temporalAnomalyFired) {
        const sources = ctx.externalSources ?? [];
        if (sources.length > 0) {
            const sourceLabels = sources.map(friendlySource).join(', ');
            parts.push(
                `This action came unusually quickly after your bot read ${sourceLabels}. ` +
                `Sometimes bots can be tricked by content they read into doing things you didn't ask for.`
            );
        }
    }

    if (ctx.dataCategories.length > 0) {
        parts.push(`Data involved: ${translateDataCategories(ctx.dataCategories)}.`);
    }

    if (ctx.intentReasoning) {
        parts.push(`Your bot's reason: "${ctx.intentReasoning}"`);
    }

    if (ctx.anomalyScore > 60) {
        parts.push(
            'Our safety checks flagged this as higher than usual concern. ' +
            'This doesn\'t mean something is definitely wrong, but we wanted to give you the chance to review.'
        );
    }

    if (parts.length === 0) {
        parts.push('This notification was triggered by our routine safety checks.');
    }

    return parts.join('\n\n');
}
