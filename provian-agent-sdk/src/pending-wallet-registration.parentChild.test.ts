import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createChildAgentWallet,
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
} from './pending-wallet-registration';
import { canonicalParentAuthorizationMessage } from './parent-pop';
import { generateAgentKeyPair } from './wallet';
import type { AgentWalletRegistrationHandle } from './types';
import { keccak256 } from './keccak256';

const TEST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const PASSPHRASE = 'correct horse battery staple';

// A stable, real parent key pair. Its public key is what the RELAY would have
// registered for the parent; here it is the key the SDK signs the
// parent-challenge with, and the key the test verifies that signature against.
const PARENT = generateAgentKeyPair();
const PARENT_WALLET_ID = 'wallet_aw_parent0001';
const CHILD_CHALLENGE = 'a'.repeat(64);
const PARENT_CHALLENGE = 'f'.repeat(64);

let dir: string;
let pendingPath: string;

function deriveEvmAddress(publicKeyHex: string): string {
  const hash = keccak256(Buffer.from(publicKeyHex, 'hex'));
  return `0x${hash.subarray(12).toString('hex')}`;
}

function spkiPemFromUncompressedHex(pubKeyHexNoPrefix: string): string {
  const cleaned = pubKeyHexNoPrefix.toLowerCase().replace(/^0x/, '').replace(/^04/, '');
  const pubKeyBytes = Buffer.from('04' + cleaned, 'hex');
  const der = Buffer.concat([
    Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
    pubKeyBytes,
  ]);
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

function relayVerifies(message: string, signatureHex: string, pubKeyHex: string): boolean {
  const v = crypto.createVerify('SHA256');
  v.update(message);
  return v.verify(spkiPemFromUncompressedHex(pubKeyHex), Buffer.from(signatureHex, 'hex'));
}

interface Recorded {
  urls: string[];
  bodies: Record<string, unknown>[];
}

/**
 * Routes the three requests a child resume makes by URL:
 *   GET  /v1/agent/wallet/challenge        -> child PoP challenge
 *   GET  /v1/agent/wallet/parent-challenge -> parent authorization challenge
 *   POST /v1/agent/wallet/create           -> success (echoes child pubkey)
 * and records every URL + create body for assertions.
 */
function routedCreateMock(): { fetchMock: ReturnType<typeof vi.fn>; recorded: Recorded } {
  const recorded: Recorded = { urls: [], bodies: [] };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    recorded.urls.push(url);
    if (url.includes('/wallet/parent-challenge')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ challenge_id: 'parent-ch-1', challenge: PARENT_CHALLENGE, expires_at: 1 }),
      };
    }
    if (url.includes('/wallet/challenge')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ challenge_id: 'child-ch-1', challenge: CHILD_CHALLENGE }),
      };
    }
    // POST /create
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    recorded.bodies.push(body);
    const publicKey = String(body.public_key);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        wallet_id: 'wallet_aw_child0001',
        address: deriveEvmAddress(publicKey),
        public_key: publicKey,
        api_key: `pvn_live_${'c'.repeat(32)}`,
        api_secret: `pvns_${'d'.repeat(64)}`,
        pe_chain_root: 'pe_birth',
        badges: [],
      }),
    };
  });
  return { fetchMock, recorded };
}

const childConfig = {
  relayUrl: 'https://relay.test',
  agentId: 'canonical-child',
  agentName: 'Canonical Child',
  platform: 'sdk-cli',
  constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
  parentWalletId: PARENT_WALLET_ID,
};

