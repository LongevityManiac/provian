import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';

/** Each bound address gets its own successor key domain. Neither a sibling
 * binding nor a primary-wallet account index can select the same key. The
 * existing encrypted seed backup reconstructs these keys without a new secret. */
export async function auxiliaryAccountKey(mnemonic: string, identity: string, generation: number): Promise<Uint8Array> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || /^0x0+$/.test(identity)
    || !Number.isSafeInteger(generation) || generation < 1 || generation >= 0x80000000) throw Error('recourse_auxiliary_account_invalid');
  const seed = await mnemonicToSeedPaced(mnemonic);
  try {
    for (let attempt = 0; Number.isSafeInteger(attempt); attempt++) {
      const key = hkdf(sha256, seed, utf8ToBytes('provian.human.auxiliary.account.v1'),
        utf8ToBytes(JSON.stringify(['8453', identity, generation, attempt])), 32);
      if (secp256k1.utils.isValidPrivateKey(key)) return key;
      key.fill(0);
    }
    throw Error('recourse_auxiliary_account_derivation_failed');
  } finally { seed.fill(0); }
}
