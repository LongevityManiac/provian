import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  finalizeAgentWalletPromotion,
  restoreAgentWalletMarkers,
  type AgentWalletPromotionStage,
} from './agent-wallet-promotion';
import {
  loadOrCreatePendingAgentWalletRegistration,
} from './pending-wallet-registration';
import type { AgentSessionFile } from './session-file';

const PASSPHRASE = 'correct horse battery staple';
const TEST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const WALLET_ID = 'wallet_aw_crash_recovery';
let dir: string;
let pendingPath: string;
let markerPath: string;
let sessionPath: string;

const session: AgentSessionFile = {
  sessionId: 'session-crash-fixture',
  relayUrl: 'https://relay.test',
  agentId: 'crash-agent',
  serverAgentId: 'crash-agent',
  userId: 'user-crash-fixture',
  connectedAt: '2026-07-12T00:00:00.000Z',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-wallet-promotion-'));
  pendingPath = path.join(dir, 'pending.json');
  markerPath = path.join(dir, 'state', 'agent-wallet');
  sessionPath = path.join(dir, 'state', 'session.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function newHandle() {
  return loadOrCreatePendingAgentWalletRegistration({
    relayUrl: 'https://relay.test',
    agentId: 'crash-agent',
    agentName: 'Crash Agent',
    constitutionAcceptedAt: '2026-07-12T00:00:00.000Z',
  }, PASSPHRASE, pendingPath, TEST_KDF);
}

function finalSession(): AgentSessionFile {
  return JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as AgentSessionFile;
}

describe('agent wallet final promotion durability', () => {
  for (const crashAfter of [
    'wallet_marker_durable',
    'session_marker_durable',
  ] as const) {
    it(`recovers idempotently after a crash at ${crashAfter}`, async () => {
      const handle = await newHandle();
      expect(() => finalizeAgentWalletPromotion({
        walletId: WALLET_ID,
        registrationHandle: handle,
        session,
        paths: { walletMarkerPath: markerPath, sessionPath },
        afterDurableStage: (stage: AgentWalletPromotionStage) => {
          if (stage === crashAfter) throw new Error(`simulated_crash:${stage}`);
        },
      })).toThrow(`simulated_crash:${crashAfter}`);

      expect(fs.readFileSync(markerPath, 'utf8')).toBe(`${WALLET_ID}\n`);
      expect(fs.existsSync(pendingPath)).toBe(true);
      if (crashAfter === 'wallet_marker_durable') {
        expect(fs.existsSync(sessionPath)).toBe(false);
      } else {
        expect(finalSession().agentWalletId).toBe(WALLET_ID);
      }

      // A fresh process authenticates the retained pending file, repeats the
      // same marker writes, and only then removes pending state.
      const restartedHandle = await newHandle();
      finalizeAgentWalletPromotion({
        walletId: WALLET_ID,
        registrationHandle: restartedHandle,
        session,
        paths: { walletMarkerPath: markerPath, sessionPath },
      });
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(`${WALLET_ID}\n`);
      expect(finalSession().agentWalletId).toBe(WALLET_ID);
      expect(fs.existsSync(pendingPath)).toBe(false);
      if (os.platform() !== 'win32') {
        expect(fs.statSync(markerPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
      }
    });
  }

  it('has both durable markers before pending deletion can survive a crash', async () => {
    const handle = await newHandle();
    expect(() => finalizeAgentWalletPromotion({
      walletId: WALLET_ID,
      registrationHandle: handle,
      session,
      paths: { walletMarkerPath: markerPath, sessionPath },
      afterDurableStage: (stage) => {
        if (stage === 'pending_registration_removed') {
          throw new Error('simulated_crash:pending_registration_removed');
        }
      },
    })).toThrow('simulated_crash:pending_registration_removed');
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(`${WALLET_ID}\n`);
    expect(finalSession().agentWalletId).toBe(WALLET_ID);
  });

  it('never overwrites a different marker or removes pending recovery state', async () => {
    const handle = await newHandle();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    const before = 'wallet_aw_different\n';
    fs.writeFileSync(markerPath, before, { mode: 0o600 });
    expect(() => finalizeAgentWalletPromotion({
      walletId: WALLET_ID,
      registrationHandle: handle,
      session,
      paths: { walletMarkerPath: markerPath, sessionPath },
    })).toThrow('different agent wallet marker');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(before);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it('rebuilds legacy missing markers without overwriting a contradictory identity', () => {
    restoreAgentWalletMarkers({
      walletId: WALLET_ID,
      session,
      paths: { walletMarkerPath: markerPath, sessionPath },
    });
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(`${WALLET_ID}\n`);
    expect(finalSession().agentWalletId).toBe(WALLET_ID);
    expect(() => restoreAgentWalletMarkers({
      walletId: 'wallet_aw_other',
      session,
      paths: { walletMarkerPath: markerPath, sessionPath },
    })).toThrow('different agent wallet marker');
  });

  it('the actual CLI repairs completed bound artifacts before any relay retry', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'scripts', 'create-agent-wallet.ts'),
      'utf8',
    );
    const completedBoundary = source.indexOf('if (completedLocalWalletId !== null)');
    const networkBoundary = source.indexOf('result = await resumeAgentWalletRegistration');
    expect(completedBoundary).toBeGreaterThan(0);
    expect(networkBoundary).toBeGreaterThan(completedBoundary);
    const recoveryPath = source.slice(completedBoundary, networkBoundary);
    expect(recoveryPath).toContain('finalizeAgentWalletPromotion({');
    expect(recoveryPath).toContain('registrationHandle');
    expect(recoveryPath).toContain('return;');
    expect(recoveryPath).not.toContain('fetch(');
    expect(recoveryPath).not.toContain('resumeAgentWalletRegistration(');
  });
});
