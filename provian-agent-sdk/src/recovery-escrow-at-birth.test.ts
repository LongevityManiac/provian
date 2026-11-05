/**
 * invariant, SDK side (OPEN_ITEMS L381): every agent is escrowed for recovery AT BIRTH.
 *
 * The creation primitive `resumeAgentWalletRegistration` which `createChildAgentWallet`, the
 * hosted install (`defaultBootstrapDeps().createWallet`), `onboard` and any programmatic create all
 * go through — seals the new key to the anchor the relay names on the create response and escrows
 * the ciphertext before returning. Proven here for a parent-spawned child and for a fleet-onboarded
 * agent (a create carrying a fleet code), each by OPENING the escrowed blob with the anchor secret
 * and getting back exactly the new wallet's private key.
 *
 * RED controls in-suite : no anchor → no escrow call and `recoveryEscrowed: false`; an
 * escrow the relay refuses → the create RETURNS the wallet and its credential with
 * `recoveryEscrowed: false` and the reason (never thrown: the credential it issued must not be lost,
 * and never reported recoverable), and resuming the same durable registration then escrows it; the
 * bootstrap does not escrow twice once the primitive did, and still escrows when it did not.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';

import {
  createChildAgentWallet,
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
} from './pending-wallet-registration';
import { generateAgentKeyPair } from './wallet';
import { keccak256 } from './keccak256';
import { generateAnchorKeyPair, openWithAnchor, toB64u, fromB64u } from './agent-key-recovery';
import { runAgentBootstrap, type BootstrapDeps, type CreatedWallet } from './bootstrap-flow';

const TEST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const PASSPHRASE = 'correct horse battery staple';
const PARENT = generateAgentKeyPair();
const PARENT_WALLET_ID = 'wallet_aw_parent0001';
const ANCHOR = generateAnchorKeyPair();
const ANCHOR_B64U = toB64u(ANCHOR.publicKey);
const API_KEY = `pvn_live_${'c'.repeat(32)}`;
const API_SECRET = `pvns_${'d'.repeat(64)}`;

let dir: string;
let pendingPath: string;

function deriveEvmAddress(publicKeyHex: string): string {
  return `0x${keccak256(Buffer.from(publicKeyHex, 'hex')).subarray(12).toString('hex')}`;
}

interface Recorded {
  urls: string[];
  createBodies: Record<string, unknown>[];
  escrows: { url: string; auth: string | null; body: { sealed_key_blob: string; recovery_anchor_pubkey: string } }[];
}

function relayMock(opts: { anchor: string | null; escrowStatus?: number[]; walletId?: string }) {
  const recorded: Recorded = { urls: [], createBodies: [], escrows: [] };
  const escrowStatuses = [...(opts.escrowStatus ?? [201])];
  const walletId = opts.walletId ?? 'wallet_aw_born0001';
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    recorded.urls.push(url);
    if (url.includes('/wallet/parent-challenge')) {
      return { ok: true, status: 200, json: async () => ({ challenge_id: 'parent-ch', challenge: 'f'.repeat(64) }) };
    }
    if (url.includes('/wallet/challenge')) {
      return { ok: true, status: 200, json: async () => ({ challenge_id: 'ch', challenge: 'a'.repeat(64) }) };
    }
    if (url.endsWith('/recovery-escrow')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      recorded.escrows.push({ url, auth: headers.Authorization ?? null, body: JSON.parse(String(init?.body)) });
      const status = escrowStatuses.length > 1 ? escrowStatuses.shift()! : escrowStatuses[0];
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    recorded.createBodies.push(body);
    const publicKey = String(body.public_key);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        wallet_id: walletId,
        address: deriveEvmAddress(publicKey),
        public_key: publicKey,
        api_key: API_KEY,
        api_secret: API_SECRET,
        pe_chain_root: 'pe_birth',
        badges: [],
        ...(opts.anchor !== null ? { recovery_anchor_pubkey: opts.anchor } : {}),
      }),
    };
  });
  return { fetchMock, recorded };
}

/** The escrowed blob opens, with the anchor SECRET only, to exactly this wallet's private key. */
function expectEscrowOpensTo(recorded: Recorded, walletId: string, privateKeyHex: string) {
  expect(recorded.escrows).toHaveLength(1);
  const [escrow] = recorded.escrows;
  expect(escrow.url).toBe(`https://relay.test/v1/agent/wallet/${walletId}/recovery-escrow`);
  expect(escrow.auth).toBe(`Bearer ${API_KEY}:${API_SECRET}`);
  expect(escrow.body.recovery_anchor_pubkey).toBe(ANCHOR_B64U);
  const opened = openWithAnchor(ANCHOR.secretKey, fromB64u(escrow.body.sealed_key_blob));
  expect(bytesToHex(opened)).toBe(privateKeyHex.replace(/^0x/, '').toLowerCase());
  // Ciphertext only: the private key never appears in the escrow request in the clear.
  expect(JSON.stringify(escrow.body)).not.toContain(privateKeyHex.replace(/^0x/, '').toLowerCase());
}

