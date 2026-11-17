/**
 * restore-wallet against the real keystore and credentials files, under a throwaway HOME:
 * a recovery identity can be re-keyed, and the old credentials are never removed before the
 * new ones are durable.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// The keystore, local-secret and credentials modules fix their paths from the home directory when
// they load, so the throwaway HOME is in place before any of them is imported.
const home = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require('fs') as typeof import('fs'), nodeOs = require('os') as typeof import('os'), nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'provian-restore-home-'));
  process.env.HOME = dir;
  return dir;
});
import * as keystore from './keystore';
import * as wallet from './wallet';
import * as secret from './local-keystore-secret';
import * as creds from './scripts/agent-credentials-file';
import * as flow from './restore-wallet-flow';

beforeEach(() => { fs.rmSync(path.join(home, '.provian'), { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

const bare = (key: string): string => key.toLowerCase().replace(/^0x/, '');
const apiPair = () => ({ apiKey: `pvn_live_${randomBytes(16).toString('hex')}`, apiSecret: `pvns_${randomBytes(32).toString('hex')}` });

function machine() {
  expect(keystore.getDefaultKeystorePath().startsWith(home)).toBe(true);
  expect(creds.AGENT_CREDS_PATH.startsWith(home)).toBe(true);
  const walletId = `wallet_aw_${randomBytes(6).toString('hex')}`;
  const held = wallet.generateAgentKeyPair();
  const passphrase = secret.loadOrCreateLocalKeystoreSecret();
  const v1 = keystore.persistAgentWalletKey({ ...held, walletId, passphrase }).keystore;
  const v2 = keystore.initializeRecoveryKeystore(v1, passphrase, keystore.getDefaultKeystorePath());
  expect(v2.version).toBe(2);
  const oldPair = apiPair();
  creds.persistAgentCredentialsFile({ api_key: oldPair.apiKey, api_secret: oldPair.apiSecret, wallet_id: walletId, address: held.address });
  const deps = { ...flow.defaultRestoreWalletDeps(), log: () => {} };
  return { keystore, wallet, creds, flow, walletId, held, passphrase, oldPair, deps };
}

describe('restore-wallet on a machine that already holds the wallet', () => {
  it('re-keys a version 2 keystore and swaps in the rotated credentials', async () => {
    const m = machine();
    const rekeyed = m.wallet.generateAgentKeyPair();
    const pair = apiPair();
    const out = m.flow.runRestoreWallet({
      walletId: m.walletId,
      stdinContent: JSON.stringify({ private_key: bare(rekeyed.privateKey), api_key: pair.apiKey, api_secret: pair.apiSecret }),
    }, m.deps);
    expect(out).toMatchObject({ walletId: m.walletId, address: rekeyed.address, apiCredentialsRestored: true });
    const active = m.keystore.loadKeystore();
    expect(active?.version).toBe(2);
    expect(m.keystore.decryptKeystore(active!, m.passphrase).privateKey).toBe(bare(rekeyed.privateKey));
    expect(m.creds.loadBoundAgentCredentialsFile()).toEqual({ api_key: pair.apiKey, api_secret: pair.apiSecret, wallet_id: m.walletId, address: rekeyed.address });
    expect(fs.readdirSync(path.join(home, '.provian')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a same-key restore on a version 2 keystore changes nothing', async () => {
    const m = machine();
    const before = fs.readFileSync(m.keystore.getDefaultKeystorePath());
    m.flow.runRestoreWallet({ walletId: m.walletId, stdinContent: bare(m.held.privateKey) }, m.deps);
    expect(fs.readFileSync(m.keystore.getDefaultKeystorePath()).equals(before)).toBe(true);
  });

  it('credentials that cannot be written leave the stored credentials file exactly as it was', async () => {
    const m = machine();
    const before = fs.readFileSync(m.creds.AGENT_CREDS_PATH);
    const rekeyed = m.wallet.generateAgentKeyPair();
    // Passes the payload check, but is not a credential the file format accepts.
    const payload = { private_key: bare(rekeyed.privateKey), api_key: `pvn_live_${'a'.repeat(32)}`, api_secret: 'pvns_truncated' };
    expect(() => m.flow.runRestoreWallet({ walletId: m.walletId, stdinContent: JSON.stringify(payload) }, m.deps)).toThrow(/malformed or unbound/);
    expect(fs.existsSync(m.creds.AGENT_CREDS_PATH)).toBe(true);
    expect(fs.readFileSync(m.creds.AGENT_CREDS_PATH).equals(before)).toBe(true);
    expect(m.creds.loadBoundAgentCredentialsFile()?.api_key).toBe(m.oldPair.apiKey);
  });

  it('credentials bound to another wallet id are never replaced', async () => {
    const m = machine();
    const before = fs.readFileSync(m.creds.AGENT_CREDS_PATH);
    const pair = apiPair();
    expect(() => m.flow.replaceAgentCredentialsFileAfterRekey({
      api_key: pair.apiKey, api_secret: pair.apiSecret, wallet_id: 'wallet_aw_someoneelse', address: m.held.address,
    })).toThrow(/different wallet identity/);
    expect(fs.readFileSync(m.creds.AGENT_CREDS_PATH).equals(before)).toBe(true);
  });

  it('a recovered key for a different wallet is refused and nothing on disk changes', async () => {
    const m = machine();
    const keyBefore = fs.readFileSync(m.keystore.getDefaultKeystorePath());
    const credsBefore = fs.readFileSync(m.creds.AGENT_CREDS_PATH);
    const other = m.wallet.generateAgentKeyPair();
    const pair = apiPair();
    expect(() => m.flow.runRestoreWallet({
      walletId: 'wallet_aw_someoneelse',
      stdinContent: JSON.stringify({ private_key: bare(other.privateKey), api_key: pair.apiKey, api_secret: pair.apiSecret }),
    }, m.deps)).toThrow(/different wallet/);
    expect(fs.readFileSync(m.keystore.getDefaultKeystorePath()).equals(keyBefore)).toBe(true);
    expect(fs.readFileSync(m.creds.AGENT_CREDS_PATH).equals(credsBefore)).toBe(true);
  });
});
