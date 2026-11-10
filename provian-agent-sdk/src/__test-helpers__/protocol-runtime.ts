import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import type { ProtocolDeployment } from '../protocol-pointer';

// Existing institution vectors remain useful for ABI/signing tests. Production
// resolves the permanent pointer; these bytes are only a deterministic fixture.
const artifact = JSON.parse(readFileSync(resolve(__dirname, '../../../contracts/deployments/base-pvt9-institutions.json'), 'utf8')) as {
  contracts: Record<string, { address: string }>;
  successorKernel: { pvt9Kernel: { address: string }; eligibilityVerifier: { address: string } };
};
const addresses = { kernel: artifact.successorKernel.pvt9Kernel.address,
  eligibilityVerifier: artifact.successorKernel.eligibilityVerifier.address,
  beneficiaryVerifier: '0x0000000000000000000000000000000000000000', escrow: artifact.contracts.escrowV4.address,
  promises: artifact.contracts.promiseV3.address, projectPool: artifact.contracts.poolV3.address,
  bonds: artifact.contracts.bondPool.address, court: artifact.contracts.courtV2.address,
  recoursePool: `0x${'77'.repeat(20)}`, settlement: `0x${'88'.repeat(20)}` };
const deployment: ProtocolDeployment = { pointer: `0x${'99'.repeat(20)}`, revision: 1n,
  blockHash: `0x${'aa'.repeat(32)}`, manifestHash: `0x${'bb'.repeat(32)}`, addresses, runtimeHashes: [] };
const rpc = { request: async () => `0x${'0'.repeat(64)}` };
export const protocolRuntimeFixture = {
  currentProtocolDeployment: vi.fn(async () => deployment),
  verifiedProtocolSnapshot: vi.fn(() => deployment),
  ownerChainNetwork: () => ({ deployment: async () => deployment, rpcs: [rpc, rpc] }),
};
