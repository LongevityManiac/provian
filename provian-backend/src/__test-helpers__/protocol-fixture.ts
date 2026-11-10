import type { ProtocolDeployment } from '../core/protocol/pointer';
/** Deterministic historic addresses for existing ABI vectors, never production resolution. */
export const protocolDeploymentFixture: ProtocolDeployment = {
  pointer: `0x${'99'.repeat(20)}`, revision: 1n, manifestHash: `0x${'aa'.repeat(32)}`, blockHash: `0x${'bb'.repeat(32)}`,
  runtimeHashes: Array(10).fill(`0x${'cc'.repeat(32)}`),
  addresses: { kernel: '0x8811441914381143b9408c5C32247367F86F173A',
    eligibilityVerifier: '0xb26Fd9d4f3b42911592B96270e8437287DE33406', beneficiaryVerifier: `0x${'0'.repeat(40)}`,
    escrow: '0x96560fDF49e563eFCdc2d502934676DC074732d0', promises: '0x7506F4A052750260A0ddcdF5E63a77CC646d89B9',
    projectPool: '0x1301BF63Cb6BaE7171f6c7D895C762B243964d26', bonds: '0x6b09E9C72316De9d62d63f09B187d4c86bBf787E',
    court: '0x9a326D1ff5EC97cE466CF6fc71BA6f5372E41D7f', recoursePool: `0x${'77'.repeat(20)}`, settlement: `0x${'88'.repeat(20)}` },
};
