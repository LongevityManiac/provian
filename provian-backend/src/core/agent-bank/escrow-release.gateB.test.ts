/**
 * WS1 Gate B: the escrow-release EOA must never be the PVT minter, the
 * deployer/treasury, or the Foundation Safe. assertReleaseSignerIdentity is
 * the in-code enforcement that fails closed at gateway construction.
 */

import { ethers } from 'ethers';
import { assertReleaseSignerIdentity } from './escrow-release';

const ORIG_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('assertReleaseSignerIdentity (Gate B)', () => {
  it('accepts a fresh dedicated EOA distinct from minter/treasury/foundation', () => {
    delete process.env.PVT_MINTER_KEY;
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    delete process.env.PROVIAN_TREASURY_ADDRESS;
    delete process.env.FOUNDATION_TREASURY_ADDRESS;
    const fresh = ethers.Wallet.createRandom().address;
    expect(() => assertReleaseSignerIdentity(fresh)).not.toThrow();
  });

  it('rejects the deployer/treasury address (from env)', () => {
    const treasury = ethers.Wallet.createRandom().address;
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = treasury;
    expect(() => assertReleaseSignerIdentity(treasury)).toThrow(/GATE B FAILED/i);
  });

  it('rejects the treasury address under the former variable name (from env)', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    const treasury = ethers.Wallet.createRandom().address;
    process.env.PROVIAN_TREASURY_ADDRESS = treasury;
    expect(() => assertReleaseSignerIdentity(treasury)).toThrow(/GATE B FAILED/i);
  });

  it('rejects the Foundation Safe address (from env)', () => {
    const safe = ethers.Wallet.createRandom().address;
    process.env.FOUNDATION_TREASURY_ADDRESS = safe;
    expect(() => assertReleaseSignerIdentity(safe)).toThrow(/GATE B FAILED/i);
  });

  it('rejects the PVT minter address derived from PVT_MINTER_KEY', () => {
    const minter = ethers.Wallet.createRandom();
    process.env.PVT_MINTER_KEY = minter.privateKey;
    expect(() => assertReleaseSignerIdentity(minter.address)).toThrow(/PVT minter/i);
  });

  it('rejects the hardcoded deployer/treasury anchor even without env', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    delete process.env.PROVIAN_TREASURY_ADDRESS;
    delete process.env.PVT_MINTER_KEY;
    expect(() =>
      assertReleaseSignerIdentity('0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a'),
    ).toThrow(/GATE B FAILED/i);
  });

  it('is case-insensitive on the address comparison', () => {
    const treasury = ethers.Wallet.createRandom().address;
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = treasury.toLowerCase();
    expect(() => assertReleaseSignerIdentity(treasury.toUpperCase().replace('0X', '0x'))).toThrow(
      /GATE B FAILED/i,
    );
  });
});
