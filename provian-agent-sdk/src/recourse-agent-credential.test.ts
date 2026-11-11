import { expect, test } from 'vitest';
import { encryptKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { withBoundRecoveryMaterial } from './recourse-agent-credential';
const passphrase = 'TEST ONLY independent address credentials';
const rootSecret = '31'.repeat(32), rootSeed = '32'.repeat(32);
const key = generateAgentKeyPair();
const keystore = encryptKeystore({ ...key, walletId: 'wallet_aw_address_credential_test', passphrase,
  recoverySecret: rootSecret, recoverySigningSeed: rootSeed, kdfParams: { N: 1024, r: 8, p: 1, dklen: 32 } });
test('one encrypted root reconstructs independent address credentials without revealing either root or curve key', async () => {
  const outputs: string[] = [];
  for (const binding of ['41', '42']) {
    const id = `0x${binding.repeat(32)}`;
    const read = () => withBoundRecoveryMaterial(keystore, passphrase, id,
      (secret, seed) => [Buffer.from(secret).toString('hex'), Buffer.from(seed).toString('hex')]);
    const pair = await read(); expect(await read()).toEqual(pair); outputs.push(...pair);
  }
  expect(new Set(outputs).size).toBe(4);
  for (const value of outputs) {
    expect(value).not.toBe(rootSecret); expect(value).not.toBe(rootSeed);
    expect(value).not.toBe(key.privateKey.replace(/^0x/, ''));
  }
});
test('derived buffers are erased on success and failure and bad credentials never enter callback', async () => {
  const retained: Uint8Array[] = [];
  for (const fail of [false, true]) {
    const run = withBoundRecoveryMaterial(keystore, passphrase, `0x${'41'.repeat(32)}`, (secret, seed) => {
      retained.push(secret, seed); if (fail) throw Error('callback_failure'); return 1;
    });
    if (fail) await expect(run).rejects.toThrow('callback_failure'); else expect(await run).toBe(1);
  }
  expect(retained).toHaveLength(4); for (const value of retained) expect(value.every(byte => byte === 0)).toBe(true);
  let calls = 0;
  await expect(withBoundRecoveryMaterial(keystore, 'wrong passphrase', `0x${'41'.repeat(32)}`, () => { calls++; })).rejects.toThrow();
  await expect(withBoundRecoveryMaterial(keystore, passphrase, `0x${'00'.repeat(32)}`, () => { calls++; })).rejects.toThrow();
  expect(calls).toBe(0);
});
