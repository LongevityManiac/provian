import { Wallet, Transaction, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { readAgreedBaseHead, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { currentProtocolDeployment } from '../protocol/runtime';
import { estimateBaseTransactionFees } from './base-transaction-fees';
interface GasPlan { readonly executor:string; readonly calldata:string; readonly manifestHash:string; }
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('recourse_binding_rpc_invalid');
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_binding_rpc_invalid');
  return value as Record<string, unknown>;
}
export function createRecourseGasSigner<T extends GasPlan>(wallet: Pick<Wallet,'address'|'signTransaction'>, assertPlan: (plan:T)=>void): { readonly address:string; sign(plan:T):Promise<string>; broadcast(raw:string):Promise<string> } {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const number = async (method: string, params: readonly unknown[]) => {
    const values = await Promise.all(legs.map(async leg => quantity(await leg.provider.send(method, [...params]))));
    if (values[0] !== values[1]) throw new Error('recourse_binding_rpc_disagreement');
    return values[0];
  };
  const nonce = async () => {
    const [latest, pending] = await Promise.all([number('eth_getTransactionCount', [wallet.address, 'latest']),
      number('eth_getTransactionCount', [wallet.address, 'pending'])]);
    if (latest !== pending || latest > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('recourse_binding_nonce_busy');
    return Number(latest);
  };
  return { address: wallet.address.toLowerCase(), async sign(plan) {
    assertPlan(plan);
    if ((await currentProtocolDeployment()).manifestHash !== plan.manifestHash) throw new Error('recourse_binding_operation_retired');
    const transactionNonce = await nonce();
    const height = await readAgreedBaseHead(), hash = await readAgreedBaseBlockHash(height);
    if (!hash) throw new Error('recourse_binding_block_unavailable');
    const blocks = await Promise.all(legs.map(async leg => object(await leg.provider.send('eth_getBlockByHash', [hash, false]))));
    const baseFee = quantity(blocks[0].baseFeePerGas), blockGas = quantity(blocks[0].gasLimit);
    if (blocks.some(block => block.hash !== hash || quantity(block.baseFeePerGas) !== baseFee || quantity(block.gasLimit) !== blockGas)) {
      throw new Error('recourse_binding_rpc_disagreement');
    }
    const estimates = await Promise.all(legs.map(async leg => quantity(await leg.provider.send('eth_estimateGas', [
      { from: wallet.address, to: plan.executor, data: plan.calldata, value: '0x0' }, `0x${height.toString(16)}`]))));
    const gasLimit = ((estimates[0] > estimates[1] ? estimates[0] : estimates[1]) * 120n + 99n) / 100n;
    if (gasLimit <= 0n || gasLimit > blockGas) throw new Error('recourse_binding_gas_invalid');
    const maxPriorityFeePerGas = 1_000_000n, maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    const prepared = { chainId: 8453, type: 2, nonce: transactionNonce, to: plan.executor,
      data: plan.calldata, value: 0, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
    const fees = await estimateBaseTransactionFees(legs.map(leg => ({ operatorId: leg.operatorId,
      request: (method, params) => leg.provider.send(method, [...params]) })), prepared, hash);
    if (await number('eth_getBalance', [wallet.address, { blockHash: hash, requireCanonical: true }]) < fees.totalEstimateWei) {
      throw new Error('recourse_binding_gas_unavailable');
    }
    if (await nonce() !== transactionNonce || await readAgreedBaseBlockHash(height) !== hash) throw new Error('recourse_binding_state_changed');
    return wallet.signTransaction(prepared);
  }, async broadcast(raw) {
    const tx = Transaction.from(raw), hash = keccak256(raw);
    if (tx.from?.toLowerCase() !== wallet.address.toLowerCase() || tx.chainId !== 8453n) throw new Error('recourse_binding_signed_mismatch');
    const existing = await Promise.all(legs.map(leg => leg.provider.send('eth_getTransactionByHash', [hash])));
    if (existing.every(value => value !== null && object(value).hash === hash)) return hash;
    if (await nonce() !== tx.nonce) throw new Error('recourse_binding_nonce_busy');
    if (await legs[0].provider.send('eth_sendRawTransaction', [raw]) !== hash) throw new Error('recourse_binding_broadcast_mismatch');
    return hash;
  } };
}
