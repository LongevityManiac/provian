import { assertBaseTransactionGasLimit } from './transaction-gas-limit.mjs';
import { Transaction, toQuantity } from 'ethers';
const ensure = (value, reason) => { if (!value) throw Error('copy_port_' + reason); };
const writes = new Set(['anvil_impersonateAccount', 'anvil_setBalance', 'anvil_mine', 'evm_snapshot', 'evm_revert',
  'eth_sendTransaction', 'eth_sendRawTransaction']);
const reads = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getBlockByHash', 'eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getLogs', 'eth_getBalance', 'eth_gasPrice']);
/** Explicit simulator-only transport. A Base chain ID is insufficient: every
 * write re-authenticates the exact local Anvil instance and fork. This module
 * is never selectable by a production delivery command. */
export function isolatedCopyPort({ url, instanceId, forkHash, fetcher = fetch }) {
  const parsed = new URL(url);
  ensure(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port
    && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password, 'local_url_required');
  ensure(/^0x[0-9a-f]{64}$/.test(instanceId) && /^0x[0-9a-f]{64}$/.test(forkHash), 'identity_required');
  let nextId = 0;
  const rpc = async (method, params) => {
    const response = await fetcher(parsed.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }) });
    const reply = await response.json();
    if (!response.ok || reply.error || !Object.hasOwn(reply, 'result')) {
      const retryable = response.status === 429 || /\b429\b|rate limit|request limit/i.test(reply.error?.message ?? '');
      throw Object.assign(Error(retryable ? 'copy_port_rate_limit' : 'copy_port_rpc_refused'),
        { copyDiagnostic: { method, httpStatus: response.status, rpcCode: reply.error?.code } });
    }
    return reply.result;
  };
  const verify = async () => {
    const metadata = await rpc('anvil_metadata', []);
    ensure(metadata.instanceId === instanceId && metadata.chainId === 8453
      && metadata.forkedNetwork?.chainId === 8453 && metadata.forkedNetwork.forkBlockHash === forkHash, 'instance_changed');
    ensure(await rpc('eth_chainId', []) === toQuantity(8453), 'chain_changed'); return metadata;
  };
  const request = async (method, params = []) => {
    ensure(reads.has(method) || writes.has(method), 'method_refused');
    if (writes.has(method)) await verify();
    if (method === 'eth_sendTransaction') {
      ensure(typeof params[0]?.gas === 'string', 'explicit_gas_required');
      assertBaseTransactionGasLimit(BigInt(params[0].gas));
    }
    if (method === 'eth_sendRawTransaction') assertBaseTransactionGasLimit(Transaction.from(params[0]).gasLimit);
    return rpc(method, params);
  };
  return { verify, request };
}
