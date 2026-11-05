/**
 * the act verbs load the identity the hosted install left on the machine:
 * ~/.provian/agent-credentials.json (0600), agent-keystore.json and agent-keystore.secret.
 * Fixtures are real files in a temp home; the key is released only through withKey.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadInstalledAgent, InstalledAgentError } from './installed-agent';
import { encryptKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';

const FAST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const SECRET = 'a'.repeat(64);
const API_KEY = `pvn_live_${'1'.repeat(32)}`;
const API_SECRET = `pvns_${'2'.repeat(64)}`;

let home: string;
let kp: ReturnType<typeof generateAgentKeyPair>;

function writePrivate(file: string, body: string, mode = 0o600): void {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

function install(opts: { walletId?: string; credsWallet?: string; credsAddress?: string; secret?: string | null; credsMode?: number } = {}): void {
  const dir = path.join(home, '.provian');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const walletId = opts.walletId ?? 'wallet_aw_bot';
  writePrivate(path.join(dir, 'agent-credentials.json'), JSON.stringify({
    api_key: API_KEY, api_secret: API_SECRET,
    wallet_id: opts.credsWallet ?? walletId, address: opts.credsAddress ?? kp.address,
  }), opts.credsMode ?? 0o600);
  const ks = encryptKeystore({ privateKey: kp.privateKey, address: kp.address, publicKey: kp.publicKey, walletId, passphrase: SECRET, kdfParams: FAST_KDF });
  writePrivate(path.join(dir, 'agent-keystore.json'), JSON.stringify(ks));
  if (opts.secret !== null) writePrivate(path.join(dir, 'agent-keystore.secret'), opts.secret ?? SECRET);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-installed-'));
  kp = generateAgentKeyPair();
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('loadInstalledAgent', () => {
  it('loads the install\'s credentials and releases the matching key only inside withKey', async () => {
    install();
    const agent = loadInstalledAgent({ home, env: {} });
    expect(agent.walletId).toBe('wallet_aw_bot');
    expect(agent.address.toLowerCase()).toBe(kp.address.toLowerCase());
    expect(agent.config).toEqual({ relayUrl: 'https://api.provian.ai', walletId: 'wallet_aw_bot', apiKey: API_KEY, apiSecret: API_SECRET });
    expect(JSON.stringify(agent)).not.toContain(kp.privateKey.replace(/^0x/, ''));
    const seen = await agent.withKey(async (k) => k);
    expect(seen.replace(/^0x/, '')).toBe(kp.privateKey.replace(/^0x/, ''));
  });

  it('honours PROVIAN_RELAY_URL and PROVIAN_KEYSTORE_PASSPHRASE', async () => {
    install({ secret: null });
    const agent = loadInstalledAgent({ home, env: { PROVIAN_RELAY_URL: 'https://relay.test', PROVIAN_KEYSTORE_PASSPHRASE: SECRET } });
    expect(agent.config.relayUrl).toBe('https://relay.test');
    await expect(agent.withKey(async () => 'ok')).resolves.toBe('ok');
  });

  it('RED: no credentials file → NO_CREDENTIALS', () => {
    expect(() => loadInstalledAgent({ home, env: {} })).toThrow(InstalledAgentError);
    try { loadInstalledAgent({ home, env: {} }); } catch (e) { expect((e as InstalledAgentError).code).toBe('NO_CREDENTIALS'); }
  });

  it('RED: a world-readable credentials file is refused (never read)', () => {
    if (process.platform === 'win32') return;
    install({ credsMode: 0o644 });
    expect(() => loadInstalledAgent({ home, env: {} })).toThrow(/agent-credentials\.json/);
  });

  it('RED: keystore and credentials for different wallets → refuses to sign for either', () => {
    install({ credsWallet: 'wallet_aw_other' });
    expect(() => loadInstalledAgent({ home, env: {} })).toThrow(/refusing to sign/);
  });

  it('RED: keystore address differs from the credentials address → refuses', () => {
    install({ credsAddress: '0x' + '9'.repeat(40) });
    expect(() => loadInstalledAgent({ home, env: {} })).toThrow(/address does not match/);
  });

  it('RED: no at-rest secret and no passphrase → withKey refuses, the callback never runs', async () => {
    install({ secret: null });
    const agent = loadInstalledAgent({ home, env: {} });
    let ran = false;
    await expect(agent.withKey(async () => { ran = true; })).rejects.toMatchObject({ code: 'NO_KEYSTORE_SECRET' });
    expect(ran).toBe(false);
  });

  it('RED: a wrong at-rest secret → KEYSTORE_DECRYPT_FAILED (never a key)', async () => {
    install({ secret: 'b'.repeat(64) });
    const agent = loadInstalledAgent({ home, env: {} });
    await expect(agent.withKey(async (k) => k)).rejects.toMatchObject({ code: 'KEYSTORE_DECRYPT_FAILED' });
  });

  it('an error thrown INSIDE the callback propagates unchanged (not mistaken for a decrypt failure)', async () => {
    install();
    const agent = loadInstalledAgent({ home, env: {} });
    await expect(agent.withKey(async () => { throw new Error('rpc down'); })).rejects.toThrow('rpc down');
  });
});
