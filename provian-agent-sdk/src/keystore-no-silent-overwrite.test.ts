/**
 * A stored key is never destroyed by setup, and a restore replaces one only for the
 * same wallet, only by write-then-swap, and only with the old keystore kept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  decryptKeystore, encryptKeystore, initializeRecoveryKeystore, loadKeystore, persistAgentWalletKey,
  restoreAgentWalletKey, saveKeystore, withRecoverySecret, type AgentKeystore,
} from './keystore';
import { generateAgentKeyPair } from './wallet';
import { ProvianError } from './errors';

const FAST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'another machine local secret';
const bare = (key: string): string => key.toLowerCase().replace(/^0x/, '');

function makeWallet(walletId = `wallet_aw_${randomBytes(6).toString('hex')}`) {
  const kp = generateAgentKeyPair();
  return { privateKey: kp.privateKey, address: kp.address, publicKey: kp.publicKey, walletId };
}

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-keystore-guard-')); file = path.join(dir, 'agent-keystore.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function store(w: ReturnType<typeof makeWallet>, version: 1 | 2, passphrase = PASSPHRASE): AgentKeystore {
  const v1 = encryptKeystore({ ...w, passphrase, kdfParams: FAST_KDF });
  saveKeystore(v1, file);
  return version === 2 ? initializeRecoveryKeystore(v1, passphrase, file) : v1;
}
function refusal(fn: () => unknown): ProvianError {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(ProvianError); return error as ProvianError; }
  throw new Error('expected a refusal, but the call succeeded');
}

describe('persistAgentWalletKey never replaces a stored key', () => {
  for (const version of [1, 2] as const) {
    it(`refuses a different wallet over a version ${version} keystore and leaves the file byte-identical`, () => {
      const held = makeWallet();
      expect(store(held, version).version).toBe(version);
      const before = fs.readFileSync(file);
      const error = refusal(() => persistAgentWalletKey({ ...makeWallet(), passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF }));
      expect(error.code).toBe('KEYSTORE_EXISTS');
      expect(error.message).toContain(held.walletId);
      expect(error.message).toContain(file);
      expect(error.message).toMatch(/export-agent-keystore/);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(decryptKeystore(loadKeystore(file) as AgentKeystore, PASSPHRASE).privateKey).toBe(bare(held.privateKey));
    });

    it(`refuses a different key for the same wallet id over a version ${version} keystore, naming restore and rotation`, () => {
      const held = makeWallet();
      store(held, version);
      const before = fs.readFileSync(file);
      const error = refusal(() => persistAgentWalletKey({ ...makeWallet(held.walletId), passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF }));
      expect(error.code).toBe('KEYSTORE_EXISTS');
      expect(error.message).toMatch(/restore-wallet/);
      expect(error.message).toMatch(/rotate-key/);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
    });

    it(`refuses when the local secret does not open the version ${version} keystore`, () => {
      const held = makeWallet();
      store(held, version, OTHER_PASSPHRASE);
      const before = fs.readFileSync(file);
      const error = refusal(() => persistAgentWalletKey({ ...makeWallet(), passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF }));
      expect(error.code).toBe('KEYSTORE_EXISTS');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(decryptKeystore(loadKeystore(file) as AgentKeystore, OTHER_PASSPHRASE).privateKey).toBe(bare(held.privateKey));
    });

    it(`returns the stored version ${version} keystore unchanged for the same wallet and key`, () => {
      const held = makeWallet();
      store(held, version);
      const before = fs.readFileSync(file);
      const again = persistAgentWalletKey({ ...held, passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF });
      expect(again.path).toBe(file);
      expect(again.keystore.version).toBe(version);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
    });
  }

  it('still writes when nothing is stored', () => {
    const w = makeWallet();
    const { keystore } = persistAgentWalletKey({ ...w, passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF });
    expect(decryptKeystore(keystore, PASSPHRASE).privateKey).toBe(bare(w.privateKey));
  });
});

describe('restoreAgentWalletKey replaces only the same wallet, and keeps what it replaced', () => {
  it('writes a keystore where none is stored', () => {
    const w = makeWallet();
    const out = restoreAgentWalletKey({ ...w, passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF });
    expect(out.replacedCopy).toBeUndefined();
    expect(decryptKeystore(loadKeystore(file) as AgentKeystore, PASSPHRASE).privateKey).toBe(bare(w.privateKey));
  });

  it('re-keys a recovery identity: the new key is installed, the recovery secret is kept, the old keystore is kept aside', async () => {
    const held = makeWallet();
    const old = store(held, 2);
    const oldSecret = await withRecoverySecret(old, PASSPHRASE, s => Buffer.from(s).toString('hex'));
    const rekeyed = makeWallet(held.walletId);
    const out = restoreAgentWalletKey({ ...rekeyed, passphrase: PASSPHRASE, filePath: file });
    const active = loadKeystore(file) as AgentKeystore;
    expect(active.version).toBe(2);
    expect(active.address).toBe(rekeyed.address);
    expect(decryptKeystore(active, PASSPHRASE).privateKey).toBe(bare(rekeyed.privateKey));
    expect(await withRecoverySecret(active, PASSPHRASE, s => Buffer.from(s).toString('hex'))).toBe(oldSecret);
    expect(out.replacedCopy).toBeDefined();
    const kept = loadKeystore(out.replacedCopy as string) as AgentKeystore;
    expect(decryptKeystore(kept, PASSPHRASE).privateKey).toBe(bare(held.privateKey));
    expect(fs.statSync(out.replacedCopy as string).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a version 1 keystore of the same wallet and keeps the old one aside', () => {
    const held = makeWallet();
    store(held, 1);
    const rekeyed = makeWallet(held.walletId);
    const out = restoreAgentWalletKey({ ...rekeyed, passphrase: PASSPHRASE, filePath: file });
    expect(decryptKeystore(loadKeystore(file) as AgentKeystore, PASSPHRASE).privateKey).toBe(bare(rekeyed.privateKey));
    expect(decryptKeystore(loadKeystore(out.replacedCopy as string) as AgentKeystore, PASSPHRASE).privateKey).toBe(bare(held.privateKey));
  });

  it('restores over a same-wallet keystore the local secret no longer opens, keeping that keystore aside', () => {
    const held = makeWallet();
    store(held, 2, OTHER_PASSPHRASE);
    const out = restoreAgentWalletKey({ ...held, passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF });
    expect(decryptKeystore(loadKeystore(file) as AgentKeystore, PASSPHRASE).privateKey).toBe(bare(held.privateKey));
    expect(decryptKeystore(loadKeystore(out.replacedCopy as string) as AgentKeystore, OTHER_PASSPHRASE).privateKey).toBe(bare(held.privateKey));
  });

  it('is a no-op for the same wallet and key', () => {
    const held = makeWallet();
    store(held, 2);
    const before = fs.readFileSync(file);
    const out = restoreAgentWalletKey({ ...held, passphrase: PASSPHRASE, filePath: file });
    expect(out.replacedCopy).toBeUndefined();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).filter(name => name.includes('.replaced-'))).toEqual([]);
  });

  for (const version of [1, 2] as const) {
    it(`refuses to restore over a different wallet's version ${version} keystore`, () => {
      const held = makeWallet();
      store(held, version);
      const before = fs.readFileSync(file);
      const error = refusal(() => restoreAgentWalletKey({ ...makeWallet(), passphrase: PASSPHRASE, filePath: file, kdfParams: FAST_KDF }));
      expect(error.code).toBe('KEYSTORE_EXISTS');
      expect(error.message).toContain(held.walletId);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(fs.readdirSync(dir).filter(name => name.includes('.replaced-'))).toEqual([]);
    });
  }
});
