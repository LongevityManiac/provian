#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedFetch } from '../../provian-agent-sdk/dist/guarded-fetch.js';
import { buildSuccessionSnapshot } from './snapshot.mjs';
import { verifyInstitutionRuntime } from './institution-snapshot.mjs';
import { readPendingBreak } from './pending-break.mjs';
import { assembleSuccessionArtifact } from './break-artifacts.mjs';
import { buildPoolSnapshot } from './pool-snapshot.mjs';
import { buildBreakOwnershipSnapshot } from './break-snapshot.mjs';
import { resolveProtocolDeployment } from '../../provian-agent-sdk/dist/protocol-pointer.js';
import { Interface, keccak256 } from 'ethers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const quantity = value => `0x${BigInt(value).toString(16)}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
class RangeError extends Error {}
export function snapshotLogRangeRefusal(method, status, error) {
  if (method !== 'eth_getLogs' || status === 429 || !error || typeof error.message !== 'string') return false;
  if (/rate limit|request limit|requests per|quota/i.test(error.message)) return false;
  return /block.*range|range.*block|too many (?:logs|results)|(?:log|result|response).*?(?:limit|maximum|size)|limited to.*blocks|exceed.*(?:logs|results)/i.test(error.message);
}
function operator(url) {
  const u = new URL(url), host = u.hostname;
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('snapshot_rpc_transport');
  if (host === 'mainnet.base.org') return 'base';
  if (host === 'lb.drpc.live' || host === 'base.drpc.org' || host.endsWith('.drpc.org')) return 'drpc';
  if (host.endsWith('.alchemy.com')) return 'alchemy';
  if (host.endsWith('.publicnode.com')) return 'publicnode';
  throw Error('snapshot_rpc_operator_unknown');
}
export function snapshotRpcPort(urls, options = {}) {
  if (urls.length !== 2 || operator(urls[0]) === operator(urls[1])) throw Error('snapshot_independent_operators_required');
  const logWindowSize=options.logWindowSize??50_000;
  if(!Number.isSafeInteger(logWindowSize)||logWindowSize<1||logWindowSize>50_000)throw Error('snapshot_log_window_invalid');
  const queues = new Map(), nextRequests = new Map();
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function paced(url, action) {
    const previous = queues.get(url) ?? Promise.resolve();
    const ready = previous.catch(() => {}).then(async () => {
      await pause(Math.max(0, (nextRequests.get(url) ?? 0) - Date.now()));
      nextRequests.set(url, Date.now() + 1100);
    });
    queues.set(url, ready);
    await ready;
    return action();
  }
  async function rpc(url, method, params) {
    for (let attempt = 0; attempt < 8; ++attempt) {
      let httpStatus, rpcErrorCode;
      try {
        const response = await paced(url, () => guardedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000) }));
        httpStatus = response.status;
        const result = await response.json();
        if (typeof result.error?.code === 'number') rpcErrorCode = result.error.code;
        // Some operators report a range refusal as HTTP 400 rather than a
        // successful HTTP response containing a JSON-RPC error. Shrink only a
        // genuine log range; never fan out a rate limit into more requests.
        if (snapshotLogRangeRefusal(method, response.status, result.error)) throw new RangeError();
        if (!response.ok) throw Error('snapshot_rpc_http');
        if (result.error) {
          throw Error('snapshot_rpc_error');
        }
        // A receipt/transaction lookup is allowed to prove absence before broadcast.
        // State reads and missing JSON-RPC results must still fail closed.
        const absentTransaction = result.result === null
          && ['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(method);
        if (result.result === undefined || (result.result === null && !absentTransaction)) throw Error('snapshot_rpc_missing');
        return result.result;
      } catch (error) {
        if (error instanceof RangeError) throw error;
        if (attempt === 7) throw Object.assign(Error('snapshot_rpc_unavailable'), {
          snapshotRpcDiagnostic: { method, httpStatus, rpcErrorCode },
        });
        await pause(httpStatus === 429 ? Math.min(30_000, 5000 * 2 ** attempt) : 1000 * (attempt + 1));
      }
    }
  }
  async function agree(method, params) {
    const values = await Promise.all(urls.map(url => rpc(url, method, params)));
    // Provider-only transaction metadata may differ. Compare the fields consumed
    // by the exporter, preserving every binding to the canonical transaction.
    const projection = value => method === 'eth_getTransactionByHash'
      ? { hash: value.hash, blockHash: value.blockHash, to: value.to, input: value.input }
      : method === 'eth_getBlockByNumber' ? { number: value.number, hash: value.hash, parentHash: value.parentHash }
      : method === 'eth_getLogs' ? value.map(log => ({ address: log.address, blockNumber: log.blockNumber,
        blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex: log.transactionIndex,
        logIndex: log.logIndex, topics: log.topics, data: log.data, removed: log.removed === true })) : value;
    if (JSON.stringify(canonical(projection(values[0]))) !== JSON.stringify(canonical(projection(values[1])))) throw Error('snapshot_rpc_disagreement');
    return values[0];
  }
  async function range(address, from, to, topics) {
    try { return await agree('eth_getLogs', [{ address, fromBlock: quantity(from), toBlock: quantity(to), ...(topics ? { topics } : {}) }]); }
    catch (error) {
      if (!(error instanceof RangeError) || from === to) throw error;
      const mid = Math.floor((from + to) / 2);
      return [...await range(address, from, mid, topics), ...await range(address, mid + 1, to, topics)];
    }
  }
  return {
    rpcs: urls.map(url => ({ operatorId: operator(url), request: (method, params) => rpc(url, method, params) })),
    async finalizedBlock() {
      if (await agree('eth_chainId', []) !== '0x2105') throw Error('snapshot_wrong_chain');
      const finals = await Promise.all(urls.map(url => rpc(url, 'eth_getBlockByNumber', ['finalized', false])));
      const height = Math.min(...finals.map(b => Number(BigInt(b.number))));
      const block = await agree('eth_getBlockByNumber', [quantity(height), false]);
      return { number: height, hash: block.hash };
    },
    async blockHash(block) { return (await agree('eth_getBlockByNumber', [quantity(block), false])).hash; },
    call(to, data, blockHash) { return agree('eth_call', [{ to, data }, { blockHash, requireCanonical: true }]); },
    code(to, blockHash) { return agree('eth_getCode', [to, { blockHash, requireCanonical: true }]); },
    transaction(hash) { return agree('eth_getTransactionByHash', [hash]); },
    async logs(address, from, to, topics) {
      const results = [];
      // Bound in-flight work while preserving canonical range order. Each
      // operator is independently paced, including retries and range splits.
      for (let batch = from; batch <= to; batch += logWindowSize*4) {
        const windows = [];
        for (let start = batch; start <= Math.min(batch + logWindowSize*4-1, to); start += logWindowSize) {
          windows.push({ start, end: Math.min(start + logWindowSize-1, to) });
        }
        const pages = await Promise.all(windows.map(window => range(address, window.start, window.end, topics)));
        for (let index = 0; index < windows.length; ++index) {
          results.push(...pages[index]);
          options.onLogRange?.({ from: windows[index].start, through: windows[index].end, target: to, logs: results.length });
        }
      }
      return results.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    },
  };
}