const parentlessConfig = {
  relayUrl: 'https://relay.test',
  agentId: 'ordinary-agent',
  agentName: 'Ordinary Agent',
  platform: 'sdk-cli',
  constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-child-pending-'));
  pendingPath = path.join(dir, 'pending.json');
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parent-spawned child registration (durable flow)', () => {
  it('seals parentWalletId into the durable snapshot', async () => {
    await loadOrCreatePendingAgentWalletRegistration(childConfig, PASSPHRASE, pendingPath, TEST_KDF);
    const stored = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { prepared: Record<string, unknown> };
    expect(stored.prepared.parentWalletId).toBe(PARENT_WALLET_ID);
  });

  it('sends parent_wallet_id + a relay-verifiable parent PoP, and never touches Genesis', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const { fetchMock, recorded } = routedCreateMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resumeAgentWalletRegistration(handle, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    });
    expect(result.walletId).toBe('wallet_aw_child0001');

    // Exactly three requests, in order: child challenge, parent challenge, create.
    expect(recorded.urls).toHaveLength(3);
    expect(recorded.urls[0]).toContain('/v1/agent/wallet/challenge');
    expect(recorded.urls[1]).toContain('/v1/agent/wallet/parent-challenge');
    expect(recorded.urls[2]).toContain('/v1/agent/wallet/create');
    // The SDK never calls any Genesis surface — the child's zero-Genesis outcome
    // is the relay's, driven purely by parent_wallet_id being present.
    expect(recorded.urls.some((u) => /genesis/i.test(u))).toBe(false);

    // The create body carries parent_wallet_id — the exact signal. If the
    // SDK dropped it, the child would look parentless and Genesis-eligible; this
    // assertion is the RED control that ties the SDK to.
    const body = recorded.bodies[0];
    expect(body.parent_wallet_id).toBe(PARENT_WALLET_ID);

    // The parent PoP shape and cryptographic validity against the parent key.
    const proof = body.parent_proof_of_authorization as { challenge_id: string; signature: string };
    expect(proof.challenge_id).toBe('parent-ch-1');
    const childAddress = deriveEvmAddress(String(body.public_key)).toLowerCase();
    const relayMessage = canonicalParentAuthorizationMessage(PARENT_CHALLENGE, {
      parent_wallet_id: PARENT_WALLET_ID,
      child_address: childAddress,
    });
    expect(relayVerifies(relayMessage, proof.signature, PARENT.publicKey)).toBe(true);
  });

  it('fails closed (no networking) when a child is resumed without parentAuthorization', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration(handle))
      .rejects.toMatchObject({ code: 'PARENT_AUTHORIZATION_REQUIRED' });
    // RED control: the guard must block BEFORE any relay call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed (no networking) when parentAuthorization is given for a parentless snapshot', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      parentlessConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration(handle, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    })).rejects.toMatchObject({ code: 'PARENT_AUTHORIZATION_WITHOUT_PARENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the relay’s own PARENT_POP_INVALID create error unchanged', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/wallet/parent-challenge')) {
        return { ok: true, status: 200, json: async () => ({ challenge_id: 'p', challenge: PARENT_CHALLENGE }) };
      }
      if (url.includes('/wallet/challenge')) {
        return { ok: true, status: 200, json: async () => ({ challenge_id: 'c', challenge: CHILD_CHALLENGE }) };
      }
      // resume reads the create error via response.text() (see
      // resumeAgentWalletRegistration); provide it as the relay would.
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'PARENT_POP_INVALID', reason: 'signature_invalid' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration(handle, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    })).rejects.toMatchObject({ message: 'PARENT_POP_INVALID', code: 'HTTP_401' });
  });

  it('surfaces a relay parent-challenge rejection (parent not active) as PARENT_CHALLENGE_FAILED', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    // The parent-challenge itself declines (parent not active / not found path).
    // (The 128-child cap is enforced later, at create time, and surfaces as the
    // relay's HTTP 503 canonical_agent_wallet_registration_failed via the
    // ordinary !response.ok path — not here.)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/wallet/parent-challenge')) {
        return { ok: false, status: 400, json: async () => ({ error: 'parent_wallet_id is not active' }) };
      }
      if (url.includes('/wallet/challenge')) {
        return { ok: true, status: 200, json: async () => ({ challenge_id: 'c', challenge: CHILD_CHALLENGE }) };
      }
      throw new Error('create must not be reached when parent authorization fails');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration(handle, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    })).rejects.toMatchObject({ code: 'PARENT_CHALLENGE_FAILED' });
  });
});

