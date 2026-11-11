import { Interface, formatUnits, getAddress, parseUnits } from 'ethers';
import { assertCurrentProtocolTransaction } from '../protocol/transaction';
import type { OwnerChainNetwork } from './owner-chain';
import type { HumanHashTransferIntent } from './human-hash-transfer';
const tokenAbi = new Interface(['function transfer(address,uint256)', 'function transferCurrent(address,uint256,uint256)',
  'function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function balanceOf(address) view returns(uint256)']);
export interface HumanTransferReview {
  readonly intent: HumanHashTransferIntent; readonly recipient: string; readonly token: string | null;
  readonly symbol: string; readonly decimals: number; readonly amount: string; readonly balance: string;
}
async function tokenDetails(token: string, account: string, network: OwnerChainNetwork) {
  const deployment = await network.deployment();
  const rows = await Promise.all(network.rpcs.map(async rpc => {
    const call = async (name: string, args: readonly string[] = []) => {
      const raw = await rpc.request('eth_call', [{ to: token, data: tokenAbi.encodeFunctionData(name, args) },
        { blockHash: deployment.blockHash, requireCanonical: true }]);
      if (typeof raw !== 'string') throw Error('recourse_transfer_metadata_unavailable');
      return tokenAbi.decodeFunctionResult(name, raw)[0];
    };
    const decimals = Number(await call('decimals')), symbol: unknown = await call('symbol'), balance = String(await call('balanceOf', [account]));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || typeof symbol !== 'string' || !symbol || symbol.length > 64) throw Error('recourse_transfer_metadata_invalid');
    return { decimals, symbol, balance };
  }));
  if (JSON.stringify(rows[0]) !== JSON.stringify(rows[1])) throw Error('recourse_transfer_metadata_disagreement');
  return { ...rows[0], manifestHash: deployment.manifestHash };
}
/** Decode only the exact native/token transfer shown by the first-party screen.
 * Metadata comes from two readers at the same canonical block, never a ticker
 * supplied in navigation or cached decimals from a different network. */
export async function describeHumanTransfer(intent: HumanHashTransferIntent, network: OwnerChainNetwork): Promise<HumanTransferReview> {
  if (!/^0x[0-9a-f]{40}$/.test(intent.account) || !/^0x[0-9a-f]{40}$/.test(intent.target)) throw Error('recourse_transfer_invalid');
  if (intent.data === '0x') {
    if (!/^[1-9][0-9]*$/.test(intent.value) || BigInt(intent.value) >= 2n ** 256n) throw Error('recourse_transfer_invalid');
    const deployment = await network.deployment();
    const balances = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBalance', [intent.account, { blockHash: deployment.blockHash, requireCanonical: true }])));
    if (typeof balances[0] !== 'string' || !/^0x[0-9a-f]+$/i.test(balances[0]) || balances[0] !== balances[1]) throw Error('recourse_transfer_balance_disagreement');
    return { intent, recipient: intent.target, token: null, symbol: 'ETH', decimals: 18, amount: formatUnits(intent.value, 18), balance: formatUnits(BigInt(balances[0]), 18) };
  }
  const call = tokenAbi.parseTransaction({ data: intent.data });
  if (intent.value !== '0' || !call || !['transfer', 'transferCurrent'].includes(call.name)
    || tokenAbi.encodeFunctionData(call.name, call.args) !== intent.data || BigInt(call.args[1]) <= 0n) throw Error('recourse_transfer_invalid');
  const details = await tokenDetails(intent.target, intent.account, network);
  return { intent, recipient: String(call.args[0]).toLowerCase(), token: intent.target, symbol: details.symbol, decimals: details.decimals,
    amount: formatUnits(call.args[1], details.decimals), balance: formatUnits(details.balance, details.decimals) };
}
export async function prepareHumanTransferReview(input: {
  readonly id: string; readonly account: string; readonly auxiliaryBinding: string | null;
  readonly recipient: string; readonly token: string | null; readonly amount: string;
}, network: OwnerChainNetwork): Promise<HumanTransferReview> {
  // Own all form values before the first network await.
  const value = { ...input }, account = getAddress(value.account).toLowerCase(), recipient = getAddress(value.recipient).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value.id) || /^0x0+$/.test(recipient) || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.amount)) throw Error('recourse_transfer_invalid');
  const deployment = await network.deployment(), token = value.token === null ? null : getAddress(value.token).toLowerCase();
  const details = token ? await tokenDetails(token, account, network) : null;
  if (details && details.manifestHash !== deployment.manifestHash) throw Error('recourse_transfer_state_changed');
  const amount = parseUnits(value.amount, details?.decimals ?? 18);
  if (amount <= 0n || amount >= 2n ** 256n) throw Error('recourse_transfer_invalid');
  const currentPvt = token === deployment.addresses.kernel.toLowerCase();
  const intent: HumanHashTransferIntent = { id: value.id, account, auxiliaryBinding: value.auxiliaryBinding,
    target: token ?? recipient, value: token ? '0' : String(amount), data: token ? tokenAbi.encodeFunctionData(currentPvt ? 'transferCurrent' : 'transfer',
      currentPvt ? [recipient, amount, deployment.revision] : [recipient, amount]) : '0x' };
  const observed = await assertCurrentProtocolTransaction(network, intent.target, intent.data);
  if (observed.manifestHash !== deployment.manifestHash) throw Error('recourse_transfer_state_changed');
  const review = await describeHumanTransfer(intent, network);
  if (parseUnits(review.balance, review.decimals) < amount) throw Error('recourse_transfer_insufficient_balance');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_transfer_state_changed');
  return review;
}
