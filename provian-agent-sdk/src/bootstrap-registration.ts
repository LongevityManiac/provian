
import * as fs from 'fs';
import { ProvianError } from './errors';
import {
  DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH,
  loadOrCreatePendingAgentWalletRegistration,
  peekPendingAgentWalletRegistration,
  relayHoldsPendingRegistration,
  setAsidePendingAgentWalletRegistration,
} from './pending-wallet-registration';
import type { AgentWalletRegistrationHandle } from './types';
import { guardedFetch } from './guarded-fetch';

export interface BootstrapRegistrationInput {
  relayUrl: string;
  agentId: string;
  agentName: string;
  connectionToken: string;
}

export interface BootstrapRegistrationOptions {
  passphrase: string;
  filePath?: string;
  fetchImpl?: typeof globalThis.fetch;
  log?: (message: string) => void;
}

export async function loadBootstrapRegistration(
  input: BootstrapRegistrationInput,
  options: BootstrapRegistrationOptions,
): Promise<AgentWalletRegistrationHandle> {
  const filePath = options.filePath ?? DEFAULT_PENDING_AGENT_WALLET_REGISTRATION_PATH;
  const log = options.log ?? (() => undefined);
  const relayUrl = input.relayUrl.replace(/\/$/, '');
  const load = (agentName: string) => loadOrCreatePendingAgentWalletRegistration({
    relayUrl: input.relayUrl, agentId: input.agentId, agentName,
    platform: 'sdk', constitutionAccepted: false,
    connectionToken: input.connectionToken,
  }, options.passphrase, filePath);

  if (!fs.existsSync(filePath)) return load(input.agentName);

  const sealed = peekPendingAgentWalletRegistration(filePath);
  if (!sealed) {
    // Unreadable: it never held a request this SDK could have sent. Keep it, start fresh.
    setAsidePendingAgentWalletRegistration(filePath);
    log('An unreadable leftover from an earlier setup attempt was set aside; starting fresh.');
    return load(input.agentName);
  }

  const sameIdentity = sealed.agentId === input.agentId && sealed.relayUrl === relayUrl;
  const unchanged = sameIdentity
    && sealed.agentName === input.agentName
    && sealed.connectionToken === input.connectionToken;
  if (unchanged) return load(input.agentName);

  const held = await relayHoldsPendingRegistration(sealed, options.fetchImpl ?? guardedFetch);
  if (held === false) {
    setAsidePendingAgentWalletRegistration(filePath);
    log('An earlier setup attempt never reached Provian; starting a fresh registration with this code.');
    return load(input.agentName);
  }
  if (sameIdentity) return load(sealed.agentName);

  // The relay holds (or may hold) a registration whose local secret is gone: resuming it is
  // impossible and preparing a second one beside it could orphan a live wallet. Unknown = block.
  throw new ProvianError(
    held === true
      ? 'An earlier setup on this machine registered a wallet with Provian, but this machine no longer has the secret that unlocks it. Recover the agent from the Provian app instead of reinstalling.'
      : 'An earlier setup on this machine left a registration whose state Provian could not confirm. Paste the command again in a minute.',
    held === true ? 'PENDING_REGISTRATION_SECRET_LOST' : 'PENDING_REGISTRATION_UNCONFIRMED',
  );
}

/** Retry a relay call that failed in transit or with a 5xx — the resume is idempotent. */
export async function withTransientRetry<T>(
  run: () => Promise<T>,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = options.delaysMs ?? [2_000, 5_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === 'CONNECTION_ERROR' || (typeof code === 'string' && /^HTTP_5\d\d$/.test(code));
      if (!transient || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
