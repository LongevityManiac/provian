/**
 * queueInitialMembershipGrants short-circuit - H-5 (audit 2026-05-11).
 *
 * The previous batch.set(..., { merge: true }) pattern overwrote
 * status='granted' back to 'pending' on a re-entry, double-minting the
 * on-chain grant when the Safe drainer re-saw the queue entry. The fix
 * wraps each chain's write in a transaction that reads the existing
 * status and skips the write entirely if status is 'granted' or
 * 'granting'.
 */

import {
  loadFoundationMembershipConfig,
  queueInitialMembershipGrants,
  type FoundationMembershipConfig,
} from './client';

const config: FoundationMembershipConfig = {
  enabled: true,
  chains: [
    { chainId: 8453, networkName: 'base', contractAddress: '0xBaseFM' },
  ],
};

function makeFakeDb(opts: {
  /** Return value for the transactional .get() - null = doc absent. */
  existingStatus?: string | null;
}): {
  db: any;
  txSet: jest.Mock;
} {
  const existing = {
    exists: opts.existingStatus !== null && opts.existingStatus !== undefined,
    data: () => (opts.existingStatus ? { status: opts.existingStatus } : undefined),
  };
  const txSet = jest.fn();
  const tx = {
    get: jest.fn().mockResolvedValue(existing),
    set: txSet,
  };
  const ref = { id: 'fake_doc' };
  const collection = {
    doc: jest.fn().mockReturnValue(ref),
  };
  const db = {
    collection: jest.fn().mockReturnValue(collection),
    runTransaction: jest.fn().mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
      await fn(tx);
    }),
  };
  return { db, txSet };
}

describe('queueInitialMembershipGrants - H-5 short-circuit', () => {
  const userId = 'user_1';
  const wallet = '0x1234567890abcdef1234567890abcdef12345678';

  it('writes when no doc exists yet (first call)', async () => {
    const { db, txSet } = makeFakeDb({ existingStatus: null });
    await queueInitialMembershipGrants(db, config, userId, wallet);
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0][1].status).toBe('pending');
  });

  it('writes when existing status is pending (idempotent re-queue)', async () => {
    const { db, txSet } = makeFakeDb({ existingStatus: 'pending' });
    await queueInitialMembershipGrants(db, config, userId, wallet);
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('writes when existing status is failed (allow retry from terminal failure)', async () => {
    const { db, txSet } = makeFakeDb({ existingStatus: 'failed' });
    await queueInitialMembershipGrants(db, config, userId, wallet);
    expect(txSet).toHaveBeenCalledTimes(1);
  });

  it('SKIPS when existing status is granted (terminal - would double-mint)', async () => {
    const { db, txSet } = makeFakeDb({ existingStatus: 'granted' });
    await queueInitialMembershipGrants(db, config, userId, wallet);
    expect(txSet).not.toHaveBeenCalled();
  });

  it('SKIPS when existing status is granting (in-flight - would double-mint)', async () => {
    const { db, txSet } = makeFakeDb({ existingStatus: 'granting' });
    await queueInitialMembershipGrants(db, config, userId, wallet);
    expect(txSet).not.toHaveBeenCalled();
  });

  it('config.enabled=false short-circuits before any read', async () => {
    const disabledConfig: FoundationMembershipConfig = { ...config, enabled: false };
    const { db } = makeFakeDb({ existingStatus: 'pending' });
    await queueInitialMembershipGrants(db, disabledConfig, userId, wallet);
    expect(db.runTransaction).not.toHaveBeenCalled();
  });
});

describe('runtime boundary Foundation membership quarantine', () => {
  it('ignores stale legacy enablement and cross-chain address variables', () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      ENABLE_FOUNDATION_MEMBERSHIP: 'true',
      FOUNDATION_MEMBERSHIP_ADDRESS_BASE: '0x1111111111111111111111111111111111111111',
      FOUNDATION_MEMBERSHIP_ADDRESS_ARBITRUM: '0x2222222222222222222222222222222222222222',
      FOUNDATION_MEMBERSHIP_ADDRESS_OPTIMISM: '0x3333333333333333333333333333333333333333',
    });
    try {
      expect(loadFoundationMembershipConfig()).toEqual({ enabled: false, chains: [] });
    } finally {
      process.env = previous;
    }
  });
});
