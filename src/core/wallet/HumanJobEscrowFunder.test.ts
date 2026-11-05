import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  buildEscrowFundingPlan,
  assertFundingPlanMatches,
  executeFundingPlan,
  deriveHireOnchainEscrowId,
  hireEscrowSalt,
  providerFundingReader,
  FUNDING_LOG_WINDOW,
  isGasEstimateRefusal,
  EscrowFundingError,
  usdcToAtomic,
  ESCROW_CURRENCY_PVT,
  ESCROW_CURRENCY_USDC,
  type EscrowFundingDetails,
  type OwnKeySigner,
  type FundingChainReader,
  type FundingChainState,
} from './HumanJobEscrowFunder';

const ESCROW = '0x96560fDF49e563eFCdc2d502934676DC074732d0';
const PVT_TOKEN = '0x8811441914381143b9408c5C32247367F86F173A';
const USDC_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECIPIENT = '0x00000000000000000000000000000000DeaDBeef';
const DEPOSITOR = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const ESCROW_ID = '0x' + 'ab'.repeat(32);

function pvtFunding(overrides: Partial<EscrowFundingDetails> = {}): EscrowFundingDetails {
  return {
    escrow_id: 'esc_1',
    currency: 'pvt',
    contract_address: ESCROW,
    amount_pvt: '1000000000000000000', // 1 PVT
    status: 'created',
    chain: 'base',
    depositor_address: DEPOSITOR,
    recipient_address: RECIPIENT,
    auto_release_at: 1_800_000_000_000, // ms
    token_address: PVT_TOKEN,
    ...overrides,
  };
}

function usdcFunding(overrides: Partial<EscrowFundingDetails> = {}): EscrowFundingDetails {
  return {
    escrow_id: 'esc_2',
    currency: 'usdc',
    contract_address: ESCROW,
    amount_usdc: 12.5,
    status: 'created',
    chain: 'base',
    depositor_address: DEPOSITOR,
    recipient_address: RECIPIENT,
    auto_release_at: 1_800_000_000_000,
    token_address: USDC_TOKEN,
    ...overrides,
  };
}

/** A fake own-key signer that records every send (receipts succeed). */
function fakeSigner(address: string) {
  const sent: { to: string; data: string }[] = [];
  const signer: OwnKeySigner = {
    address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      sent.push(tx);
      return { hash: `0x${String(sent.length).padStart(64, '0')}`, wait: async () => ({ status: 1 }) };
    }),
  };
  return { signer, sent };
}

const ZERO = '0x0000000000000000000000000000000000000000';
const NO_ESCROW: FundingChainState = { depositor: ZERO, recipient: ZERO, amount: 0n, autoReleaseAt: 0n, status: 0, currency: 0 };

/** A fake chain: no escrow and no allowance unless told otherwise. */
function fakeReader(o: { state?: FundingChainState; allowance?: bigint; fundingTx?: string | null } = {}): FundingChainReader {
  return {
    escrow: vi.fn(async () => o.state ?? NO_ESCROW),
    allowance: vi.fn(async () => o.allowance ?? 0n),
    fundingTx: vi.fn(async () => o.fundingTx ?? null),
  };
}

/** An ethers v6 estimate refusal (nothing broadcast). */
function estimateRefusal(): Error {
  return Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', action: 'estimateGas' });
}

/** A signer whose sends fail per `script` (by send index), otherwise succeed. */
function scriptedSigner(address: string, script: Record<number, () => Error>, opts: { waitThrowsFor?: string } = {}) {
  const sent: { to: string; data: string }[] = [];
  let calls = 0;
  const signer: OwnKeySigner = {
    address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      const i = calls++;
      if (script[i]) throw script[i]();
      sent.push(tx);
      const hash = `0x${String(sent.length).padStart(64, '0')}`;
      const fn = escrowIface.parseTransaction({ data: tx.data })?.name ?? 'approve';
      return {
        hash,
        wait: async () => {
          if (opts.waitThrowsFor === fn) throw new Error('network');
          return { status: 1 };
        },
      };
    }),
  };
  return { signer, sent };
}

