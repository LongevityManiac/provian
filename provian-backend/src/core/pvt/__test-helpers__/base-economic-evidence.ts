import crypto from 'crypto';

import {
  BASE_USDC_ADDRESS,
  BASE_WATCHER_CONFIRMATION_FLOOR,
  hashBaseUsdcTransferEvidence,
  type BaseUsdcTransferEvidence,
} from '../../onchain/economic-discovery';

export function testTxHash(label: string): string {
  return `0x${crypto.createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

export function testBlockHash(label: string): string {
  return testTxHash(`block:${label}`);
}

export function baseEconomicEvidence(
  params: {
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    fromAddress: string;
    toAddress: string;
    amountAtomic: string;
    transactionSubmitter?: string;
    transactionTo?: string | null;
    transactionSelector?: string | null;
    blockTimestampMs?: number;
  },
): BaseUsdcTransferEvidence {
  const withoutHash: Omit<BaseUsdcTransferEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-usdc-transfer-evidence/v2',
    chainId: 8453,
    transactionHash: params.transactionHash.toLowerCase(),
    logIndex: params.logIndex,
    blockNumber: params.blockNumber,
    blockHash: testBlockHash(`${params.transactionHash}:${params.blockNumber}`),
    blockTimestampMs: params.blockTimestampMs ?? 5_000,
    confirmationFloor: BASE_WATCHER_CONFIRMATION_FLOOR,
    providerOperatorIds: ['operator-a', 'operator-b'],
    tokenAddress: BASE_USDC_ADDRESS,
    fromAddress: params.fromAddress.toLowerCase(),
    toAddress: params.toAddress.toLowerCase(),
    amountAtomic: params.amountAtomic,
    transactionSelector: params.transactionSelector?.toLowerCase() ?? null,
    transactionSubmitter: (params.transactionSubmitter ?? params.fromAddress).toLowerCase(),
    transactionTo: params.transactionTo === undefined
      ? BASE_USDC_ADDRESS
      : params.transactionTo?.toLowerCase() ?? null,
  };
  return {
    ...withoutHash,
    evidenceHash: hashBaseUsdcTransferEvidence(withoutHash),
  };
}