/** An explicit first-cutover read can precede pointer deployment/publication.
 * It is never a general fallback from a missing or retired current manifest. */
export async function firstSuccessionInventoryAllowed(plan,pin,port,currentBlockHash){
  if(plan.firstSuccession!==true)return false;
  if(plan.mode==='cryptographic-break'||!pin.address||!pin.runtimeHash)throw Error('snapshot_first_succession_invalid');
  const code=await port.code(pin.address,currentBlockHash);
  if(code==='0x')return true;
  if(keccak256(code)!==pin.runtimeHash)throw Error('snapshot_pointer_runtime_mismatch');
  const abi=new Interface(['function revision() view returns(uint256)']);
  const revision=abi.decodeFunctionResult('revision',await port.call(pin.address,abi.encodeFunctionData('revision'),currentBlockHash))[0];
  if(revision!==0n)throw Error('snapshot_first_succession_already_published');
  return true;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw Error('snapshot_usage_plan_json_output_json');
  const plan = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
  if (!plan.predecessor || !Number.isSafeInteger(plan.deploymentBlock) || plan.deploymentBlock < 1) throw Error('snapshot_plan_invalid');
  const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://mainnet.base.org', process.env.BASE_RPC_URL_SECONDARY ?? process.env.BASE_RPC_SECONDARY_URL ?? 'https://base.drpc.org']);
  const finalized = await port.finalizedBlock();
  const block = plan.block ?? finalized.number;
  if (!Number.isSafeInteger(block) || block > finalized.number || block < plan.deploymentBlock) throw Error('snapshot_unfinalized_block');
  const blockHash = await port.blockHash(block);
  const canonicalDeployment = JSON.parse(readFileSync(resolve(root, 'contracts/deployments/base-pvt9-institutions.json'), 'utf8'));
  const pin = JSON.parse(readFileSync(resolve(root, 'config/protocol-pointer.json'), 'utf8'));
  const firstSuccession=await firstSuccessionInventoryAllowed(plan,pin,port,finalized.hash);
  let artifact, institutions, expectedRuntimeHash, poolRuntimeHash;
  if (pin.address && pin.runtimeHash && !firstSuccession) {
    const deployment = await resolveProtocolDeployment(port.rpcs, pin.address, pin.runtimeHash);
    if (plan.predecessor.toLowerCase() !== deployment.addresses.kernel.toLowerCase()) throw Error('snapshot_canonical_predecessor_mismatch');
    artifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/ProvianRecourseKernel.sol/ProvianRecourseKernel.json'), 'utf8'));
    institutions = ['escrow','promises','projectPool','bonds','court','recoursePool'].map(k=>deployment.addresses[k]);
    expectedRuntimeHash = deployment.runtimeHashes[0];
    poolRuntimeHash = deployment.runtimeHashes[8];
  } else {
    if (plan.mode === 'cryptographic-break'
      || plan.predecessor.toLowerCase() !== canonicalDeployment.wiring.pvt.toLowerCase()
      || plan.deploymentBlock !== canonicalDeployment.successorKernel.pvt9Kernel.block) throw Error('snapshot_canonical_predecessor_mismatch');
    artifact = JSON.parse(readFileSync(resolve(root, 'contracts/out/ProvianPVT9.sol/ProvianPVT9.json'), 'utf8'));
    institutions = ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'].map(key => canonicalDeployment.contracts[key].address);
    expectedRuntimeHash = verifyInstitutionRuntime(artifact, await port.code(plan.predecessor, blockHash));
  }
  const priorArtifact = plan.priorSnapshotFile ? JSON.parse(readFileSync(resolve(plan.priorSnapshotFile),'utf8')) : undefined;
  const priorSnapshot = priorArtifact?.monetary ?? priorArtifact;
  const monetary = await buildSuccessionSnapshot({ ...plan, priorSnapshot, block, blockHash, port, kernelAbi: artifact.abi,
    expectedRuntimeHash, institutions });
  const pendingBreak = poolRuntimeHash ? await readPendingBreak({port,kernel:plan.predecessor,blockHash,artifact:priorArtifact}) : null;
  const pool = poolRuntimeHash ? await buildPoolSnapshot({port,pool:institutions[5],kernel:plan.predecessor,
    block,blockHash,deploymentBlock:plan.poolDeploymentBlock,expectedRuntimeHash:poolRuntimeHash}) : undefined;
  let ownership;
  if (plan.mode === 'cryptographic-break') {
    ownership = await buildBreakOwnershipSnapshot({ port, predecessor: plan.predecessor, block, blockHash,
      expectedKernelRuntimeHash: expectedRuntimeHash, registryDeploymentBlock: plan.registryDeploymentBlock,
      expectedRegistryRuntimeHash: plan.expectedRegistryRuntimeHash, pendingBreak,
      institutions: institutions.map(source=>({ source, destination: plan.destinations?.[source.toLowerCase()],
        runtimeHash: plan.institutionRuntimeHashes?.[source.toLowerCase()] })) });
  }
  const snapshot = assembleSuccessionArtifact({ monetary, pool, ownership, pendingBreak, priorArtifact });
  const target = resolve(args[1]);
  writeFileSync(`${target}.tmp`, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify({ block, blockHash, format: snapshot.format, counts: monetary.counts,
    balanceRoot: snapshot.ownership?.root ?? monetary.balanceRoot, historyRoot: monetary.historyRoot }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^snapshot_[a-z_]+$/.test(error.message) ? error.message : 'snapshot_refused'); process.exitCode = 1; });
}