const noSleep = { sleep: async () => undefined };

const escrowIface = new ethers.Interface([
  'function createEscrow(bytes32 escrowId, address recipient, uint256 amount, uint256 autoReleaseAt, uint8 currencyType)',
  'function fundEscrow(bytes32 escrowId, bool payFeeInPVT)',
]);
const erc20Iface = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);

describe('buildEscrowFundingPlan — PVT (the original sequence)', () => {
  it('builds create → approve → fund binding recipient/amount/autoRelease VERBATIM', () => {
    const plan = buildEscrowFundingPlan(pvtFunding(), ESCROW_ID);

    expect(plan.chainId).toBe(8453);
    expect(plan.amountAtomic).toBe(1_000000000000000000n);
    expect(plan.currencyEnum).toBe(ESCROW_CURRENCY_PVT);
    expect(plan.autoReleaseAtSec).toBe(1_800_000_000);
    expect(plan.calls.map((c) => c.label)).toEqual(['createEscrow', 'approve', 'fundEscrow']);

    const [create, approve, fund] = plan.calls;
    expect(create.to).toBe(ESCROW);
    const cArgs = escrowIface.decodeFunctionData('createEscrow', create.data);
    expect(cArgs[0].toLowerCase()).toBe(ESCROW_ID);
    expect(cArgs[1].toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(cArgs[2]).toBe(1_000000000000000000n);
    expect(cArgs[3]).toBe(1_800_000_000n);
    expect(Number(cArgs[4])).toBe(ESCROW_CURRENCY_PVT); // Currency.PVT = 1

    expect(approve.to).toBe(PVT_TOKEN);
    const aArgs = erc20Iface.decodeFunctionData('approve', approve.data);
    expect(aArgs[0]).toBe(ESCROW);
    expect(aArgs[1]).toBe(1_000000000000000000n);

    expect(fund.to).toBe(ESCROW);
    const fArgs = escrowIface.decodeFunctionData('fundEscrow', fund.data);
    expect(fArgs[0].toLowerCase()).toBe(ESCROW_ID);
    expect(fArgs[1]).toBe(false);
  });

  it('floors a sub-second auto_release_at to whole seconds (<= the ms gate holds)', () => {
    const plan = buildEscrowFundingPlan(pvtFunding({ auto_release_at: 1_800_000_000_999 }), ESCROW_ID);
    expect(plan.autoReleaseAtSec).toBe(1_800_000_000);
    expect(plan.autoReleaseAtSec * 1000).toBeLessThanOrEqual(1_800_000_000_999);
  });

  it('RED: rejects a non-32-byte escrowId', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding(), '0xabcd')).toThrow(/32-byte/);
  });
  it('RED: rejects an invalid escrow contract address', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ contract_address: 'not-an-address' }), ESCROW_ID)).toThrow(/contract_address/);
  });
  it('RED: rejects an invalid recipient address', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ recipient_address: '0x00' }), ESCROW_ID)).toThrow(/recipient_address/);
  });
  it('RED: rejects a missing token_address', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ token_address: undefined }), ESCROW_ID)).toThrow(/token_address/);
  });
  it('RED: rejects a non-integer amount_pvt', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ amount_pvt: '1.5' }), ESCROW_ID)).toThrow(/amount_pvt/);
  });
  it('RED: rejects a zero amount', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ amount_pvt: '0' }), ESCROW_ID)).toThrow(/greater than zero/);
  });
  it('RED: rejects a non-Base chain (hiring escrows are Base-only)', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ chain: 'arbitrum' }), ESCROW_ID)).toThrow(/Base-only/);
  });
  it('RED: rejects an unknown currency', () => {
    expect(() => buildEscrowFundingPlan(pvtFunding({ currency: 'eth' as unknown as 'pvt' }), ESCROW_ID)).toThrow(/Unknown escrow currency/);
  });
});

