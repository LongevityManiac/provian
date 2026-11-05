import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  encryptKeystore,
  decryptKeystore,
  saveKeystore,
  loadKeystore,
  exportKeystore,
  importKeystore,
  persistAgentWalletKey,
  type AgentKeystore,
} from './keystore';
import { generateAgentKeyPair } from './wallet';
import { ProvianError } from './errors';

// Low scrypt cost keeps the suite fast; production uses N=2^17.
const FAST_KDF = { N: 1 << 10, r: 8, p: 1, dklen: 32 };
const PASSPHRASE = 'correct horse battery staple';

function makeWallet() {
  const kp = generateAgentKeyPair();
  return {
    privateKey: kp.privateKey,
    address: kp.address,
    publicKey: kp.publicKey,
    walletId: `wallet_aw_${randomBytes(6).toString('hex')}`,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-keystore-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('encrypt/decrypt round-trip', () => {
  it('recovers the exact private key, address, public key, and wallet id', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });

    const decrypted = decryptKeystore(ks, PASSPHRASE);
    expect(decrypted.privateKey).toBe(w.privateKey.toLowerCase().replace(/^0x/, ''));
    expect(decrypted.address).toBe(w.address);
    expect(decrypted.walletId).toBe(w.walletId);
  });

  it('never stores the private key in cleartext anywhere in the document', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const serialized = JSON.stringify(ks).toLowerCase();
    expect(serialized).not.toContain(w.privateKey.toLowerCase());
  });

  it('preserves a 128-hex no-prefix public key whose x coordinate begins 04', () => {
    const w = makeWallet();
    const leading04 = `04${w.publicKey.slice(2)}`;
    const ks = encryptKeystore({
      ...w,
      publicKey: leading04,
      passphrase: PASSPHRASE,
      kdfParams: FAST_KDF,
    });
    expect(ks.public_key).toBe(leading04);
    expect(ks.public_key).toHaveLength(128);
  });

  it('uses AES-256-GCM and a fresh salt + iv per encryption', () => {
    const w = makeWallet();
    const a = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const b = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    expect(a.crypto.cipher).toBe('aes-256-gcm');
    expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt);
    expect(a.crypto.iv).not.toBe(b.crypto.iv);
    expect(a.crypto.ciphertext).not.toBe(b.crypto.ciphertext);
  });

  it('round-trips through disk with 0600 permissions', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const file = path.join(tmpDir, 'agent-keystore.json');
    saveKeystore(ks, file);

    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    const loaded = loadKeystore(file) as AgentKeystore;
    expect(decryptKeystore(loaded, PASSPHRASE).privateKey).toBe(
      w.privateKey.toLowerCase().replace(/^0x/, ''),
    );
  });

  it('persistAgentWalletKey encrypts and writes in one call', () => {
    const w = makeWallet();
    const file = path.join(tmpDir, 'agent-keystore.json');
    const { keystore, path: written } = persistAgentWalletKey({
      ...w,
      passphrase: PASSPHRASE,
      filePath: file,
      kdfParams: FAST_KDF,
    });
    expect(written).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(decryptKeystore(keystore, PASSPHRASE).address).toBe(w.address);
  });
});

describe('export / recovery round-trip', () => {
  it('exports an encrypted backup and recovers the wallet from it', () => {
    const w = makeWallet();
    const localFile = path.join(tmpDir, 'agent-keystore.json');
    persistAgentWalletKey({ ...w, passphrase: PASSPHRASE, filePath: localFile, kdfParams: FAST_KDF });

    // Operator copies the encrypted keystore off-device.
    const backup = path.join(tmpDir, 'backup', 'agent-keystore.backup.json');
    exportKeystore(backup, localFile);
    expect(fs.existsSync(backup)).toBe(true);

    // Simulate device loss: wipe the local keystore.
    fs.rmSync(localFile);
    expect(loadKeystore(localFile)).toBeNull();

    // Recover into a fresh location from the backup.
    const recoveredFile = path.join(tmpDir, 'recovered', 'agent-keystore.json');
    const recovered = importKeystore(backup, PASSPHRASE, recoveredFile);
    expect(recovered.wallet_id).toBe(w.walletId);
    expect(fs.existsSync(recoveredFile)).toBe(true);

    const decrypted = decryptKeystore(loadKeystore(recoveredFile) as AgentKeystore, PASSPHRASE);
    expect(decrypted.privateKey).toBe(w.privateKey.toLowerCase().replace(/^0x/, ''));
    expect(decrypted.address).toBe(w.address);
  });

  it('imports from a JSON string as well as a file path', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const dest = path.join(tmpDir, 'from-string.json');
    const recovered = importKeystore(JSON.stringify(ks), PASSPHRASE, dest);
    expect(recovered.address).toBe(w.address);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('export throws when there is no keystore to export', () => {
    expect(() => exportKeystore(path.join(tmpDir, 'x.json'), path.join(tmpDir, 'missing.json')))
      .toThrowError(/No keystore found/);
  });
});

describe('wrong-passphrase failure', () => {
  it('throws WRONG_PASSPHRASE on decrypt with the wrong passphrase', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    try {
      decryptKeystore(ks, 'not the passphrase');
      throw new Error('expected decrypt to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProvianError);
      expect((e as ProvianError).code).toBe('WRONG_PASSPHRASE');
    }
  });

  it('rejects recovery (import) when the passphrase is wrong', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const dest = path.join(tmpDir, 'should-not-exist.json');
    expect(() => importKeystore(ks, 'wrong passphrase', dest)).toThrowError(/wrong passphrase/i);
    expect(fs.existsSync(dest)).toBe(false); // not installed on failure
  });

  it('refuses to encrypt with a weak passphrase', () => {
    const w = makeWallet();
    expect(() => encryptKeystore({ ...w, passphrase: 'short', kdfParams: FAST_KDF }))
      .toThrowError(/at least 8/);
  });
});

