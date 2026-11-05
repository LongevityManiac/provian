import { ethers } from 'ethers';

import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import {
  callExternalProofEip1271,
  readExternalProofCode,
  readExternalProofNonce,
  revalidateExternalProofFence,
  selectExternalProofFence,
} from './proof-head';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOCK_HASH = `0x${'11'.repeat(32)}`;
const PARENT_HASH = `0x${'22'.repeat(32)}`;
const STATE_ROOT = `0x${'33'.repeat(32)}`;
const DIGEST = `0x${'44'.repeat(32)}`;
const SIGNATURE = `0x${'55'.repeat(65)}`;
const iface = new ethers.Interface([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

interface Responses {
  chainId: string;
  head: string;
  block: Record<string, unknown>;
  code: string;
  nonce: string;
  call: string;
}

function responses(): Responses {
  return {
    chainId: quantity(8453),
    head: quantity(1_000),
    block: {
      number: quantity(989),
      hash: BLOCK_HASH,
      parentHash: PARENT_HASH,
      stateRoot: STATE_ROOT,
    },
    code: '0x6001600055',
    nonce: '0x7',
    call: iface.encodeFunctionResult('isValidSignature', ['0x1626ba7e']),
  };
}

function rpcLeg(
  operatorId: string,
  state: Responses,
  calls: Array<{ method: string; params: readonly unknown[] }> = [],
): EconomicStateRpcLeg {
  return {
    operatorId,
    send: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId': return state.chainId;
        case 'eth_blockNumber': return state.head;
        case 'eth_getBlockByNumber': return structuredClone(state.block);
        case 'eth_getCode': return state.code;
        case 'eth_getTransactionCount': return state.nonce;
        case 'eth_call': return state.call;
        default: throw new Error(`unexpected_method:${method}`);
      }
    },
  };
}

function legs(
  left = responses(),
  right = structuredClone(left),
  calls: Array<{ method: string; params: readonly unknown[] }> = [],
): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  return [rpcLeg('operator-a', left, calls), rpcLeg('operator-b', right, calls)];
}

describe('external-wallet exact proof head', () => {
  it('selects a two-operator block exactly 12 deep and fences at agreed latest + 1', async () => {
    const evidence = await selectExternalProofFence({ rpcLegs: legs() });
    expect(evidence).toEqual({
      schemaVersion: 'external-proof-fence/v1',
      chainId: 8453,
      observedHeadBlock: 1_000,
      proofBlockNumber: 989,
      proofBlockHash: BLOCK_HASH,
      provenAtBlock: 1_001,
      minActivityConfirmations: 12,
      rpcOperatorIds: ['operator-a', 'operator-b'],
    });
  });

  it('rejects latest-head disagreement and a reorged exact block', async () => {
    const left = responses();
    const stale = responses();
    stale.head = quantity(999);
    await expect(selectExternalProofFence({ rpcLegs: legs(left, stale) })).rejects.toThrow(
      'external_proof_rpc_disagreement:latest_head',
    );

    const evidence = await selectExternalProofFence({ rpcLegs: legs() });
    const reorged = responses();
    reorged.block.hash = `0x${'66'.repeat(32)}`;
    await expect(revalidateExternalProofFence(evidence, {
      rpcLegs: legs(reorged),
    })).rejects.toThrow('external_proof_block_reorged');
  });

  it('requires both operators to agree on the proof block hash', async () => {
    const left = responses();
    const right = responses();
    right.block.hash = `0x${'77'.repeat(32)}`;
    await expect(selectExternalProofFence({ rpcLegs: legs(left, right) })).rejects.toThrow(
      'external_proof_rpc_disagreement:block:989',
    );
  });

  it('EIP-1898 tags getCode, nonce, and EIP-1271 with the exact same canonical proof block hash', async () => {
    const evidence = await selectExternalProofFence({ rpcLegs: legs() });
    const calls: Array<{ method: string; params: readonly unknown[] }> = [];
    const rpcLegs = legs(responses(), responses(), calls);
    await expect(readExternalProofCode(ADDRESS, evidence, { rpcLegs })).resolves.toBe('0x6001600055');
    await expect(readExternalProofNonce(ADDRESS, evidence, { rpcLegs })).resolves.toBe(7);
    await expect(callExternalProofEip1271(
      ADDRESS,
      DIGEST,
      SIGNATURE,
      evidence,
      { rpcLegs },
    )).resolves.toBe('0x1626ba7e');

    const tags = calls
      .filter((call) => ['eth_getCode', 'eth_getTransactionCount', 'eth_call'].includes(call.method))
      .map((call) => call.params[call.params.length - 1]);
    expect(tags).toHaveLength(6);
    expect(tags).toEqual(Array.from({ length: 6 }, () => ({
      blockHash: BLOCK_HASH,
      requireCanonical: true,
    })));
  });

  it('rejects code/signature/nonce disagreement from one provider', async () => {
    const evidence = await selectExternalProofFence({ rpcLegs: legs() });
    const altered = responses();
    altered.code = '0x';
    await expect(readExternalProofCode(ADDRESS, evidence, {
      rpcLegs: legs(responses(), altered),
    })).rejects.toThrow('external_proof_rpc_disagreement:get_code');

    const alteredNonce = responses();
    alteredNonce.nonce = '0x8';
    await expect(readExternalProofNonce(ADDRESS, evidence, {
      rpcLegs: legs(responses(), alteredNonce),
    })).rejects.toThrow('external_proof_rpc_disagreement:baseline_nonce');

    const alteredSignature = responses();
    alteredSignature.call = iface.encodeFunctionResult('isValidSignature', ['0xffffffff']);
    await expect(callExternalProofEip1271(
      ADDRESS,
      DIGEST,
      SIGNATURE,
      evidence,
      { rpcLegs: legs(responses(), alteredSignature) },
    )).rejects.toThrow('external_proof_rpc_disagreement:eip1271');
  });
});