describe('buildEscrowFundingPlan — USDC ', () => {
  it('encodes Currency.USDC = 0, 6-decimal atomic amount, and approves the USDC token', () => {
    const plan = buildEscrowFundingPlan(usdcFunding(), ESCROW_ID);
    expect(plan.currencyEnum).toBe(ESCROW_CURRENCY_USDC);
    expect(plan.amountAtomic).toBe(12_500_000n); // 12.5 USDC

    const [create, approve, fund] = plan.calls;
    const cArgs = escrowIface.decodeFunctionData('createEscrow', create.data);
    expect(Number(cArgs[4])).toBe(0); // Currency.USDC — never PVT's 1
    expect(cArgs[2]).toBe(12_500_000n);
    expect(cArgs[1].toLowerCase()).toBe(RECIPIENT.toLowerCase());

    expect(approve.to).toBe(USDC_TOKEN);
    const aArgs = erc20Iface.decodeFunctionData('approve', approve.data);
    expect(aArgs[0]).toBe(ESCROW);
    expect(aArgs[1]).toBe(12_500_000n);

    const fArgs = escrowIface.decodeFunctionData('fundEscrow', fund.data);
    expect(fArgs[1]).toBe(false); // the PVT-fee discount is retired on USDC too
  });

  it('usdcToAtomic mirrors the relay conversion (toFixed(6))', () => {
    expect(usdcToAtomic(1)).toBe(1_000_000n);
    expect(usdcToAtomic(0.1)).toBe(100_000n);
    expect(usdcToAtomic(0.29)).toBe(290_000n); // float 0.29 must not become 289_999
    expect(usdcToAtomic(0.000001)).toBe(1n);
    expect(usdcToAtomic(10_000)).toBe(10_000_000_000n);
  });

  it('RED: a USDC escrow with no amount_usdc is refused before anything is built', () => {
    expect(() => buildEscrowFundingPlan(usdcFunding({ amount_usdc: undefined }), ESCROW_ID)).toThrow(/amount_usdc/);
  });
});

describe('executeFundingPlan — nothing is sent unless every check passes', () => {
  it('sends the three calls in order from the depositor (USDC)', async () => {
    const funding = usdcFunding();
    const plan = buildEscrowFundingPlan(funding, ESCROW_ID);
    const { signer, sent } = fakeSigner(DEPOSITOR);
    const out = await executeFundingPlan(signer, funding, plan, fakeReader());
    expect(sent.map((tx) => tx.to)).toEqual([ESCROW, USDC_TOKEN, ESCROW]);
    expect(out.fundTxHash).toBe(`0x${'3'.padStart(64, '0')}`);
    expect(out.escrowId).toBe(ESCROW_ID);
  });

  it('RED: a wallet that is not the depositor on record aborts before ANY send', async () => {
    const funding = usdcFunding();
    const plan = buildEscrowFundingPlan(funding, ESCROW_ID);
    const { signer, sent } = fakeSigner(STRANGER);
    await expect(executeFundingPlan(signer, funding, plan, fakeReader())).rejects.toThrow(/not the escrow depositor/);
    expect(sent).toHaveLength(0);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });

  it('RED: a plan carrying the wrong currency enum (PVT for a USDC escrow) aborts before ANY send', async () => {
    const funding = usdcFunding();
    const good = buildEscrowFundingPlan(funding, ESCROW_ID);
    // Re-encode createEscrow with Currency.PVT (1) over otherwise-identical arguments.
    const tamperedCreate = escrowIface.encodeFunctionData('createEscrow', [ESCROW_ID, RECIPIENT, 12_500_000n, 1_800_000_000n, 1]);
    const tampered = { ...good, calls: good.calls.map((c) => (c.label === 'createEscrow' ? { ...c, data: tamperedCreate } : c)) };
    const { signer, sent } = fakeSigner(DEPOSITOR);
    await expect(executeFundingPlan(signer, funding, tampered, fakeReader())).rejects.toThrow(/currency does not match/);
    expect(sent).toHaveLength(0);
  });

  it('RED: a plan built for the PVT escrow cannot fund the USDC escrow (amount + enum drift)', () => {
    const pvtPlan = buildEscrowFundingPlan(pvtFunding(), ESCROW_ID);
    expect(() => assertFundingPlanMatches(pvtPlan, usdcFunding())).toThrow(/does not match/);
  });

  it('RED: a plan approving the wrong token is refused', () => {
    const funding = usdcFunding();
    const good = buildEscrowFundingPlan(funding, ESCROW_ID);
    const wrongToken = { ...good, calls: good.calls.map((c) => (c.label === 'approve' ? { ...c, to: PVT_TOKEN } : c)) };
    expect(() => assertFundingPlanMatches(wrongToken, funding)).toThrow(/wrong token/);
  });
});