describe('tamper detection', () => {
  it('fails authentication when the ciphertext is altered', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const flipped = ks.crypto.ciphertext.slice(0, -2) + (ks.crypto.ciphertext.endsWith('00') ? '01' : '00');
    const tampered: AgentKeystore = { ...ks, crypto: { ...ks.crypto, ciphertext: flipped } };
    expect(() => decryptKeystore(tampered, PASSPHRASE)).toThrowError(ProvianError);
  });

  it('fails when the bound header (address) is swapped - AAD mismatch', () => {
    const w = makeWallet();
    const other = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    const swapped: AgentKeystore = { ...ks, address: other.address };
    expect(() => decryptKeystore(swapped, PASSPHRASE)).toThrowError(/wrong passphrase or corrupted/i);
  });

  it('rejects an unrecognized keystore shape', () => {
    expect(() => decryptKeystore({ version: 99 } as unknown as AgentKeystore, PASSPHRASE))
      .toThrowError(/malformed keystore/i);
  });
});

describe('F34: file-supplied scrypt params are bounded before the KDF', () => {
  function validKeystore(): AgentKeystore {
    const w = makeWallet();
    return encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
  }

  it('[RED] rejects an out-of-range N (2^22) FAST — INVALID_KEYSTORE before any KDF, never WRONG_PASSPHRASE', () => {
    const ks = validKeystore();
    ks.crypto.kdfparams.N = 1 << 22; // ~4.3 GB working set pre-fix
    const started = Date.now();
    let code = '';
    try {
      decryptKeystore(ks, PASSPHRASE);
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as ProvianError).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    // Rejected by the bounds check (INVALID_KEYSTORE), NOT by a completed KDF
    // (which would surface WRONG_PASSPHRASE and take seconds + gigabytes).
    expect(code).toBe('INVALID_KEYSTORE');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a non-power-of-two N', () => {
    const ks = validKeystore();
    ks.crypto.kdfparams.N = 100000;
    expect(() => decryptKeystore(ks, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
  });

  it('rejects N below the floor and above the ceiling', () => {
    const low = validKeystore();
    low.crypto.kdfparams.N = 512; // < 1024
    expect(() => decryptKeystore(low, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
    const high = validKeystore();
    high.crypto.kdfparams.N = 1 << 18; // > 2^17 ceiling
    expect(() => decryptKeystore(high, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
  });

  it('rejects an over-large r, over-large p, wrong dklen, and a malformed salt', () => {
    const badR = validKeystore(); badR.crypto.kdfparams.r = 64;
    expect(() => decryptKeystore(badR, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
    const badP = validKeystore(); badP.crypto.kdfparams.p = 99;
    expect(() => decryptKeystore(badP, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
    const badDklen = validKeystore(); badDklen.crypto.kdfparams.dklen = 64;
    expect(() => decryptKeystore(badDklen, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
    const badSalt = validKeystore(); badSalt.crypto.kdfparams.salt = 'zz';
    expect(() => decryptKeystore(badSalt, PASSPHRASE)).toThrowError(/out of the allowed bounds/i);
  });

  it('[positive] an in-bounds keystore still decrypts', () => {
    const w = makeWallet();
    const ks = encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: FAST_KDF });
    expect(decryptKeystore(ks, PASSPHRASE).address).toBe(w.address);
  });

  it('encryptKeystore refuses to mint an out-of-bounds keystore', () => {
    const w = makeWallet();
    expect(() => encryptKeystore({ ...w, passphrase: PASSPHRASE, kdfParams: { N: 1 << 22, r: 8, p: 1, dklen: 32 } }))
      .toThrowError(/out of the allowed bounds/i);
  });
});
