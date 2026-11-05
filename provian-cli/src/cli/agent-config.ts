/**
 * Agent pointer file: ~/.provian/agent.json
 *
 * Written by `provian init` after a successful link. This is a NON-SECRET
 * reference file: it records which wallet relay the agent is linked to and
 * how it should reach it, and it points at session.json for the live token.
 * The session token itself never leaves session.json (mode 0600). Keeping the
 * secret in one place means tooling can read the pointer freely without
 * widening the blast radius if agent.json is copied or committed by mistake.
 *
 * All writes are confined to the single ~/.provian/ directory.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { PROVIAN_DIR, PROVIAN_FILE_MODE, ensureProvianDir } from './session';

// Resolved lazily so importing this module never forces PROVIAN_DIR to be
// read at load time (keeps unrelated callers that mock ./session working).
function agentConfigPath(): string {
  return join(PROVIAN_DIR, 'agent.json');
}

export interface AgentConfig {
  /** Relay base URL the agent is linked to. */
  relayUrl: string;
  /** Server-assigned agent identifier (not a secret). */
  serverAgentId: string;
  /** Detected runtime id (e.g. 'node-sdk', 'cli'). */
  runtime: string;
  /** How the agent reaches the wallet: 'cli' (shell out) or 'sdk' (in-process). */
  channel: string;
  /**
   * Pointer to where the live session token lives. The token is NOT stored
   * here — read it from this file inside the same ~/.provian/ directory.
   */
  sessionRef: string;
  /** ISO timestamp of when the link was established. */
  linkedAt: string;
}

export function writeAgentConfig(data: AgentConfig): void {
  ensureProvianDir();
  const file = agentConfigPath();
  // No secret lives in this file, but we still write it owner-only for
  // consistency with the rest of ~/.provian and to keep the link metadata
  // off other local accounts.
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: PROVIAN_FILE_MODE });
  if (platform() !== 'win32') {
    chmodSync(file, PROVIAN_FILE_MODE);
  }
}

export function readAgentConfig(): AgentConfig | null {
  const file = agentConfigPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}
