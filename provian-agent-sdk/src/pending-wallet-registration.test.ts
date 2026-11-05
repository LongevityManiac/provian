import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingAgentWalletRegistration,
  assertPendingAgentWalletRegistrationIdentity,
  loadOrCreatePendingAgentWalletRegistration,
  resumeAgentWalletRegistration,
} from './pending-wallet-registration';
import type { AgentWalletRegistrationHandle } from './types';
import { keccak256 } from './keccak256';

const TEST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const PASSPHRASE = 'correct horse battery staple';
let dir: string;
let pendingPath: string;

function deriveEvmAddress(publicKeyHex: string): string {
  const hash = keccak256(Buffer.from(publicKeyHex, 'hex'));
  return `0x${hash.subarray(12).toString('hex')}`;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-wallet-pending-'));
  pendingPath = path.join(dir, 'pending.json');
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('encrypted pending agent-wallet registration', () => {
  const config = {
    relayUrl: 'https://relay.test',
    agentId: 'cli-pending-agent',
    agentName: 'CLI Pending Agent',
    platform: 'sdk-cli',
    constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
  };

  it('persists before networking and reuses the same encrypted ID/key tuple', async () => {
    const first = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const replay = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first as object)).toEqual([]);
    expect(Object.isFrozen(replay)).toBe(true);
    const raw = fs.readFileSync(pendingPath, 'utf8');
    expect(raw).toContain('pending-agent-wallet-registration/v1');
    expect(raw).not.toMatch(/"privateKey"\s*:/);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('treats governance property order as one canonical retry identity', async () => {
    const firstConfig = {
      ...config,
      governance: {
        pe_coverage_enabled: true,
        human_oversight_enabled: false,
        spending_limits_enabled: true,
      },
    };
    const reorderedConfig = {
      ...config,
      governance: {
        spending_limits_enabled: true,
        human_oversight_enabled: false,
        pe_coverage_enabled: true,
      },
    };
    await loadOrCreatePendingAgentWalletRegistration(
      firstConfig,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    await expect(loadOrCreatePendingAgentWalletRegistration(
      reorderedConfig,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).resolves.toBeDefined();
  });

  it('resumes after an ambiguous POST with the exact durable identity', async () => {
    const prepared = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenge_id: 'challenge-1', challenge: 'a'.repeat(64) }),
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        throw new Error('lost create response');
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenge_id: 'challenge-2', challenge: 'b'.repeat(64) }),
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const body = bodies[bodies.length - 1];
        const publicKey = String(body.public_key);
        return {
          ok: true,
          json: async () => ({
            wallet_id: 'wallet_aw_cli_recovered',
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

    await expect(resumeAgentWalletRegistration(prepared)).rejects.toThrow('lost create response');
    const reloaded = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const recovered = await resumeAgentWalletRegistration(reloaded);
    expect(recovered.walletId).toBe('wallet_aw_cli_recovered');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      registration_id: bodies[0].registration_id,
      agent_id: bodies[0].agent_id,
      public_key: bodies[0].public_key,
      constitution_accepted_at: bodies[0].constitution_accepted_at,
    });
  });

  // Every earlier default: the pre-relabel literal and the 2026-09-24 label the
  // text revision superseded. A pending registration sealed under either replays it.
  it.each([
    'human-agentic-constitution-v0.1',
    'network-constitution-2026-09-24',
  ])('replays a pending registration sealed under the earlier default version %s unchanged', async (LEGACY) => {
    // Write the pending file with an SDK whose default was the earlier literal
    // (the version an earlier release sealed when the caller named none).
    vi.resetModules();
    vi.doMock('./types', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./types.js')>()),
      NETWORK_CONSTITUTION_VERSION: LEGACY,
    }));
    const legacySdk = await import('./pending-wallet-registration.js');
    await legacySdk.loadOrCreatePendingAgentWalletRegistration(config, PASSPHRASE, pendingPath, TEST_KDF);
    vi.doUnmock('./types');
    vi.resetModules();
    const currentSdk = await import('./pending-wallet-registration.js');
    const currentTypes = await import('./types.js');
    expect(currentTypes.NETWORK_CONSTITUTION_VERSION).not.toBe(LEGACY);

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenge_id: 'challenge-legacy', challenge: 'a'.repeat(64) }),
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const publicKey = String(bodies[0].public_key);
        return {
          ok: true,
          json: async () => ({
            wallet_id: 'wallet_aw_cli_legacy',
            address: deriveEvmAddress(publicKey),
            public_key: publicKey,
            api_key: `pvn_live_${'c'.repeat(32)}`,
            api_secret: `pvns_${'d'.repeat(64)}`,
            pe_chain_root: 'pe_birth',
            badges: [],
          }),
        };
      }));
    const handle = await currentSdk.loadOrCreatePendingAgentWalletRegistration(
      config, PASSPHRASE, pendingPath, TEST_KDF,
    );
    const result = await currentSdk.resumeAgentWalletRegistration(handle);
    expect(result.walletId).toBe('wallet_aw_cli_legacy');
    expect(bodies[0].constitution_version).toBe(LEGACY);
  });

  it('control: a tampered sealed version fails the encrypted snapshot binding', async () => {
    await loadOrCreatePendingAgentWalletRegistration(config, PASSPHRASE, pendingPath, TEST_KDF);
    const stored = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as {
      prepared: { constitutionVersion: string };
    };
    stored.prepared.constitutionVersion = 'some-other-constitution-v9';
    fs.writeFileSync(pendingPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadOrCreatePendingAgentWalletRegistration(
      config, PASSPHRASE, pendingPath, TEST_KDF,
    )).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on context mismatch and clears only the matching identity', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    await expect(loadOrCreatePendingAgentWalletRegistration(
      { ...config, agentId: 'different-agent' },
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).rejects.toThrow('refusing to create a second identity');
    expect(() => clearPendingAgentWalletRegistration({} as AgentWalletRegistrationHandle))
      .toThrow('authenticated durable registration handle');
    clearPendingAgentWalletRegistration(handle);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('rejects fabricated handles and caller mutation before any fetch', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration({} as AgentWalletRegistrationHandle))
      .rejects.toMatchObject({ code: 'DURABLE_REGISTRATION_HANDLE_REQUIRED' });
    expect(() => Object.assign(handle as object, { agentName: 'Mutated' })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cross-binds a prior final keystore identity before retry networking', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const raw = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as {
      prepared: { address: string; publicKey: string };
    };
    expect(() => assertPendingAgentWalletRegistrationIdentity(handle, raw.prepared))
      .not.toThrow();
    expect(() => assertPendingAgentWalletRegistrationIdentity(handle, {
      address: `0x${'1'.repeat(40)}`,
      publicKey: 'b'.repeat(128),
    })).toThrow('does not match the pending registration identity');
  });

  it('rejects backend-incompatible config before key persistence or networking', async () => {
    const invalidConfigs = [
      { ...config, agentName: 'x'.repeat(101) },
      { ...config, platform: 'x'.repeat(51) },
      { ...config, constitutionAccepted: 'true' },
      { ...config, constitutionAcceptedAt: '2999-01-01T00:00:00.000Z' },
      { ...config, governance: { full_governance: true } },
      { ...config, governance: { pe_coverage_enabled: 'true' } },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const invalid of invalidConfigs) {
      await expect(loadOrCreatePendingAgentWalletRegistration(
        invalid as never,
        PASSPHRASE,
        pendingPath,
        TEST_KDF,
      )).rejects.toMatchObject({ code: 'INVALID_WALLET_REGISTRATION_CONFIG' });
      expect(fs.existsSync(pendingPath)).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects tampering with the stored prepared request before networking', async () => {
    const handle = await loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    );
    const stored = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as {
      prepared: { relayUrl: string; agentName: string };
    };
    stored.prepared.relayUrl = 'https://different-relay.test';
    stored.prepared.agentName = 'Tampered Agent';
    fs.writeFileSync(pendingPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resumeAgentWalletRegistration(handle)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).rejects.toThrow();
  });

  it('resumes a snapshot whose connectionToken is a real 14-char PROV code (14-vs-16 regression)', async () => {
    // A connectionToken reaches this validator only when the durable snapshot carries one;
    // inject it into the stored snapshot exactly as the tampering test injects other fields.
    await loadOrCreatePendingAgentWalletRegistration(config, PASSPHRASE, pendingPath, TEST_KDF);
    const stored = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { prepared: Record<string, unknown> };
    stored.prepared.connectionToken = 'PROV-ABCD-2345'; // a real 14-char code
    fs.writeFileSync(pendingPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // RE-LOAD runs assertExactPrepared over the stored values. Before the fix, its
    // /^[A-Za-z0-9_-]{16,256}$/ guard threw "prepared snapshot values are invalid" on this
    // 14-char code (14 < 16) — the exact resume break. After the fix it validates against the
    // canonical PROV shape and resumes. Paired with the >=16-char reject below, this proves the
    // connectionToken format branch is REACHED (not identity-rejected) and discriminates correctly.
    const replay = await loadOrCreatePendingAgentWalletRegistration(config, PASSPHRASE, pendingPath, TEST_KDF);
    expect(Object.isFrozen(replay)).toBe(true);
  });

  it('still rejects a snapshot whose connectionToken is a >=16-char non-PROV string', async () => {
    // The old guard ACCEPTED any 16..256 char [A-Za-z0-9_-] token; the canonical shape must not.
    await loadOrCreatePendingAgentWalletRegistration(config, PASSPHRASE, pendingPath, TEST_KDF);
    const stored = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as { prepared: Record<string, unknown> };
    stored.prepared.connectionToken = 'ABCDEFGHIJKLMNOP'; // 16 chars, not a PROV code
    fs.writeFileSync(pendingPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await expect(loadOrCreatePendingAgentWalletRegistration(
      config,
      PASSPHRASE,
      pendingPath,
      TEST_KDF,
    )).rejects.toThrow();
  });
});
