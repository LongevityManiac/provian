/**
 * Environment Change Notifications - Plain-Language Alerts
 *
 * Translates environment integrity signals from Phase 4
 * (EnvironmentAttestation) into friendly, understandable alerts.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface EnvironmentAlert {
    /** Alert type for routing */
    type: 'config_drift' | 'new_plugin' | 'prompt_change' | 'general_drift';
    /** User-facing headline */
    headline: string;
    /** User-facing body text */
    body: string;
    /** Suggested action label */
    actionLabel: string;
    /** Whether this warrants pausing the bot */
    shouldPause: boolean;
}

export interface DriftInfo {
    /** Which fields changed from baseline */
    changedFields: string[];
    /** Agent name for display */
    agentName?: string;
}

export interface PluginInfo {
    /** Plugin/skill name */
    name: string;
    /** Optional description of what it does */
    description?: string;
    /** Source URL if available */
    sourceUrl?: string;
    /** Agent name for display */
    agentName?: string;
}

// =============================================================================
// DRIFT FIELD TRANSLATIONS
// =============================================================================

/** Maps internal field names to user-friendly descriptions */
const DRIFT_FIELD_DESCRIPTIONS: Record<string, string> = {
    config_hash: 'settings were changed',
    skills_hash: 'available tools were updated',
    system_prompt_hash: 'instructions were updated',
    memory_hash: 'memory or context was modified',
    installed_skills: 'the list of installed tools changed',
    openclaw_version: 'the bot software was updated',
};

function describeDriftFields(fields: string[]): string {
    const descriptions = fields
        .map(f => DRIFT_FIELD_DESCRIPTIONS[f])
        .filter(Boolean);

    if (descriptions.length === 0) {
        return 'something about its setup changed';
    }
    if (descriptions.length === 1) {
        return `its ${descriptions[0]}`;
    }
    if (descriptions.length === 2) {
        return `its ${descriptions[0]} and ${descriptions[1]}`;
    }
    return `its ${descriptions.slice(0, -1).join(', ')}, and ${descriptions[descriptions.length - 1]}`;
}

// =============================================================================
// ALERT GENERATORS
// =============================================================================

/**
 * Generate a user-facing alert for environment drift.
 */
export function createDriftAlert(drift: DriftInfo): EnvironmentAlert {
    const botName = drift.agentName ? `"${drift.agentName}"` : 'Your bot';
    const fields = drift.changedFields;

    // Determine specific alert type based on which fields changed
    if (fields.includes('system_prompt_hash')) {
        return {
            type: 'prompt_change',
            headline: `${botName}'s instructions were updated`,
            body: `${botName}'s instructions were changed since you last checked. This could affect how it behaves. Want to see what's different?`,
            actionLabel: 'Review changes',
            shouldPause: true,
        };
    }

    if (fields.includes('skills_hash') || fields.includes('installed_skills')) {
        const alsoHasOtherChanges = fields.some(
            f => f !== 'skills_hash' && f !== 'installed_skills'
        );
        return {
            type: 'config_drift',
            headline: `${botName}'s tools changed`,
            body: alsoHasOtherChanges
                ? `${botName}'s available tools and other settings changed since you last checked. Want to review?`
                : `${botName}'s available tools changed since you last checked. Want to review what's different?`,
            actionLabel: 'Review changes',
            shouldPause: false,
        };
    }

    // General drift
    return {
        type: 'general_drift',
        headline: `${botName}'s setup changed`,
        body: `${describeDriftFields(fields)} since you last checked. Want to review what's different?`,
        actionLabel: 'Review changes',
        shouldPause: false,
    };
}

/**
 * Generate a user-facing alert for a new plugin/skill installation.
 */
export function createPluginAlert(plugin: PluginInfo): EnvironmentAlert {
    const botName = plugin.agentName ? `"${plugin.agentName}"` : 'Your bot';
    const pluginLabel = plugin.name || 'an unknown plugin';

    let body = `A new plugin was added to ${botName}: ${pluginLabel}.`;
    if (plugin.description) {
        body += ` It ${plugin.description}.`;
    }
    body += ' Want to review what it can do?';

    return {
        type: 'new_plugin',
        headline: `New plugin: ${pluginLabel}`,
        body,
        actionLabel: 'Review plugin',
        shouldPause: false,
    };
}

/**
 * Generate a user-facing alert for system prompt changes specifically.
 * This is a higher-risk drift event and should be highlighted.
 */
export function createPromptChangeAlert(agentName?: string): EnvironmentAlert {
    const botName = agentName ? `"${agentName}"` : 'Your bot';
    return {
        type: 'prompt_change',
        headline: `${botName}'s instructions were updated`,
        body: `${botName}'s core instructions were changed. This affects how it thinks and acts. We recommend reviewing the changes before continuing.`,
        actionLabel: 'Review instructions',
        shouldPause: true,
    };
}
