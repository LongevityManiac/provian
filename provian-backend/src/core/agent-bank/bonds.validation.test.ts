/**
 * Bonds - input-validation guards (Pass-3 #44, #45).
 *
 * #44: renewBond / withdrawBond called `db.collection('bonds').doc(body.bond_id)`
 *      BEFORE any presence check. A missing / non-string bond_id makes Firestore's
 *      CollectionReference.doc() throw synchronously ('documentPath is not a valid
 *      resource path'), which handleError masks as an opaque 500 for what is really
 *      a client field error (and an SDK retrying on 5xx loops forever). The guard
 *      must return a clean ValidationError (→ 400) BEFORE .doc().
 *
 * #45: fileClaim's evidence guard was `!evidence_pe_ids || .length === 0`, which a
 *      non-empty STRING passes (truthy + has .length), persisting the raw string
 *      into a string[] field and writing the char-count as evidence_pe_count. It
 *      must require Array.isArray (like the sibling agent-court.ts route).
 */

import { renewBond, withdrawBond, fileClaim } from './bonds';
import { ValidationError } from './errors';
import type { AgentBankDeps, RenewBondRequest, WithdrawBondRequest, FileClaimRequest } from './types';

// bond lifecycle: minimal acting-wallet doc for the machine's kill-switch-first gate
// (only `.status` is read at the module boundary; a non-'active' status blocks).
import type { AgentWalletDocument } from '../agent-wallet/types';
const ACTING_WALLET = { status: 'active' } as unknown as AgentWalletDocument;


jest.mock('./pe-utils', () => ({ generatePE: jest.fn() }));
jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmBondPosted: jest.fn(),
  verifyEvmBondRenewed: jest.fn(),
  verifyEvmBondWithdrawn: jest.fn(),
  verifyEvmClaimFiled: jest.fn(),
  readOnchainBondStatus: jest.fn(),
}));

/**
 * A deps whose db throws if ANY collection is touched — proving the guard rejects
 * BEFORE the offending `.doc(body.bond_id)` (the #44 crash site) is reached.
 */
function makeTripwireDeps(): AgentBankDeps {
  const db = {
    collection: jest.fn(() => {
      throw new Error('db must not be touched before validation');
    }),
  };
  return { db } as unknown as AgentBankDeps;
}

describe('renewBond / withdrawBond - bond_id validation (Pass-3 #44)', () => {
  const badIds: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['number', 12345],
    ['object', { foo: 'bar' }],
    ['empty string', ''],
  ];

  it.each(badIds)('renewBond rejects a %s bond_id with a clean 400 (not a .doc() crash)', async (_label, bad) => {
    const deps = makeTripwireDeps();
    await expect(
      renewBond(deps, 'wallet_1', ACTING_WALLET, { bond_id: bad as unknown as string, tx_hash: '0xabc' } as RenewBondRequest),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      renewBond(deps, 'wallet_1', ACTING_WALLET, { bond_id: bad as unknown as string, tx_hash: '0xabc' } as RenewBondRequest),
    ).rejects.toThrow(/bond_id is required/);
    expect((deps.db.collection as jest.Mock)).not.toHaveBeenCalled();
  });

  it.each(badIds)('withdrawBond rejects a %s bond_id with a clean 400 (not a .doc() crash)', async (_label, bad) => {
    const deps = makeTripwireDeps();
    await expect(
      withdrawBond(deps, 'wallet_1', ACTING_WALLET, { bond_id: bad as unknown as string, tx_hash: '0xabc' } as WithdrawBondRequest),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      withdrawBond(deps, 'wallet_1', ACTING_WALLET, { bond_id: bad as unknown as string, tx_hash: '0xabc' } as WithdrawBondRequest),
    ).rejects.toThrow(/bond_id is required/);
    expect((deps.db.collection as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('fileClaim - evidence_pe_ids array guard (Pass-3 #45)', () => {
  it('rejects a non-empty STRING evidence_pe_ids (would masquerade as an array)', async () => {
    const deps = makeTripwireDeps();
    await expect(
      fileClaim(deps, 'claimant_1', ACTING_WALLET, {
        respondent_wallet_id: 'respondent_1',
        chain: 'base',
        tx_hash: '0xabc',
        description: 'this description is definitely long enough to pass',
        // The bug: a string is truthy and has .length, so the old guard let it through.
        evidence_pe_ids: 'pe_single' as unknown as string[],
      } as FileClaimRequest),
    ).rejects.toThrow(/must be an array/);
    // Rejected at the top guard, before any Firestore access.
    expect((deps.db.collection as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects a missing evidence_pe_ids', async () => {
    const deps = makeTripwireDeps();
    await expect(
      fileClaim(deps, 'claimant_1', ACTING_WALLET, {
        respondent_wallet_id: 'respondent_1',
        chain: 'base',
        tx_hash: '0xabc',
        description: 'this description is definitely long enough to pass',
      } as FileClaimRequest),
    ).rejects.toThrow(/At least one evidence PE is required/);
  });

  it('rejects an empty-array evidence_pe_ids (unchanged behavior)', async () => {
    const deps = makeTripwireDeps();
    await expect(
      fileClaim(deps, 'claimant_1', ACTING_WALLET, {
        respondent_wallet_id: 'respondent_1',
        chain: 'base',
        tx_hash: '0xabc',
        description: 'this description is definitely long enough to pass',
        evidence_pe_ids: [],
      } as FileClaimRequest),
    ).rejects.toThrow(/At least one evidence PE is required/);
  });
});