describe(' reviewer: the phone funds only the PINNED escrow and token', () => {
  it('the app pin is the deployed ProvianEscrowV4 and the live PVT9 kernel (bound to the deployment record, not a test copy)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { JOB_ESCROW_V4, PVT9_TOKEN } = await import('../chains/evm/config');
    const dep = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'contracts', 'deployments', 'base-pvt9-institutions.json'), 'utf8'));
    expect(JOB_ESCROW_V4.address.toLowerCase()).toBe(String(dep.contracts.escrowV4.address).toLowerCase());
    expect(PVT9_TOKEN.address.toLowerCase()).toBe('0x8811441914381143b9408c5c32247367f86f173a');
  });

  it('RED: a relay-named foreign escrow contract is refused before any call is built (USDC and PVT)', () => {
    const foreign = '0x9999999999999999999999999999999999999999';
    expect(() => buildEscrowFundingPlan(usdcFunding({ contract_address: foreign }), ESCROW_ID)).toThrow(/only funds/);
    expect(() => buildEscrowFundingPlan(pvtFunding({ contract_address: foreign }), ESCROW_ID)).toThrow(/only funds/);
  });

  it('RED: a relay-named foreign token (or the other currency\'s token) is refused before approve is built', () => {
    expect(() => buildEscrowFundingPlan(usdcFunding({ token_address: '0x9999999999999999999999999999999999999999' }), ESCROW_ID)).toThrow(/only approves/);
    expect(() => buildEscrowFundingPlan(usdcFunding({ token_address: PVT_TOKEN }), ESCROW_ID)).toThrow(/only approves/);
    expect(() => buildEscrowFundingPlan(pvtFunding({ token_address: USDC_TOKEN }), ESCROW_ID)).toThrow(/only approves/);
  });

  it('the pinned plan still builds for both currencies', () => {
    expect(buildEscrowFundingPlan(usdcFunding(), ESCROW_ID).calls.map((c) => c.to.toLowerCase())).toEqual([ESCROW.toLowerCase(), USDC_TOKEN.toLowerCase(), ESCROW.toLowerCase()]);
    expect(buildEscrowFundingPlan(pvtFunding(), ESCROW_ID).calls[1].to.toLowerCase()).toBe(PVT_TOKEN.toLowerCase());
  });
});

