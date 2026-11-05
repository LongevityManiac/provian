/**
 * test fixture: a REAL agent wallet created through the agent-wallet
 * route, then key-rotated through the REAL `executeKeyRotationTransition` and/or
 * credential-recovered through the real recovery path — so watcher tests bind
 * to the exact Firestore graph production writes, never a hand-copied shape.
 *
 * The calling test file must mock `../agent-wallet/proof-of-possession` (the
 * route's PoP) exactly as `key-rotation-transition.test.ts` does: challenge id
 * `challenge-1` is a first registration, any other id a credential recovery.
 */

import { ethers } from 'ethers';
import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './fake-firestore';
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from '../watcher-address-admission';
import { generateApiCredentialsAsync } from '../../agent-wallet/api-key';
import type { RouterDeps } from '../../agent-wallet/types';
import type { AgentBankDeps } from '../../agent-bank/types';
import { createAgentWalletRouter } from '../../../routes/agent-wallet';
import {
  executeKeyRotationTransition,
  prepareKeyRotationTransition,
  type KeyRotationResult,
} from '../../agent-wallet/key-rotation-transition';

export type FakeDb = ReturnType<typeof createFakeFirestore>;

export const BIRTH_PUBLIC_KEY = 'a'.repeat(128);
export const BIRTH_ADDRESS = '0xb1a7b1a7b1a7b1a7b1a7b1a7b1a7b1a7b1a7b1a7';
export const AGENT_ID = 'canonical-agent';
export const REGISTRATION_HEAD = 140;

export interface RotationSigner {
  readonly address: string;
  readonly publicKey: string;
}

/** A deterministic secp256k1 identity (address + uncompressed key, no 04). */
export function rotationSigner(byteHex: string): RotationSigner {
  const signer = new ethers.Wallet(`0x${byteHex.repeat(32)}`);
  return {
    address: signer.address.toLowerCase(),
    publicKey: signer.signingKey.publicKey.slice(4),
  };
}

export const SIGNER_ONE = rotationSigner('11');
export const SIGNER_TWO = rotationSigner('22');

export function buildAgentRoute(): { app: express.Express; fake: FakeDb } {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453,
    last_processed_block: 130,
    membership_generation: 7,
    updated_at: 1,
  });
  const known = new Map<string, string>([
    [BIRTH_PUBLIC_KEY, BIRTH_ADDRESS],
    [SIGNER_ONE.publicKey.toLowerCase(), SIGNER_ONE.address],
    [SIGNER_TWO.publicKey.toLowerCase(), SIGNER_TWO.address],
  ]);
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: (publicKey: string) =>
      known.get(publicKey.toLowerCase()) ?? BIRTH_ADDRESS,
    readBaseRegistrationHead: async () => REGISTRATION_HEAD,
    generateRecoveryApiCredentials: generateApiCredentialsAsync,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake };
}

export function agentBankDeps(fake: FakeDb): AgentBankDeps {
  return {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
  } as unknown as AgentBankDeps;
}

function registrationBody(publicKey: string, challengeId: string): Record<string, unknown> {
  return {
    registration_id: 'agent-registration-canonical-agent-0001',
    agent_name: 'Canonical Agent',
    agent_id: AGENT_ID,
    platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    public_key: publicKey,
    challenge_id: challengeId,
    signature: 'ab'.repeat(64),
  };
}

export async function createAgentWallet(app: express.Express): Promise<string> {
  const response = await request(app)
    .post('/v1/agent/wallet/create')
    .send(registrationBody(BIRTH_PUBLIC_KEY, 'challenge-1'));
  if (response.status !== 201 || response.body.address !== BIRTH_ADDRESS) {
    throw new Error(`agent_create_failed:${response.status}:${JSON.stringify(response.body)}`);
  }
  return response.body.wallet_id as string;
}

/** Credential recovery presenting the wallet's CURRENT public key. */
export async function recoverAgentCredentials(
  app: express.Express,
  publicKey: string,
): Promise<request.Response> {
  return request(app)
    .post('/v1/agent/wallet/create')
    .send(registrationBody(publicKey, 'challenge-recover'));
}

/** Rotate through the real transition. `now` must be real time (not future). */
export async function rotateAgent(
  fake: FakeDb,
  walletId: string,
  signer: RotationSigner,
  options: { now: number; head: number; rotationId?: string },
): Promise<KeyRotationResult> {
  const plan = await prepareKeyRotationTransition({
    db: fake as unknown as Firestore,
    walletId,
    newIdentity: {
      newAddress: signer.address,
      newPublicKey: signer.publicKey,
      newApiCredentials: await generateApiCredentialsAsync(),
    },
    rotationId: options.rotationId ?? `rotation-${signer.address.slice(2, 10)}`,
    now: options.now,
    readBaseHead: async () => options.head,
  });
  return executeKeyRotationTransition(agentBankDeps(fake), plan);
}
