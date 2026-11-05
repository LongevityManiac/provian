/**
 * Bond abandonment keeper — Gate B identity guard (Pass-2 WS2 [CONFIG] closure).
 *
 * The keeper signs an on-chain burn from a dedicated GAS-ONLY EOA. Gate B is the
 * economic-safety boundary: the key must never collide with a privileged identity
 * (PVT minter, deployer/treasury, Foundation Safe, or the founder admin EOA which
 * is admin==executor==guardian on the live PVTv8 stack). A keeper key with mint or
 * admin authority would be a severe blast-radius escalation, so construction fails
 * closed on collision.
 */

import { ethers } from 'ethers';
import { assertBondKeeperIdentity, createBondKeeperGateway } from './bond-keeper';

// The live PVTv8 admin==executor==guardian EOA (CLAUDE.md LIVE POSTURE).
const FOUNDER_EOA = '0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a';

describe('assertBondKeeperIdentity (Gate B)', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('REJECTS the founder admin EOA (admin/executor/guardian on PVTv8) — the key must NOT be it', () => {
    expect(() => assertBondKeeperIdentity(FOUNDER_EOA)).toThrow(/legacy admin wallet/i);
    expect(() => assertBondKeeperIdentity(FOUNDER_EOA)).toThrow(/GATE B FAILED/);
  });

  it('REJECTS the founder EOA case-insensitively (no checksum-case bypass)', () => {
    expect(() => assertBondKeeperIdentity(FOUNDER_EOA.toLowerCase())).toThrow(/GATE B FAILED/);
  });

  it('REJECTS the configured deployer/treasury address', () => {
    const w = ethers.Wallet.createRandom();
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = w.address;
    expect(() => assertBondKeeperIdentity(w.address)).toThrow(/treasury/i);
  });

  it('REJECTS the address under the former variable name the deployed environment carries', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    const w = ethers.Wallet.createRandom();
    process.env.PROVIAN_TREASURY_ADDRESS = w.address;
    expect(() => assertBondKeeperIdentity(w.address)).toThrow(/treasury key identity \(PROVIAN_TREASURY_ADDRESS\)/);
  });

  it('REJECTS the configured Foundation Safe address', () => {
    const w = ethers.Wallet.createRandom();
    process.env.FOUNDATION_TREASURY_ADDRESS = w.address;
    expect(() => assertBondKeeperIdentity(w.address)).toThrow(/Foundation Safe/i);
  });

  it('REJECTS the PVT minter (derived from PVT_MINTER_KEY)', () => {
    const w = ethers.Wallet.createRandom();
    process.env.PVT_MINTER_KEY = w.privateKey;
    expect(() => assertBondKeeperIdentity(w.address)).toThrow(/minter/i);
  });

  it('ACCEPTS a clean, unprivileged gas-only address', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    delete process.env.PROVIAN_TREASURY_ADDRESS;
    delete process.env.FOUNDATION_TREASURY_ADDRESS;
    delete process.env.PVT_MINTER_KEY;
    const w = ethers.Wallet.createRandom();
    expect(() => assertBondKeeperIdentity(w.address)).not.toThrow();
  });
});

describe('createBondKeeperGateway', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('canSign() is false when BOND_KEEPER_KEY is unset (constructs without throwing)', () => {
    delete process.env.BOND_KEEPER_KEY;
    const g = createBondKeeperGateway();
    expect(g.canSign()).toBe(false);
  });

  it('canSign() is true for a clean, unprivileged key', () => {
    delete process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS;
    delete process.env.PROVIAN_TREASURY_ADDRESS;
    delete process.env.FOUNDATION_TREASURY_ADDRESS;
    delete process.env.PVT_MINTER_KEY;
    process.env.BOND_KEEPER_KEY = ethers.Wallet.createRandom().privateKey;
    const g = createBondKeeperGateway();
    expect(g.canSign()).toBe(true);
  });

  it('FAILS CLOSED at construction when the key resolves to a forbidden identity', () => {
    const w = ethers.Wallet.createRandom();
    process.env.KEEPER_FORBIDDEN_SIGNER_ADDRESS = w.address; // make this key collide with treasury
    process.env.BOND_KEEPER_KEY = w.privateKey;
    expect(() => createBondKeeperGateway()).toThrow(/GATE B FAILED/);
  });
});