describe(' live finding — ONE escrow per hire, resumed from chain state', () => {
  const funding = pvtFunding();
  const plan = buildEscrowFundingPlan(funding, ESCROW_ID);
  const created: FundingChainState = {
    depositor: DEPOSITOR, recipient: RECIPIENT, amount: 1_000_000_000_000_000_000n,
    autoReleaseAt: 1_800_000_000n, status: 0, currency: ESCROW_CURRENCY_PVT,
  };
  const labels = (sent: { to: string; data: string }[]) => sent.map((tx) =>
    escrowIface.parseTransaction({ data: tx.data })?.name ?? erc20Iface.parseTransaction({ data: tx.data })?.name);

  it('the id is deterministic for the key holder and unpredictable without the key (squat-proof)', () => {
    const owner = new ethers.Wallet('0x' + '11'.repeat(32));
    const other = new ethers.Wallet('0x' + '22'.repeat(32));
    const saltA = hireEscrowSalt((m) => owner.signMessageSync(m));
    // Same key, same salt, same id — a second tap or a restored wallet resumes the same escrow.
    expect(hireEscrowSalt((m) => owner.signMessageSync(m))).toBe(saltA);
    const id = deriveHireOnchainEscrowId(owner.address, 'esc_1', saltA);
    expect(deriveHireOnchainEscrowId(owner.address.toLowerCase(), 'esc_1', saltA)).toBe(id);
    // RED: the public inputs alone (the old unsalted derivation) do not yield it.
    const unsalted = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'address', 'string'], ['provian.commons.hire-escrow.v1', owner.address, 'esc_1']));
    expect(id).not.toBe(unsalted);
    // Another key's salt gives another id; each hire gets its own id.
    expect(deriveHireOnchainEscrowId(owner.address, 'esc_1', hireEscrowSalt((m) => other.signMessageSync(m)))).not.toBe(id);
    expect(deriveHireOnchainEscrowId(owner.address, 'esc_2', saltA)).not.toBe(id);
    expect(() => deriveHireOnchainEscrowId(owner.address, '', saltA)).toThrow();
    expect(() => deriveHireOnchainEscrowId(owner.address, 'esc_1', '0x12')).toThrow();
  });

  it('fresh hire: create → approve → fund', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    const out = await executeFundingPlan(signer, funding, plan, fakeReader(), noSleep);
    expect(labels(sent)).toEqual(['createEscrow', 'approve', 'fundEscrow']);
    expect(out.alreadyFunded).toBe(false);
  });

  it('second tap after a stopped fund: skips create AND approve, sends only fund (the live case)', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    const out = await executeFundingPlan(signer, funding, plan, fakeReader({ state: created, allowance: 1_000_000_000_000_000_000n }), noSleep);
    expect(labels(sent)).toEqual(['fundEscrow']);
    expect(out.createTxHash).toBeNull();
    expect(out.approveTxHash).toBeNull();
  });

  it('created but allowance short: approve + fund, never a second create', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    await executeFundingPlan(signer, funding, plan, fakeReader({ state: created, allowance: 1n }), noSleep);
    expect(labels(sent)).toEqual(['approve', 'fundEscrow']);
  });

  it('an estimate refusal on fund (node lagging the approve) is retried and then lands', async () => {
    // sends: 0 create, 1 approve, 2 fund(refused), 3 fund(refused), 4 fund ok
    const { signer, sent } = scriptedSigner(DEPOSITOR, { 2: estimateRefusal, 3: estimateRefusal });
    const sleep = vi.fn(async () => undefined);
    const out = await executeFundingPlan(signer, funding, plan, fakeReader(), { sleep });
    expect(labels(sent)).toEqual(['createEscrow', 'approve', 'fundEscrow']);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(out.fundTxHash).toBe(`0x${'3'.padStart(64, '0')}`);
  });

  it('RED: a non-estimate send error is NOT retried (send_failed, one attempt)', async () => {
    const { signer } = scriptedSigner(DEPOSITOR, { 0: () => Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' }) });
    const sleep = vi.fn(async () => undefined);
    await expect(executeFundingPlan(signer, funding, plan, fakeReader(), { sleep })).rejects.toMatchObject({ code: 'send_failed' });
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('RED: estimate refusals are bounded (attempts exhausted → send_failed)', async () => {
    const all: Record<number, () => Error> = {};
    for (let i = 0; i < 20; i++) all[i] = estimateRefusal;
    const { signer } = scriptedSigner(DEPOSITOR, all);
    await expect(executeFundingPlan(signer, funding, plan, fakeReader(), { ...noSleep, attempts: 3 })).rejects.toMatchObject({ code: 'send_failed' });
    expect(signer.sendTransaction).toHaveBeenCalledTimes(3);
  });

  it('already funded on-chain: returns the funding tx, sends NOTHING (never pays twice)', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    const out = await executeFundingPlan(signer, funding, plan, fakeReader({ state: { ...created, status: 1 }, fundingTx: '0xfeed' }), noSleep);
    expect(sent).toHaveLength(0);
    expect(out).toMatchObject({ fundTxHash: '0xfeed', alreadyFunded: true });
  });

  it('RED: funded but no funding event found → funded_unrecorded, nothing sent', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    await expect(executeFundingPlan(signer, funding, plan, fakeReader({ state: { ...created, status: 1 } }), noSleep))
      .rejects.toMatchObject({ code: 'funded_unrecorded' });
    expect(sent).toHaveLength(0);
  });

  it('RED: an escrow at the id with other terms → escrow_id_conflict, nothing sent', async () => {
    for (const bad of [{ recipient: STRANGER }, { amount: 2n }, { depositor: STRANGER }, { currency: ESCROW_CURRENCY_USDC }, { autoReleaseAt: 1n }]) {
      const { signer, sent } = scriptedSigner(DEPOSITOR, {});
      await expect(executeFundingPlan(signer, funding, plan, fakeReader({ state: { ...created, ...bad } }), noSleep))
        .rejects.toMatchObject({ code: 'escrow_id_conflict' });
      expect(sent).toHaveLength(0);
    }
  });

  it('RED: a cancelled escrow → escrow_cancelled, nothing sent', async () => {
    const { signer, sent } = scriptedSigner(DEPOSITOR, {});
    await expect(executeFundingPlan(signer, funding, plan, fakeReader({ state: { ...created, status: 5 } }), noSleep))
      .rejects.toMatchObject({ code: 'escrow_cancelled' });
    expect(sent).toHaveLength(0);
  });

  it('a lost receipt → unconfirmed carrying the fund tx hash (a re-tap resumes from chain)', async () => {
    const { signer } = scriptedSigner(DEPOSITOR, {}, { waitThrowsFor: 'fundEscrow' });
    const err = await executeFundingPlan(signer, funding, plan, fakeReader(), noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowFundingError);
    expect(err).toMatchObject({ code: 'unconfirmed', txHash: `0x${'3'.padStart(64, '0')}` });
  });

  it('isGasEstimateRefusal matches only the ethers estimate refusal', () => {
    expect(isGasEstimateRefusal(estimateRefusal())).toBe(true);
    expect(isGasEstimateRefusal(Object.assign(new Error('x'), { code: 'CALL_EXCEPTION', action: 'call' }))).toBe(false);
    expect(isGasEstimateRefusal(Object.assign(new Error('x'), { code: 'INSUFFICIENT_FUNDS' }))).toBe(false);
    expect(isGasEstimateRefusal(null)).toBe(false);
  });

  it('the phone funds at the salted DERIVED id, never a random one', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, 'HumanJobEscrowFunder.ts'), 'utf8');
    const impure = src.slice(src.indexOf('export async function fundHumanJobEscrowOnChain'));
    expect(impure).toMatch(/deriveHireOnchainEscrowId\(\s*funding\.depositor_address,\s*funding\.escrow_id,\s*hireEscrowSalt\(/);
    expect(impure).not.toMatch(/randomBytes/);
    expect(impure).toMatch(/providerFundingReader\(provider\)/);
  });

  it('a mined revert (ethers wait() throws CALL_EXCEPTION with the receipt) is reported as reverted, not unconfirmed', async () => {
    const sent: string[] = [];
    const signer: OwnKeySigner = {
      address: DEPOSITOR,
      sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
        sent.push(tx.data);
        const hash = `0x${String(sent.length).padStart(64, '0')}`;
        const isFund = escrowIface.parseTransaction({ data: tx.data })?.name === 'fundEscrow';
        return {
          hash,
          wait: async () => {
            if (isFund) throw Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION', receipt: { status: 0 } });
            return { status: 1 };
          },
        };
      }),
    };
    await expect(executeFundingPlan(signer, funding, plan, fakeReader(), noSleep)).rejects.toMatchObject({ code: 'reverted' });
  });
});

