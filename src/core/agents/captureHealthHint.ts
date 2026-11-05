/**
 * What the "Not receiving work" hint shows for one agent : that agent's capture
 * health, as its earning computer last reported it to the relay, and the lines to send the agent.
 *
 * The relay judges each report server-side (`provian-backend/src/routes/devices.ts`) and enriches
 * the linked-agent list with `capture_broken_reason`. Every reason it can send maps to one line here.
 * The line to start the observer is always offered; a reason the agent fixes with one command
 * (`process-lane record`) also offers that command.
 *
 * (the correction): the process lane asks for the re-record line only when no
 * running program matches the recorded launcher, or when its wrapper changed and the agent's own
 * `provian` commands did not re-record it. A suspicion that clears itself never reaches the relay.
 */

import { AGENT_RECORD_LAUNCHER_CMD } from './agentShellCommands';

/** Every reason the relay sends (mirrors `brokenReason` in routes/devices.ts). */
export const CAPTURE_BROKEN_REASONS = [
    'no_readable_sources',
    'sole_witness_silence',
    'session_format_broken',
    'process_launcher_changed',
    'process_launcher_not_seen',
    'process_no_launcher',
    'process_launcher_unsupported',
    'process_lane_silence',
] as const;
export type CaptureBrokenReason = typeof CAPTURE_BROKEN_REASONS[number];

export function parseCaptureBrokenReason(value: unknown): CaptureBrokenReason | null {
    return typeof value === 'string' && (CAPTURE_BROKEN_REASONS as readonly string[]).includes(value)
        ? (value as CaptureBrokenReason)
        : null;
}

export interface CaptureHealthHint {
    /** i18n key of the capture-health line. */
    lineKey: string;
    /** The command that fixes it, sent to the agent to run from its own session; null when none. */
    fixCommand: string | null;
}

const REASON_LINE: Record<CaptureBrokenReason, CaptureHealthHint> = {
    no_readable_sources: { lineKey: 'agentHub.captureNoSources', fixCommand: null },
    sole_witness_silence: { lineKey: 'agentHub.captureSoleSilence', fixCommand: null },
    session_format_broken: { lineKey: 'agentHub.captureFormatBroken', fixCommand: null },
    process_launcher_changed: { lineKey: 'agentHub.captureLauncherChanged', fixCommand: AGENT_RECORD_LAUNCHER_CMD },
    process_launcher_not_seen: { lineKey: 'agentHub.captureLauncherNotSeen', fixCommand: AGENT_RECORD_LAUNCHER_CMD },
    process_no_launcher: { lineKey: 'agentHub.captureNoLauncher', fixCommand: AGENT_RECORD_LAUNCHER_CMD },
    process_launcher_unsupported: { lineKey: 'agentHub.captureLauncherUnsupported', fixCommand: null },
    process_lane_silence: { lineKey: 'agentHub.captureProcessSilence', fixCommand: null },
};

export function captureHealthHint(input: {
    /** `capture_broken_reason` from the relay (unknown strings read as no reason). */
    reason: unknown;
    /** The earning computer has ever reported capture health (`capture_reported_at_ms`). */
    reported: boolean;
}): CaptureHealthHint {
    const reason = parseCaptureBrokenReason(input.reason);
    if (reason) return REASON_LINE[reason];
    return input.reported
        ? { lineKey: 'agentHub.captureHealthy', fixCommand: null }
        : { lineKey: 'agentHub.captureNoReport', fixCommand: null };
}

/** Every line key the hint can show (the locale tests read this list). */
export const CAPTURE_HINT_LINE_KEYS: readonly string[] = [
    ...new Set([
        ...Object.values(REASON_LINE).map((h) => h.lineKey),
        'agentHub.captureHealthy',
        'agentHub.captureNoReport',
    ]),
];
