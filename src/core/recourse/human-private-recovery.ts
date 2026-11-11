import RelayAPIService from '../../services/RelayAPIService';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';

export async function requestHumanRecoveryData(mnemonic: string, identity: string, generation: number, path: string, body?: unknown): Promise<unknown> {
  // Chain execution may precede the relay credential cut. Start with the
  // original registered backup; historical credentials retain private access.
  // A seed first bound at a later generation can try its observed predecessors.
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 0x80000000) throw Error('recourse_account_index_invalid');
  for (let candidate = 0; candidate <= generation; candidate++) {
    const secret = humanRecoverySecret(mnemonic, candidate, identity), signingSeed = humanRecoverySigningSeed(mnemonic, candidate, identity);
    try { return await RelayAPIService.recourseRecoveryRequest(path, body, { identity, secret, signingSeed }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'recourse_private_unavailable' || candidate === generation) throw error;
    } finally { secret.fill(0); signingSeed.fill(0); }
  }
  throw Error('recourse_private_unavailable');
}