describe('providerFundingReader against a fake RPC (the real reader, not a stub)', () => {
  const readIface = new ethers.Interface([
    'function escrows(bytes32) view returns (address depositor, address recipient, uint256 amount, uint256 fee, uint256 autoReleaseAt, uint8 status, uint8 currency, bool feePaidInPVT)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
    'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
  ]);
  const HEAD = 100_000;

  function fakeProvider(opts: { logsAtWindow?: number } = {}) {
    const windows: { fromBlock: number; toBlock: number; topics: unknown }[] = [];
    const provider = {
      call: vi.fn(async (tx: { data: string }) => {
        const sel = tx.data.slice(0, 10);
        if (sel === readIface.getFunction('escrows')!.selector) {
          return readIface.encodeFunctionResult('escrows', [DEPOSITOR, RECIPIENT, 7n, 3n, 1_800_000_000n, 1, 1, false]);
        }
        return readIface.encodeFunctionResult('allowance', [42n]);
      }),
      getBlockNumber: vi.fn(async () => HEAD),
      getLogs: vi.fn(async (f: { fromBlock: number; toBlock: number; topics: unknown }) => {
        windows.push(f);
        if (f.toBlock - f.fromBlock + 1 > 2000) throw new Error('eth_getLogs is limited to a 2,000 range');
        return windows.length === opts.logsAtWindow ? [{ transactionHash: '0xfund' }] : [];
      }),
    };
    return { provider: provider as unknown as ethers.Provider, windows };
  }

  it('maps the escrows struct by field (amount is not fee), and reads the allowance', async () => {
    const { provider } = fakeProvider();
    const r = providerFundingReader(provider);
    expect(await r.escrow(ESCROW, ESCROW_ID)).toEqual({
      depositor: DEPOSITOR, recipient: RECIPIENT, amount: 7n, autoReleaseAt: 1_800_000_000n, status: 1, currency: 1,
    });
    expect(await r.allowance(PVT_TOKEN, DEPOSITOR, ESCROW)).toBe(42n);
  });

  it('walks back in windows the public RPC accepts, filtering BOTH funding events by THIS escrow id', async () => {
    const { provider, windows } = fakeProvider({ logsAtWindow: 3 });
    const tx = await providerFundingReader(provider).fundingTx(ESCROW, ESCROW_ID);
    expect(tx).toBe('0xfund');
    expect(windows).toHaveLength(3);
    expect(FUNDING_LOG_WINDOW).toBeLessThanOrEqual(2000);
    for (const w of windows) {
      expect(w.toBlock - w.fromBlock + 1).toBeLessThanOrEqual(2000);
      expect(w.topics).toEqual([
        [readIface.getEvent('EscrowFunded')!.topicHash, readIface.getEvent('EscrowFundedPVT')!.topicHash],
        ESCROW_ID,
      ]);
    }
    // Contiguous, newest first, no gaps.
    expect(windows[0].toBlock).toBe(HEAD);
    expect(windows[1].toBlock).toBe(windows[0].fromBlock - 1);
  });

  it('RED: no funding event anywhere in range → null (the caller refuses; never a guess)', async () => {
    const { provider } = fakeProvider();
    expect(await providerFundingReader(provider).fundingTx(ESCROW, ESCROW_ID)).toBeNull();
  });
});
