import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCompletedAgentWalletPending,
  completePendingAgentWalletRegistration,
  loadCompletedAgentWalletIdentity,
  loadOrCreatePendingAgentWalletRegistration,
  reloadPendingAgentWalletRegistration,
  type AgentWalletCompletionStage,
} from './agent-wallet-registration';

let dir: string;
let pendingPath: string;
let finalPath: string;
const PASSPHRASE = 'mcp test passphrase';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-mcp-wallet-'));
  pendingPath = path.join(dir, 'pending.json');
  finalPath = path.join(dir, 'final.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local MCP pending agent wallet identity', () => {
  it.each([
    { requested_agent_id: null, expected: /^default-bot-[a-f0-9]{6}$/ },
    { requested_agent_id: 'explicit-agent-id', expected: /^explicit-agent-id$/ },
  ])('persists and reuses default/explicit agent ID and key: $requested_agent_id', (variant) => {
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Default Bot',
      requested_agent_id: variant.requested_agent_id,
      platform: 'mcp',
    };
    const first = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    const replay = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    expect(replay).toEqual(first);
    expect(first.agentId).toMatch(variant.expected);
    expect(fs.readFileSync(pendingPath, 'utf8')).not.toContain(first.privateKey);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('promotes the encrypted identity and remains decryptable after completion', () => {
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Final Bot',
      requested_agent_id: 'final-bot',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    completePendingAgentWalletRegistration(
      pending.registrationId,
      { wallet_id: 'wallet_aw_final', address: pending.address },
      { passphrase: PASSPHRASE, context, pendingPath, finalPath },
    );
    expect(fs.existsSync(pendingPath)).toBe(false);
    const final = loadCompletedAgentWalletIdentity(PASSPHRASE, finalPath, context);
    expect(final).toMatchObject({
      walletId: 'wallet_aw_final',
      registrationId: pending.registrationId,
      agentId: pending.agentId,
      privateKey: pending.privateKey,
    });
  });

  it('fails closed on a different explicit identity', () => {
    loadOrCreatePendingAgentWalletRegistration({
      relay_url: 'https://relay.test',
      agent_name: 'Bound Bot',
      requested_agent_id: 'bound-bot',
      platform: 'mcp',
    }, PASSPHRASE, pendingPath, 1 << 10);
    expect(() => loadOrCreatePendingAgentWalletRegistration({
      relay_url: 'https://relay.test',
      agent_name: 'Bound Bot',
      requested_agent_id: 'different-bot',
      platform: 'mcp',
    }, PASSPHRASE, pendingPath, 1 << 10)).toThrow('refusing replacement');
  });

  it('canonicalizes context property order across restart', () => {
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Ordered Bot',
      requested_agent_id: 'ordered-bot',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    const reordered = {
      platform: 'mcp',
      requested_agent_id: 'ordered-bot',
      agent_name: 'Ordered Bot',
      relay_url: 'https://relay.test',
    };
    expect(loadOrCreatePendingAgentWalletRegistration(
      reordered, PASSPHRASE, pendingPath, 1 << 10,
    )).toEqual(pending);
  });

  it('authenticates the same durable bytes again after the challenge', () => {
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Reload Bot',
      requested_agent_id: 'reload-bot',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    expect(reloadPendingAgentWalletRegistration(
      context, PASSPHRASE, pending, pendingPath,
    )).toEqual(pending);
    const raw = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as {
      agent_name: string;
    };
    raw.agent_name = 'Changed After Challenge';
    fs.writeFileSync(pendingPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    expect(() => reloadPendingAgentWalletRegistration(
      context, PASSPHRASE, pending, pendingPath,
    )).toThrow();
  });

  it('rejects pending and completed identity reuse against a different relay', () => {
    const context = {
      relay_url: 'https://relay-a.test',
      agent_name: 'Relay Bound Bot',
      requested_agent_id: null,
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    expect(() => loadOrCreatePendingAgentWalletRegistration({
      ...context,
      relay_url: 'https://relay-b.test',
    }, PASSPHRASE, pendingPath, 1 << 10)).toThrow('refusing replacement');
    completePendingAgentWalletRegistration(
      pending.registrationId,
      { wallet_id: 'wallet_aw_relay_bound', address: pending.address },
      { passphrase: PASSPHRASE, context, pendingPath, finalPath },
    );
    expect(() => loadCompletedAgentWalletIdentity(PASSPHRASE, finalPath, {
      ...context,
      relay_url: 'https://relay-b.test',
    })).toThrow('does not match this relay/request context');
  });

  for (const crashAfter of [
    'final_identity_durable',
    'pending_identity_removed',
  ] as const) {
    it(`converges on the original identity after a crash at ${crashAfter}`, () => {
      const context = {
        relay_url: 'https://relay.test',
        agent_name: 'Crash Bound Bot',
        requested_agent_id: 'crash-bound-bot',
        platform: 'mcp',
      };
      const pending = loadOrCreatePendingAgentWalletRegistration(
        context, PASSPHRASE, pendingPath, 1 << 10,
      );
      expect(() => completePendingAgentWalletRegistration(
        pending.registrationId,
        { wallet_id: 'wallet_aw_crash_bound', address: pending.address },
        {
          passphrase: PASSPHRASE,
          context,
          pendingPath,
          finalPath,
          afterDurableStage: (stage: AgentWalletCompletionStage) => {
            if (stage === crashAfter) throw new Error(`simulated_crash:${stage}`);
          },
        },
      )).toThrow(`simulated_crash:${crashAfter}`);

      expect(fs.existsSync(finalPath)).toBe(true);
      expect(fs.existsSync(pendingPath)).toBe(crashAfter === 'final_identity_durable');
      const recovered = loadCompletedAgentWalletIdentity(PASSPHRASE, finalPath, context);
      expect(recovered).toMatchObject({
        walletId: 'wallet_aw_crash_bound',
        registrationId: pending.registrationId,
        privateKey: pending.privateKey,
      });
      // The production caller performs this only after exact same-wallet API
      // credentials have also been loaded and cross-bound.
      clearCompletedAgentWalletPending(PASSPHRASE, context, pendingPath, finalPath);
      expect(fs.existsSync(pendingPath)).toBe(false);
    });
  }

  it('rejects a same-ID pending substitution before final identity mutation', () => {
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Substitution Bot',
      requested_agent_id: 'substitution-bot',
      platform: 'mcp',
    };
    const pending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, pendingPath, 1 << 10,
    );
    const before = fs.readFileSync(pendingPath, 'utf8');
    const substituted = JSON.parse(before) as Record<string, unknown>;
    substituted.unknown = 'same registration and address, different authenticated bytes';
    const substitutedBytes = `${JSON.stringify(substituted, null, 2)}\n`;
    fs.writeFileSync(pendingPath, substitutedBytes, { mode: 0o600 });

    expect(() => completePendingAgentWalletRegistration(
      pending.registrationId,
      { wallet_id: 'wallet_aw_substitution', address: pending.address },
      { passphrase: PASSPHRASE, context, pendingPath, finalPath },
    )).toThrow(/unknown or incomplete schema/);
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.readFileSync(pendingPath, 'utf8')).toBe(substitutedBytes);
  });

  it('refuses unsafe pending paths without touching the symlink target', () => {
    if (os.platform() === 'win32') return;
    const context = {
      relay_url: 'https://relay.test',
      agent_name: 'Symlink Bot',
      requested_agent_id: 'symlink-bot',
      platform: 'mcp',
    };
    const targetPath = path.join(dir, 'target.json');
    const targetPending = loadOrCreatePendingAgentWalletRegistration(
      context, PASSPHRASE, targetPath, 1 << 10,
    );
    const before = fs.readFileSync(targetPath, 'utf8');
    fs.symlinkSync(targetPath, pendingPath);

    expect(() => completePendingAgentWalletRegistration(
      targetPending.registrationId,
      { wallet_id: 'wallet_aw_symlink', address: targetPending.address },
      { passphrase: PASSPHRASE, context, pendingPath, finalPath },
    )).toThrow(/private regular file/);
    expect(fs.lstatSync(pendingPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(before);
    expect(fs.existsSync(finalPath)).toBe(false);
  });
});
