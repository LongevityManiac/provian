/**
 * Shared agent lifecycle-status model (, re-based in).
 *
 * Every card that shows an agent — the Wallet home "Your Agents" card, the Agent
 * Hub list, the Agent Detail header — used to reconstruct "is it working?" ad hoc
 * from a mix of session status, `pe_count > 0`, and hardcoded two-way labels, so
 * the SAME agent read differently on each surface. This is the ONE derivation, so
 * an agent's status reads identically everywhere.
 *
 * relay agent sessions no longer exist. Liveness is the EARNING DEVICE's
 * capture heartbeat, which the relay enriches onto each beneficiary-linked agent
 * (`LinkedAgent.last_capture_at_ms` / `capture_reported_at_ms` /
 * `capture_receiving` / `capture_broken`). Inputs are only fields the relay
 * already returns. No invented telemetry.
 */

export type AgentStatusKey =
  | 'active'        // its device captured work within the heartbeat window — working now
  | 'idle'          // its device has reported before and has produced work, but is quiet
  | 'setup_pending' // linked wallet, but no device has ever reported — finish connecting it
  | 'attention';    // a device reports, but capture is broken or nothing was ever produced

export type AgentStatusTone = 'positive' | 'neutral' | 'warning';

export interface AgentStatusView {
  key: AgentStatusKey;
  tone: AgentStatusTone;
  /** i18n key under `agentStatus.*` for the short chip label. */
  labelKey: string;
  /** True once the agent has produced any PE (work recorded on its chain). */
  hasWork: boolean;
}

/** A capture heartbeat is "live" only when it landed within this window. */
export const AGENT_ACTIVE_HEARTBEAT_MS = 10 * 60 * 1000; // 10 minutes

export interface AgentStatusInput {
  linked?: {
    pe_count?: number;
    last_capture_at_ms?: number | null;
    capture_reported_at_ms?: number | null;
    capture_receiving?: boolean | null;
    capture_broken?: boolean | null;
  } | null;
  livePeCount?: number | null;
  now?: number;
}

/**
 * Resolve an agent's lifecycle status from its linked wallet's capture heartbeat.
 *   - no device has ever reported        → setup_pending (linked, but not connected)
 *   - capture landed within the window,
 *     or the device reports receiving now → active
 *   - reports, but broken / no work yet    → attention (needs a nudge)
 *   - reports, has work, quiet             → idle
 */
export function deriveAgentStatus(input: AgentStatusInput): AgentStatusView {
  const now = input.now ?? Date.now();
  const linked = input.linked ?? null;
  const peCount = input.livePeCount ?? linked?.pe_count ?? 0;
  const hasWork = peCount > 0;

  const lastCapture = typeof linked?.last_capture_at_ms === 'number' ? linked.last_capture_at_ms : null;
  const reportedAt = typeof linked?.capture_reported_at_ms === 'number' ? linked.capture_reported_at_ms : null;
  if (lastCapture === null && reportedAt === null) {
    return { key: 'setup_pending', tone: 'warning', labelKey: 'agentStatus.setupPending', hasWork };
  }

  const broken = linked?.capture_broken === true;
  const captureFresh = lastCapture !== null && now - lastCapture <= AGENT_ACTIVE_HEARTBEAT_MS;
  const receivingNow = !broken
    && linked?.capture_receiving === true
    && reportedAt !== null
    && now - reportedAt <= AGENT_ACTIVE_HEARTBEAT_MS;
  if (!broken && (captureFresh || receivingNow)) {
    return { key: 'active', tone: 'positive', labelKey: 'agentStatus.active', hasWork };
  }

  // Reporting but broken, or has never produced work → nudge to finish enabling it.
  if (broken || !hasWork) {
    return { key: 'attention', tone: 'warning', labelKey: 'agentStatus.notReceiving', hasWork };
  }
  return { key: 'idle', tone: 'neutral', labelKey: 'agentStatus.idle', hasWork };
}
