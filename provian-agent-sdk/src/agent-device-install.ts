/**
 * agent-device-install — "A device for your agent".
 *
 * The human picks a linked agent in the app and emails a one-line command to the
 * machine that agent will use:
 *
 * curl -sSL -H 'x-provian-token: <64-hex>' "https://api.provian.ai/v1/bootstrap/agent-device" | sh
 *
 * The relay's script fetches the same SHA-pinned bundle the Connect line runs and
 * execs it with PROVIAN_AGENT_DEVICE_TOKEN set. This module is what the bundle
 * then does — the Connect install's device leg, with nothing added:
 *
 * register this machine to the agent's EXISTING wallet (the token names it; the
 * relay's dedicated middleware honors it at POST /v1/devices/register only) →
 * persist the device credentials (owner = agent) → install + start the observer
 * service, the shell profile blocks and the git hook (the same `startObserver`
 * step the Connect install runs).
 *
 * So the machine ends where a Connect install ends: on the agent's wallet, which is
 * already linked to the human (the relay only mints this token for a linked
 * agent's own human, or for the agent itself), with the observer running. What it
 * never does: create a second wallet, or copy the agent's private key here — the
 * key stays on the agent's own machine (custody is unchanged). The act verbs that
 * sign with the agent's key (Commons posts, transfers) therefore run where the
 * key is; this machine witnesses.
 */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { StartObserverOutcome } from './bootstrap-flow';
import { cliCommand } from './cli-command';

/** The environment variable the relay's agent-device script sets (never argv). */
export const AGENT_DEVICE_TOKEN_ENV = 'PROVIAN_AGENT_DEVICE_TOKEN';
/** Optional display name the email carried (sanitized by the relay). */
export const AGENT_DEVICE_NAME_ENV = 'PROVIAN_DEVICE_NAME';

/** An `agent_device_registration` setup token: 32 random bytes, hex. */
export function isAgentDeviceToken(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Stable per token, so a re-run of the same emailed line replays the same
 * idempotent registration instead of minting a second device. Never contains the
 * token itself (the registration id is stored and logged relay-side).
 */
export function agentDeviceRegistrationId(token: string): string {
  return `agent-device-${createHash('sha256').update(`provian-agent-device\n${token}`).digest('hex').slice(0, 32)}`;
}

/** Device display name: the emailed name when present, else this machine's hostname. */
export function resolveAgentDeviceName(env: NodeJS.ProcessEnv, host: string = hostname()): string {
  const raw = (env[AGENT_DEVICE_NAME_ENV] ?? '').trim() || host || 'agent-machine';
  const cleaned = raw.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 64);
  return cleaned || 'agent-machine';
}

export interface AgentDeviceInstallDeps {
  registerDevice(input: {
    relayUrl: string; authorization: string; registrationId: string; deviceName: string;
  }): Promise<{ agentWalletId: string; deviceName?: string }>;
  startObserver(): Promise<StartObserverOutcome | void>;
}

export interface AgentDeviceInstallResult {
  registered: boolean;
  agentWalletId?: string;
  deviceName?: string;
  observerRunning: boolean;
  supervision?: string;
  /** Plain-language reason when a step did not complete (never a raw error). */
  failure?: 'registration' | 'observer';
}

export async function runAgentDeviceInstall(
  input: { relayUrl: string; token: string; deviceName: string },
  deps: AgentDeviceInstallDeps,
): Promise<AgentDeviceInstallResult> {
  let registered: { agentWalletId: string; deviceName?: string };
  try {
    registered = await deps.registerDevice({
      relayUrl: input.relayUrl,
      authorization: `Bearer ${input.token}`,
      registrationId: agentDeviceRegistrationId(input.token),
      deviceName: input.deviceName,
    });
  } catch {
    return { registered: false, observerRunning: false, failure: 'registration' };
  }
  try {
    const outcome = await deps.startObserver();
    return {
      registered: true,
      agentWalletId: registered.agentWalletId,
      deviceName: registered.deviceName ?? input.deviceName,
      observerRunning: true,
      ...(outcome && outcome.supervision ? { supervision: outcome.supervision } : {}),
    };
  } catch {
    return {
      registered: true,
      agentWalletId: registered.agentWalletId,
      deviceName: registered.deviceName ?? input.deviceName,
      observerRunning: false,
      failure: 'observer',
    };
  }
}

/** What the install prints. exitCode 0 only when the device is registered AND the observer runs. */
export function renderAgentDeviceOutcome(result: AgentDeviceInstallResult): {
  stdout: string[]; stderr: string[]; exitCode: number;
} {
  if (!result.registered) {
    return {
      stdout: [],
      stderr: [
        '',
        '  This computer could not be registered to your agent. The emailed command works once and',
        '  expires after an hour — ask for a fresh one in the Provian app: Agent Hub → your agent →',
        '  "A device for your agent" (or Connect → A device for your agent), then paste the new line.',
      ],
      exitCode: 1,
    };
  }
  const name = result.deviceName ? ` "${result.deviceName}"` : '';
  const header = [
    '',
    `  ✓ This computer${name} is now a device for your agent.`,
    `    Its work records to the agent's wallet (${result.agentWalletId}), which is linked to you,`,
    '    so what it earns routes your share to you.',
  ];
  if (!result.observerRunning) {
    return {
      stdout: header,
      stderr: [
        '',
        '  The Provian observer did not start, so nothing on this computer is being witnessed yet.',
        `  Start it: ${cliCommand('observe --if-not-running')}`,
        `  Then check capture end to end: ${cliCommand('doctor')}`,
      ],
      exitCode: 1,
    };
  }
  return {
    stdout: [
      ...header,
      `  ✓ The observer is running${result.supervision ? ` (${result.supervision})` : ''} — commits and AI-tool work on this`,
      '    computer become Provenance Envelopes on the agent\'s chain.',
      '',
      `  Check capture end to end any time: ${cliCommand('doctor')}`,
      '',
    ],
    stderr: [],
    exitCode: 0,
  };
}