const childConfig = {
  relayUrl: 'https://relay.test',
  agentId: 'birth-child',
  agentName: 'Birth Child',
  platform: 'sdk',
  constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
  parentWalletId: PARENT_WALLET_ID,
};

const fleetConfig = {
  relayUrl: 'https://relay.test',
  agentId: 'birth-fleet-agent',
  agentName: 'Birth Fleet Agent',
  platform: 'sdk',
  constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
  connectionToken: 'PROV-FLTC-6789',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-escrow-at-birth-'));
  pendingPath = path.join(dir, 'pending.json');
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a parent-spawned child is escrowed at birth (createChildAgentWallet)', () => {
  it('seals the CHILD\'s key to the anchor the relay named and escrows it before returning', async () => {
    const { fetchMock, recorded } = relayMock({ anchor: ANCHOR_B64U, walletId: 'wallet_aw_child0001' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await createChildAgentWallet(
      childConfig, { parentPrivateKey: PARENT.privateKey }, PASSPHRASE, pendingPath, TEST_KDF,
    );
    expect(result.walletId).toBe('wallet_aw_child0001');
    expect(result.recoveryEscrowed).toBe(true);
    expect(recorded.createBodies[0].parent_wallet_id).toBe(PARENT_WALLET_ID);
    expectEscrowOpensTo(recorded, 'wallet_aw_child0001', result.privateKey);
    // The escrow is the LAST call: it follows the create, and seals the child's key, not the parent's.
    expect(recorded.urls.at(-1)).toContain('/recovery-escrow');
    expect(result.privateKey).not.toBe(PARENT.privateKey);
  });

  it('RED CONTROL: the relay names no anchor (no human at birth) → no escrow call, recoveryEscrowed false', async () => {
    const { fetchMock, recorded } = relayMock({ anchor: null, walletId: 'wallet_aw_child0001' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await createChildAgentWallet(
      childConfig, { parentPrivateKey: PARENT.privateKey }, PASSPHRASE, pendingPath, TEST_KDF,
    );
    expect(result.recoveryEscrowed).toBe(false);
    expect(recorded.escrows).toHaveLength(0);
    expect(recorded.urls.some((u) => u.includes('recovery-escrow'))).toBe(false);
  });

  it('RED CONTROL: an escrow the relay refuses → the wallet and credential are RETURNED, not escrowed; resuming escrows it', async () => {
    const { fetchMock, recorded } = relayMock({ anchor: ANCHOR_B64U, escrowStatus: [503, 201], walletId: 'wallet_aw_child0001' });
    vi.stubGlobal('fetch', fetchMock);
    const first = await createChildAgentWallet(
      childConfig, { parentPrivateKey: PARENT.privateKey }, PASSPHRASE, pendingPath, TEST_KDF,
    );
    expect(first.recoveryEscrowed).toBe(false);
    expect(first.recoveryEscrowError).toMatch(/503/);
    expect(first.apiKey).toBe(API_KEY);
    // The durable registration is retained, so a retry resumes the SAME child key.
    expect(fs.existsSync(pendingPath)).toBe(true);
    recorded.escrows.length = 0;
    const retried = await createChildAgentWallet(
      childConfig, { parentPrivateKey: PARENT.privateKey }, PASSPHRASE, pendingPath, TEST_KDF,
    );
    expect(retried.recoveryEscrowed).toBe(true);
    expect(retried.privateKey).toBe(first.privateKey);
    expectEscrowOpensTo(recorded, 'wallet_aw_child0001', retried.privateKey);
  });
});

describe('a fleet-onboarded agent is escrowed at birth (a create carrying a fleet code)', () => {
  it('sends the fleet code, seals its own key to the human anchor the relay named, and escrows it', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(fleetConfig, PASSPHRASE, pendingPath, TEST_KDF);
    const { fetchMock, recorded } = relayMock({ anchor: ANCHOR_B64U, walletId: 'wallet_aw_fleet0001' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await resumeAgentWalletRegistration(handle);
    expect(recorded.createBodies[0].connection_token).toBe('PROV-FLTC-6789');
    expect(result.recoveryEscrowed).toBe(true);
    expect(result.recoveryAnchorPubkey).toBe(ANCHOR_B64U);
    expectEscrowOpensTo(recorded, 'wallet_aw_fleet0001', result.privateKey);
  });

  it('RED CONTROL: a fleet code whose human has not published (no anchor on the response) → not escrowed at birth', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(fleetConfig, PASSPHRASE, pendingPath, TEST_KDF);
    const { fetchMock, recorded } = relayMock({ anchor: null, walletId: 'wallet_aw_fleet0001' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await resumeAgentWalletRegistration(handle);
    expect(result.recoveryEscrowed).toBe(false);
    expect(recorded.escrows).toHaveLength(0);
  });
});

describe('the bootstrap never escrows twice, and still escrows when the primitive did not', () => {
  function deps(wallet: CreatedWallet) {
    const escrowRecoveryKey = vi.fn(async () => undefined);
    const d: BootstrapDeps = {
      agentIdentity: () => ({ agentId: 'agent-boot', agentName: 'Boot' }),
      createWallet: async () => wallet,
      escrowRecoveryKey,
      registerDevice: async () => undefined,
      startObserver: async () => ({ supervision: 'detached', modelProxyListening: true }),
      joinCommons: async () => ({ ok: true, joinStatus: 'joined' }),
      fileLinkRequest: async () => ({ ok: true, linkStatus: 'linked' }),
      log: () => undefined,
    };
    return { d, escrowRecoveryKey };
  }
  const base: CreatedWallet = {
    walletId: 'wallet_aw_boot0001', address: `0x${'1'.repeat(40)}`, privateKey: 'ab'.repeat(32),
    publicKey: 'cd'.repeat(64), apiKey: API_KEY, apiSecret: API_SECRET, recoveryAnchorPubkey: ANCHOR_B64U,
  };

  it('escrowed at birth → the bootstrap reports it recoverable without a second escrow', async () => {
    const { d, escrowRecoveryKey } = deps({ ...base, recoveryEscrowed: true });
    const out = await runAgentBootstrap({ connectionToken: 'PROV-FLTC-6789', relayUrl: 'https://relay.test' }, d);
    expect(out.recoveryEscrowed).toBe(true);
    expect(escrowRecoveryKey).not.toHaveBeenCalled();
  });

  it('RED CONTROL: not escrowed at birth but an anchor is present → the bootstrap escrows it itself', async () => {
    const { d, escrowRecoveryKey } = deps({ ...base });
    const out = await runAgentBootstrap({ connectionToken: 'PROV-FLTC-6789', relayUrl: 'https://relay.test' }, d);
    expect(out.recoveryEscrowed).toBe(true);
    expect(escrowRecoveryKey).toHaveBeenCalledTimes(1);
  });
});