describe('parentless resume is unchanged by the parent-aware path (regression guard)', () => {
  it('sends NO parent fields and makes only the two ordinary requests', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      parentlessConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const { fetchMock, recorded } = routedCreateMock();
    vi.stubGlobal('fetch', fetchMock);
    await resumeAgentWalletRegistration(handle);
    // Only child challenge + create — no parent-challenge.
    expect(recorded.urls).toHaveLength(2);
    expect(recorded.urls.some((u) => u.includes('/wallet/parent-challenge'))).toBe(false);
    const body = recorded.bodies[0];
    expect('parent_wallet_id' in body).toBe(false);
    expect('parent_proof_of_authorization' in body).toBe(false);
  });
});

describe('createChildAgentWallet convenience', () => {
  it('creates an admitted child end to end with parent fields on the wire', async () => {
    const { fetchMock, recorded } = routedCreateMock();
    vi.stubGlobal('fetch', fetchMock);
    const result = await createChildAgentWallet(
      childConfig,
      { parentPrivateKey: PARENT.privateKey },
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    expect(result.walletId).toBe('wallet_aw_child0001');
    expect(recorded.bodies[0].parent_wallet_id).toBe(PARENT_WALLET_ID);
    expect(recorded.bodies[0]).toHaveProperty('parent_proof_of_authorization');
    // Durable child key was persisted before networking (crash-safe).
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it('rejects a non-canonical parentWalletId before any key generation or networking', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createChildAgentWallet(
      { ...childConfig, parentWalletId: 'not-a-wallet-id' },
      { parentPrivateKey: PARENT.privateKey },
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).rejects.toMatchObject({ code: 'PARENT_WALLET_ID_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('rejects a missing parentAuthorization key before any networking', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createChildAgentWallet(
      childConfig,
      { parentPrivateKey: '' },
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).rejects.toMatchObject({ code: 'PARENT_AUTHORIZATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A resumed child sends byte-identical parent_wallet_id across attempts (the
// durable snapshot is the source of truth, exactly like registration_id).
describe('crash-safe resume of a child preserves the parent binding', () => {
  it('replays the same parent_wallet_id after a lost create response', async () => {
    const handle: AgentWalletRegistrationHandle = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/wallet/parent-challenge')) {
        return { ok: true, status: 200, json: async () => ({ challenge_id: 'p', challenge: PARENT_CHALLENGE }) };
      }
      if (url.includes('/wallet/challenge')) {
        return { ok: true, status: 200, json: async () => ({ challenge_id: 'c', challenge: CHILD_CHALLENGE }) };
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) throw new Error('lost create response');
      const publicKey = String(body.public_key);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          wallet_id: 'wallet_aw_child_recovered',
          address: deriveEvmAddress(publicKey),
          public_key: publicKey,
          api_key: `pvn_live_${'c'.repeat(32)}`,
          api_secret: `pvns_${'d'.repeat(64)}`,
          pe_chain_root: 'pe_birth',
          badges: [],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resumeAgentWalletRegistration(handle, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    })).rejects.toThrow('lost create response');

    const reloaded = await loadOrCreatePendingAgentWalletRegistration(
      childConfig, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const recovered = await resumeAgentWalletRegistration(reloaded, {
      parentAuthorization: { parentPrivateKey: PARENT.privateKey },
    });
    expect(recovered.walletId).toBe('wallet_aw_child_recovered');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].parent_wallet_id).toBe(PARENT_WALLET_ID);
    expect(bodies[1].parent_wallet_id).toBe(PARENT_WALLET_ID);
    expect(bodies[1].registration_id).toBe(bodies[0].registration_id);
  });
});
