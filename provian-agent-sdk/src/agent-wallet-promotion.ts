import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import { atomicReplacePrivateFile } from './durable-private-file';
import {
  clearPendingAgentWalletRegistration,
} from './pending-wallet-registration';
import {
  writeSessionFileAtPath,
  type AgentSessionFile,
} from './session-file';
import type { AgentWalletRegistrationHandle } from './types';

export const DEFAULT_AGENT_WALLET_MARKER_PATH = path.join(
  homedir(), '.provian', 'agent-wallet',
);
export const DEFAULT_AGENT_SESSION_PATH = path.join(
  homedir(), '.provian', 'session.json',
);

export type AgentWalletPromotionStage =
  | 'wallet_marker_durable'
  | 'session_marker_durable'
  | 'pending_registration_removed';

interface PromotionPaths {
  walletMarkerPath?: string;
  sessionPath?: string;
}

function assertWalletId(walletId: string): void {
  if (!/^wallet_aw_[A-Za-z0-9_-]+$/.test(walletId)) {
    throw new Error('Refusing to promote a malformed agent wallet ID');
  }
}

function persistBoundWalletMarker(walletId: string, markerPath: string): void {
  if (fs.existsSync(markerPath)) {
    const existing = fs.readFileSync(markerPath, 'utf8').trim();
    if (existing !== walletId) {
      throw new Error(`A different agent wallet marker already exists: ${existing || '<empty>'}`);
    }
  }
  // Rewrite even an identical marker so a restart after an uncertain storage
  // acknowledgement reestablishes the file + directory durability barrier.
  atomicReplacePrivateFile(markerPath, `${walletId}\n`);
}

function sessionWithWallet(
  session: AgentSessionFile,
  walletId: string,
): AgentSessionFile {
  if (session.agentWalletId && session.agentWalletId !== walletId) {
    throw new Error(`Session is already bound to a different wallet ${session.agentWalletId}`);
  }
  return { ...session, agentWalletId: walletId };
}

/**
 * Final crash-consistent promotion boundary. Pending registration is deleted
 * only after the wallet marker and (when present) session binding have each
 * crossed their own file + directory fsync barrier.
 *
 * `afterDurableStage` is an internal fault-injection seam used to prove ordered
 * restart behavior. Throwing from it can only retain more recovery state; it
 * cannot skip a durability barrier or delete pending state early.
 */
export function finalizeAgentWalletPromotion(params: {
  walletId: string;
  registrationHandle: AgentWalletRegistrationHandle;
  session: AgentSessionFile | null;
  paths?: PromotionPaths;
  afterDurableStage?: (stage: AgentWalletPromotionStage) => void;
}): void {
  assertWalletId(params.walletId);
  const markerPath = params.paths?.walletMarkerPath ?? DEFAULT_AGENT_WALLET_MARKER_PATH;
  const sessionPath = params.paths?.sessionPath ?? DEFAULT_AGENT_SESSION_PATH;

  persistBoundWalletMarker(params.walletId, markerPath);
  params.afterDurableStage?.('wallet_marker_durable');

  if (params.session) {
    writeSessionFileAtPath(sessionWithWallet(params.session, params.walletId), sessionPath);
  }
  params.afterDurableStage?.('session_marker_durable');

  clearPendingAgentWalletRegistration(params.registrationHandle);
  params.afterDurableStage?.('pending_registration_removed');
}

/**
 * Repair the legacy crash state where the encrypted final keystore and exact
 * same-wallet credentials survived but old code lost both non-secret markers.
 * The caller must first authenticate/decrypt and cross-bind those artifacts.
 */
export function restoreAgentWalletMarkers(params: {
  walletId: string;
  session: AgentSessionFile | null;
  paths?: PromotionPaths;
}): void {
  assertWalletId(params.walletId);
  const markerPath = params.paths?.walletMarkerPath ?? DEFAULT_AGENT_WALLET_MARKER_PATH;
  const sessionPath = params.paths?.sessionPath ?? DEFAULT_AGENT_SESSION_PATH;
  persistBoundWalletMarker(params.walletId, markerPath);
  if (params.session) {
    writeSessionFileAtPath(sessionWithWallet(params.session, params.walletId), sessionPath);
  }
}
