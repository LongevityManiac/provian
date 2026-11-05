/**
 * External-address signature verification tests.
 *
 * EOA path uses real ethers crypto (no network). EIP-1271 path injects the
 * on-chain reads so the contract-wallet branch is exercised without an RPC.
 */

import { ethers } from 'ethers';
import {
  verifyExternalAddressSignature,
  type ExternalVerifyDeps,
} from './verify';
import type { ExternalProofFenceEvidence } from './proof-head';

const PROOF: ExternalProofFenceEvidence = {
  schemaVersion: 'external-proof-fence/v1',
  chainId: 8453,
  observedHeadBlock: 1_000,
  proofBlockNumber: 989,
  proofBlockHash: `0x${'ab'.repeat(32)}`,
  provenAtBlock: 1_001,
  minActivityConfirmations: 12,
  rpcOperatorIds: ['operator-a', 'operator-b'],
};

const MESSAGE = [
  'Provian proof of control',
  'agent: agent_test',
  'address: 0x0000000000000000000000000000000000000001',
  'nonce: deadbeefdeadbeefdeadbeefdeadbeef',
  'issued: 2026-06-20T00:00:00.000Z',
  'expires: 2026-06-20T00:10:00.000Z',
].join('\n');

describe('verifyExternalAddressSignature - EOA (EIP-191)', () => {
  it('accepts a valid personal_sign signature from the claimed EOA', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(MESSAGE);
    const res = await verifyExternalAddressSignature({
      address: wallet.address,
      message: MESSAGE,
      signature,
      chain: 'base',
      proof: PROOF,
    }, { getCode: async () => '0x', isValidSignature: async () => '0xffffffff' });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('eip191_eoa');
  });

  it('rejects when a DIFFERENT address is claimed (no code -> not a contract)', async () => {
    const signer = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const signature = await signer.signMessage(MESSAGE);
    const deps: ExternalVerifyDeps = {
      getCode: async () => '0x', // `other` is an EOA, so EIP-1271 can't save it
      isValidSignature: async () => '0xffffffff',
    };
    const res = await verifyExternalAddressSignature(
      { address: other.address, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('eoa_recovery_mismatch');
  });

  it('rejects a signature over a DIFFERENT message', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage('a different message entirely');
    const deps: ExternalVerifyDeps = { getCode: async () => '0x', isValidSignature: async () => '0xffffffff' };
    const res = await verifyExternalAddressSignature(
      { address: wallet.address, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects malformed inputs', async () => {
    expect((await verifyExternalAddressSignature({ address: 'not-an-address', message: MESSAGE, signature: '0xabcd', chain: 'base', proof: PROOF })).reason).toBe('invalid_address');
    expect((await verifyExternalAddressSignature({ address: ethers.Wallet.createRandom().address, message: MESSAGE, signature: 'nothex', chain: 'base', proof: PROOF })).reason).toBe('invalid_signature_format');
  });
});

describe('verifyExternalAddressSignature - EIP-1271 (contract wallet)', () => {
  // A signature that will NOT EOA-recover to the contract address, forcing the
  // EIP-1271 fallback. The injected deps decide validity.
  let signature: string;
  let contractAddress: string;
  beforeEach(async () => {
    const someEoa = ethers.Wallet.createRandom();
    signature = await someEoa.signMessage(MESSAGE);
    contractAddress = ethers.Wallet.createRandom().address; // pretend it's a contract
  });

  it('accepts when the wallet contract returns the magic value 0x1626ba7e', async () => {
    const seenBlocks: number[] = [];
    const deps: ExternalVerifyDeps = {
      getCode: async (_address, proof) => {
        seenBlocks.push(proof.proofBlockNumber);
        return '0x363d3d373d3d3d363d73beef';
      },
      isValidSignature: async (_address, _digest, _signature, proof) => {
        seenBlocks.push(proof.proofBlockNumber);
        return '0x1626ba7e';
      },
    };
    const res = await verifyExternalAddressSignature(
      { address: contractAddress, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.method).toBe('eip1271_contract');
    expect(seenBlocks).toEqual([989, 989]);
  });

  it('requires EIP-1271 when code exists at the proof block even if EOA recovery matches', async () => {
    const wallet = ethers.Wallet.createRandom();
    const validEoaSignature = await wallet.signMessage(MESSAGE);
    const res = await verifyExternalAddressSignature({
      address: wallet.address,
      message: MESSAGE,
      signature: validEoaSignature,
      chain: 'base',
      proof: PROOF,
    }, {
      getCode: async () => '0x6000',
      isValidSignature: async () => '0xffffffff',
    });
    expect(res).toEqual({ ok: false, reason: 'eip1271_invalid' });
  });

  it('rejects when the contract returns a non-magic value', async () => {
    const deps: ExternalVerifyDeps = {
      getCode: async () => '0x363d3d373d3d3d363d73beef',
      isValidSignature: async () => '0xffffffff',
    };
    const res = await verifyExternalAddressSignature(
      { address: contractAddress, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('eip1271_invalid');
  });

  it('rejects (mismatch) when the address has no code and EOA failed', async () => {
    const deps: ExternalVerifyDeps = {
      getCode: async () => '0x',
      isValidSignature: async () => '0x1626ba7e',
    };
    const res = await verifyExternalAddressSignature(
      { address: contractAddress, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('eoa_recovery_mismatch');
  });

  it('surfaces an isValidSignature call failure as eip1271_call_failed', async () => {
    const deps: ExternalVerifyDeps = {
      getCode: async () => '0x363d3d373d3d3d363d73beef',
      isValidSignature: async () => { throw new Error('revert'); },
    };
    const res = await verifyExternalAddressSignature(
      { address: contractAddress, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('eip1271_call_failed');
  });

  it('fails closed when the operator-quorum code read disagrees', async () => {
    const deps: ExternalVerifyDeps = {
      getCode: async () => { throw new Error('failed to meet quorum'); },
      isValidSignature: async () => '0x1626ba7e',
    };
    const res = await verifyExternalAddressSignature(
      { address: contractAddress, message: MESSAGE, signature, chain: 'base', proof: PROOF },
      deps,
    );
    expect(res).toEqual({ ok: false, reason: 'getcode_failed' });
  });
});
