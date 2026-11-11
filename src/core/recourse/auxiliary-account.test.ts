import { expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { auxiliaryAccountKey } from './auxiliary-account';
import { deriveHumanAccount } from './human-account';
import { bytesToHex } from '@noble/hashes/utils';

const mnemonic = 'test test test test test test test test test test test junk';
const h = (b: string) => `0x${b.repeat(32)}`;
it('reconstructs each successor from the seed and separates siblings, generations and primary keys', async () => {
  const keys = await Promise.all([[h('11'), 1], [h('12'), 1], [h('11'), 2], [h('11'), 1]].map(
    ([identity, generation]) => auxiliaryAccountKey(mnemonic, String(identity), Number(generation))));
  try {
    const addresses = keys.map(key => new Wallet(`0x${bytesToHex(key)}`).address.toLowerCase());
    expect(new Set(addresses.slice(0, 3)).size).toBe(3); expect(addresses[3]).toBe(addresses[0]);
    expect(addresses).not.toContain((await deriveHumanAccount(mnemonic, 1)).evm);
    for (const [identity, generation] of [[h('00'), 1], [h('11'), 0], [h('11'), 0x80000000], ['invalid', 1]]) {
      await expect(auxiliaryAccountKey(mnemonic, String(identity), Number(generation))).rejects.toThrow('invalid');
    }
  } finally { keys.forEach(key => key.fill(0)); }
});
