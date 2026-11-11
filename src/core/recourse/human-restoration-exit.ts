import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';
import { ActionWallet } from '../security/ActionWallet';
import { assertBiometricAction, withBiometricAction } from '../security/biometricAction';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { currentProtocolDeployment, ownerChainNetwork } from '../protocol/runtime';
import { translate } from '../../i18n/translate';
import { humanAccountPaths } from './human-account';
import { prepareRestorationExit } from './restoration-exit';

/** Permissionless delivery uses the original EOA only as a gas sender. It never
 * selects a PVT recipient, signs for the recovered account or changes the wallet
 * selection. The gas sender requires ETH; its curve key does not protect funds
 * after a curve break. The allocated PVT stays protected by the pool's destination. */
export async function withdrawHumanRestoration(identity: string, request: string): Promise<string> {
  return withBiometricAction(translate('recourse.authorize', 'Authorize your Recourse action'), async action => {
    const exit = await prepareRestorationExit(identity, request, ownerChainNetwork());
    // This narrowly scoped transport remains usable with a hash account selected.
    // Never replace the active owner's key accessor with a curve fallback.
    const mnemonic = await SeedManager.getMnemonic(action);
    if (!mnemonic) throw new Error('recourse_seed_unavailable');
    const seed = await mnemonicToSeedPaced(mnemonic);
    let root: HDKey | undefined, key: HDKey | undefined;
    try {
      root = HDKey.fromMasterSeed(seed);
      key = root.derive(humanAccountPaths(0).evm);
      if (!key.privateKey) throw new Error('recourse_gas_key_unavailable');
      assertBiometricAction(action);
      const signer = new ActionWallet('0x' + bytesToHex(key.privateKey), action, TransactionService.providerFor(8453));
      if ((await currentProtocolDeployment()).manifestHash !== exit.manifestHash) throw new Error('protocol_pointer_changed');
      const tx = await signer.sendTransaction({ to: exit.pool, chainId: 8453, value: 0n, data: exit.data });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('recourse_transaction_not_confirmed');
      return tx.hash;
    } finally { seed.fill(0); key?.wipePrivateData(); root?.wipePrivateData(); }
  });
}
