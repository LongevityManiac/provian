import { translate } from '../../i18n/translate';

/**
 * agentOnboardingErrors — turn machine error strings into ONE plain-English
 * sentence plus a next action, for the two-touch agent onboarding flow
 * (connect / invite / recovery / working-signal).
 *
 * the operator’s requirement #3: a failure in this flow must NEVER surface a raw error
 * code, stack trace, or resolver string (e.g. `connection_token_issuer_unresolved`)
 * to the human. Every screen in the flow maps failures through here first. The
 * mapper is exhaustive-by-fallback: anything it does not recognise collapses to
 * a safe generic sentence — it never echoes the raw input.
 */

/** A human-readable failure: one sentence + a concrete next step. */
export interface AgentOnboardingErrorMessage {
    /** One plain-English sentence describing what went wrong. */
    message: string;
    /** A concrete next action the human can take. */
    action: string;
}

const GENERIC_FALLBACK: AgentOnboardingErrorMessage = {
    message: "Something went wrong and we couldn't complete that step.",
    action: 'Check your connection and try again in a moment.',
};

/**
 * Known error codes/strings → human messages. Keys are matched case-insensitively,
 * first by exact code, then as a substring of the raw error (so a wrapped
 * `HTTP 404: no_recovery_escrow` still resolves). Order matters: the first
 * substring hit wins, so list the more specific codes first.
 */
const KNOWN: Array<{ match: string; result: AgentOnboardingErrorMessage }> = [
    // --- Recovery escrow (GET /v1/agent/wallet/:id/recovery-escrow) ---
    {
        match: 'no_recovery_escrow',
        result: {
            message: "This agent hasn't stored a recovery backup yet.",
            action: 'Ask the agent to finish connecting once — recovery becomes available after its first run.',
        },
    },
    {
        match: 'not_your_linked_agent',
        result: {
            message: 'This agent is linked to a different Provian account.',
            action: 'Sign in with the account that invited the agent, then try again.',
        },
    },
    {
        match: 'agent wallet not found',
        result: {
            message: "We couldn't find that agent wallet.",
            action: 'Return to the agent list and pick the agent again.',
        },
    },
    // --- Local anchor custody (this device) ---
    {
        match: 'anchor_secret_not_found',
        result: {
            message: "The recovery key for this agent isn't on this phone or in your cloud backup.",
            action: 'Recover on the phone that invited the agent, signed into the same iCloud or Google account.',
        },
    },
    {
        match: 'cloud_backup_unavailable',
        result: {
            message: 'Cloud backup is off, so agent recovery cannot be set up on this device.',
            action: 'Turn on iCloud Keychain (iOS) or sign into Google (Android), then invite the agent again.',
        },
    },
    {
        match: 'anchor_backup_not_synced',
        result: {
            message: "The recovery key was saved locally but didn't reach your cloud backup.",
            action: 'Confirm iCloud / Google is signed in and try inviting the agent again.',
        },
    },
    // --- Sealed-blob integrity (openWithAnchor fail-closed) ---
    {
        match: 'recovery blob is too short',
        result: {
            message: 'The stored recovery backup looks incomplete.',
            action: 'Ask the agent to re-run once so it can refresh its recovery backup.',
        },
    },
    {
        match: 'unsupported recovery blob version',
        result: {
            message: 'This recovery backup was made by a newer version of Provian.',
            action: 'Update the Provian app, then try recovering again.',
        },
    },
    {
        // xchacha20poly1305 tag failure surfaces as a generic decrypt throw.
        match: 'invalid tag',
        result: {
            message: "The recovery key on this phone doesn't match this agent's backup.",
            action: 'Recover on the phone that originally invited the agent.',
        },
    },
    // --- Auth / token minting ---
    {
        match: 'connection_token_issuer_unresolved',
        result: {
            message: "We couldn't create an invite code just now.",
            action: 'Try again in a moment — this usually clears on its own.',
        },
    },
    {
        match: 'missing wallet auth token',
        result: {
            message: 'Your session needs to re-authenticate.',
            action: 'Reopen the app to sign back in, then try again.',
        },
    },
    {
        match: 'not authenticated',
        result: {
            message: 'Your session needs to re-authenticate.',
            action: 'Reopen the app to sign back in, then try again.',
        },
    },
    {
        match: 'recovery_throttled',
        result: {
            message: 'We just refreshed your session — give it a few seconds.',
            action: 'Wait a moment and try again.',
        },
    },
    // --- Network shapes ---
    {
        match: 'network',
        result: {
            message: "We couldn't reach Provian.",
            action: 'Check your internet connection and try again.',
        },
    },
    {
        match: 'timeout',
        result: {
            message: 'That request took too long.',
            action: 'Try again — if it keeps happening, check your connection.',
        },
    },
    {
        match: 'failed to fetch',
        result: {
            message: "We couldn't reach Provian.",
            action: 'Check your internet connection and try again.',
        },
    },
];

/** Translate display sentences without changing raw error matching or ordering. */
function localizedError(result: AgentOnboardingErrorMessage, code = 'generic'): AgentOnboardingErrorMessage {
    const key = code.replace(/[^a-z0-9]+/g, '_');
    return {
        message: translate(`agentOnboardingErrors.${key}.message`, result.message),
        action: translate(`agentOnboardingErrors.${key}.action`, result.action),
    };
}

/**
 * Extract the raw error string from any thrown value or API error field,
 * WITHOUT ever returning it to the UI directly.
 */
function rawText(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof Error) {
        // Some callers attach a machine `code`; prefer it, then fall back to message.
        const code = (input as { code?: unknown }).code;
        const codeStr = typeof code === 'string' ? code : '';
        return `${codeStr} ${input.message}`.trim();
    }
    if (input && typeof input === 'object') {
        const obj = input as { error?: unknown; code?: unknown; message?: unknown };
        const parts = [obj.code, obj.error, obj.message]
            .filter((p): p is string => typeof p === 'string');
        if (parts.length > 0) return parts.join(' ');
    }
    return '';
}

/**
 * Map any failure in the agent-onboarding flow to a human sentence + next action.
 * Never returns the raw code. Unknown inputs get the safe generic fallback.
 */
export function mapAgentOnboardingError(input: unknown): AgentOnboardingErrorMessage {
    const text = rawText(input).toLowerCase();
    if (!text) return localizedError(GENERIC_FALLBACK);
    for (const entry of KNOWN) {
        if (text.includes(entry.match.toLowerCase())) {
            return localizedError(entry.result, entry.match);
        }
    }
    return localizedError(GENERIC_FALLBACK);
}

/** Convenience: the mapped message and action as one display string. */
export function formatAgentOnboardingError(input: unknown): string {
    const { message, action } = mapAgentOnboardingError(input);
    return `${message} ${action}`;
}
