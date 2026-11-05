/**
 * key rotation and credential recovery never remove an agent from
 * inbound USDC witnessing.
 *
 * Every fixture here is the REAL Firestore graph: the wallet is created through
 * the agent-wallet route, rotated through `executeKeyRotationTransition` (the
 * transition both rotate-key and recovery-rekey run), and recovered through the
 * real credential-recovery path. Before the watcher bound the native
 * address index to the BIRTH anchors by equality, so every rotated agent was
 * excluded every cycle as
 * `watched_address_enumeration_invalid:agent_registration_index:<wallet>`.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

type RegistrationContext = {
  registration_id: string;
  agent_id: string;
  credential_recovery_generation: number | null;
};
const verifyPop = jest.fn(async (
  challengeId: string,
  expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
) => ({
  ok: true as const,
  registration_context: {
    ...expected,
    credential_recovery_generation: challengeId === 'challenge-1' ? null : 0,
  },
}));
jest.mock('../agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => verifyPop(challengeId, expected),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));
const listProvenAddresses = jest.fn(async () => [] as unknown[]);
jest.mock('../external-address/link', () => ({
  ...(jest.requireActual('../external-address/link') as object),
  listProvenAddresses: () => listProvenAddresses(),
}));

import { buildBaseInboundDeps, scanInboundUsdc, type InboundUsdcScanDeps } from './inbound-usdc-watcher';
import {
  buildBaseOutboundDeps,
  scanOutboundUsdc,
  type OutboundUsdcScanDeps,
} from './outbound-usdc-watcher';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
} from './native-wallet-registration';
import { IDENTITY_ACTS_COLLECTION } from '../meter/identity-acts';
import {
  rehashIdentityAct,
  replaceIdentityActMetadata,
  replaceIdentityActRecord,
} from '../agent-wallet/__test-helpers__/identity-pe-fixture';
import {
  ROTATION_HISTORY_SUBCOLLECTION,
  rotationHistoryId,
} from '../agent-wallet/key-rotation-transition';
import {
  WATCHER_ENUMERATION_HEALTH_COLLECTION,
} from './watcher-enumeration-health';
import { WATCHER_ADDRESS_ADMISSION_COLLECTION } from './watcher-address-admission';
import {
  BIRTH_ADDRESS,
  AGENT_ID,
  BIRTH_PUBLIC_KEY,
  REGISTRATION_HEAD,
  SIGNER_ONE,
  SIGNER_TWO,
  agentBankDeps,
  buildAgentRoute,
  createAgentWallet,
  recoverAgentCredentials,
  rotateAgent,
  type FakeDb,
} from './__test-helpers__/rotated-agent';

let errorSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  listProvenAddresses.mockClear();
});
afterEach(() => errorSpy.mockRestore());

function inboundDeps(fake: FakeDb): InboundUsdcScanDeps {
  return buildBaseInboundDeps(agentBankDeps(fake));
}

function loggedReasons(): string[] {
  return errorSpy.mock.calls
    .map((call: unknown[]) => call[1])
    .filter((value: unknown): value is Error => value instanceof Error)
    .map((error: Error) => error.message);
}

function addressIndexKey(address: string): string {
  return `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(address)}`;
}

/** Move an address's anchor on BOTH native authorities that carry it (the
 * address index row and its inbound admission), so the forgery reaches the
 * anchor binding instead of tripping the admission check first. */
function forgeAddressAnchor(fake: FakeDb, address: string, createdAtMs: number): void {
  const key = addressIndexKey(address);
  fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), created_at_ms: createdAtMs });
  for (const [docKey, value] of fake.store) {
    if (docKey.startsWith(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/`)
      && (value as Record<string, unknown>).address === address
      && (value as Record<string, unknown>).direction === 'inbound') {
      fake.store.set(docKey, { ...(value as Record<string, unknown>), created_at_ms: createdAtMs, updated_at_ms: createdAtMs });
    }
  }
}

describe('inbound watcher enumeration across key rotation ', () => {
  test('control: an un-rotated agent is watched at its birth address', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const watched = await inboundDeps(fake).listWatchedWallets();
    expect(watched).toEqual([expect.objectContaining({
      walletId,
      address: BIRTH_ADDRESS,
      eligibilityStartBlock: REGISTRATION_HEAD + 1,
    })]);
    expect(loggedReasons()).toEqual([]);
  });

  test('RED: a rotated agent is watched at its NEW address from the rotation H+1 fence', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const rotatedAt = Date.now() + 1; // strictly after birth: same-ms rotation is (correctly) rotation_before_birth
    await rotateAgent(fake, walletId, SIGNER_ONE, { now: rotatedAt, head: 500 });

    const deps = inboundDeps(fake);
    const watched = await deps.listWatchedWallets();
    // Old code: [] and the exact reason
    // `watched_address_enumeration_invalid:agent_registration_index:<wallet>`.
    expect(loggedReasons()).not.toContain(
      `watched_address_enumeration_invalid:agent_registration_index:${walletId}`,
    );
    expect(loggedReasons()).toEqual([]);
    expect(watched).toEqual([{
      walletId,
      agentId: 'canonical-agent',
      address: SIGNER_ONE.address,
      createdAtMs: rotatedAt,
      ownerType: 'agent',
      eligibilityStartBlock: 501,
    }]);
    expect(await deps.takeEnumerationExclusions!()).toEqual([]);
  });

  test('a twice-rotated agent (the Atlas lineage) is watched at its third address', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const first = Date.now() + 1; // strictly after birth: same-ms rotation is (correctly) rotation_before_birth
    await rotateAgent(fake, walletId, SIGNER_ONE, { now: first, head: 500 });
    await rotateAgent(fake, walletId, SIGNER_TWO, { now: first + 1, head: 600 });
    const watched = await inboundDeps(fake).listWatchedWallets();
    expect(loggedReasons()).toEqual([]);
    expect(watched).toEqual([expect.objectContaining({
      walletId,
      address: SIGNER_TWO.address,
      createdAtMs: first + 1,
      eligibilityStartBlock: 601,
    })]);
  });

  test('credential recovery of an un-rotated agent keeps it watched', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const recovered = await recoverAgentCredentials(app, BIRTH_PUBLIC_KEY);
    expect(recovered.status).toBe(200);
    expect(recovered.body.credential_recovery_generation).toBe(1);
    const watched = await inboundDeps(fake).listWatchedWallets();
    expect(loggedReasons()).toEqual([]);
    expect(watched).toEqual([expect.objectContaining({ walletId, address: BIRTH_ADDRESS })]);
  });

  test('credential recovery of a ROTATED agent keeps it watched at the rotated address', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now() + 1, head: 500 });
    const recovered = await recoverAgentCredentials(app, SIGNER_ONE.publicKey);
    expect(recovered.status).toBe(200);
    const watched = await inboundDeps(fake).listWatchedWallets();
    expect(loggedReasons()).toEqual([]);
    expect(watched).toEqual([expect.objectContaining({ walletId, address: SIGNER_ONE.address })]);
  });

  test('a forged address row anchored at neither birth nor the rotation is still excluded', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const rotatedAt = Date.now() + 1; // strictly after birth: same-ms rotation is (correctly) rotation_before_birth
    await rotateAgent(fake, walletId, SIGNER_ONE, { now: rotatedAt, head: 500 });
    forgeAddressAnchor(fake, SIGNER_ONE.address, rotatedAt - 1_000_000_000);
    const deps = inboundDeps(fake);
    expect(await deps.listWatchedWallets()).toEqual([]);
    expect(loggedReasons()).toContain(
      `watched_address_enumeration_invalid:agent_address_anchor:${walletId}`,
    );
    expect(await deps.takeEnumerationExclusions!()).toEqual([{
      wallet_id: walletId,
      reason: `watched_address_enumeration_invalid:agent_address_anchor:${walletId}`,
      kind: 'invalid_authority',
    }]);
  });

  test('a forged rotation claim (anchor moved, no sealed lineage) is excluded', async () => {
    // An UN-rotated wallet whose wallet doc and address row are edited to look
    // rotated, with no rotation_history and no agent_key_rotated PE behind it.
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const walletKey = `agent_wallets/${walletId}`;
    const forgedAt = Date.now();
    fake.store.set(walletKey, {
      ...(fake.store.get(walletKey) as Record<string, unknown>),
      rotation_count: 1,
      last_rotated_at: forgedAt,
    });
    forgeAddressAnchor(fake, BIRTH_ADDRESS, forgedAt);
    expect(await inboundDeps(fake).listWatchedWallets()).toEqual([]);
    expect(loggedReasons().some((reason) => reason.startsWith(
      'watched_address_enumeration_invalid:agent_rotation_lineage:',
    ) && reason.endsWith(walletId))).toBe(true);
  });

  test('a rotation whose sealed PE does not match its history entry is excluded', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const result = await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now() + 1, head: 500 });
    const historyKey = `agent_wallets/${walletId}/${ROTATION_HISTORY_SUBCOLLECTION}/${rotationHistoryId(result.rotationPeId)}`;
    fake.store.set(historyKey, {
      ...(fake.store.get(historyKey) as Record<string, unknown>),
      pe_hash: 'f'.repeat(64),
    });
    expect(await inboundDeps(fake).listWatchedWallets()).toEqual([]);
    expect(loggedReasons()).toContain(
      `watched_address_enumeration_invalid:agent_rotation_lineage:rotation_pe_not_in_chain:${walletId}`,
    );
  });

  test('an un-rotated agent keeps the exact pre- reason for a mismatched index anchor', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const row = fake.store.get(addressIndexKey(BIRTH_ADDRESS)) as Record<string, unknown>;
    forgeAddressAnchor(fake, BIRTH_ADDRESS, (row.created_at_ms as number) + 1);
    expect(await inboundDeps(fake).listWatchedWallets()).toEqual([]);
    expect(loggedReasons()).toContain(
      `watched_address_enumeration_invalid:agent_registration_index:${walletId}`,
    );
  });

  // PE METER: the birth PE is one point read of the identity act the registration index pins
  // (the whole-chain walk is gone). RED: missing, tampered in place, or re-hashed and re-pinned
  // but no longer opening the agent's chain — each excludes the wallet as birth authority.
  test.each(['missing', 'tampered', 'not_chain_genesis'] as const)(
    'a birth identity act that is %s excludes the wallet',
    async (tamper) => {
      const { app, fake } = buildAgentRoute();
      const walletId = await createAgentWallet(app);
      // Control: watched before the tamper.
      expect(await inboundDeps(fake).listWatchedWallets()).toHaveLength(1);
      const indexKey = `${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${nativeAgentRegistrationIndexId(AGENT_ID)}`;
      const birthKey = `${IDENTITY_ACTS_COLLECTION}/${String((fake.store.get(indexKey) as Record<string, unknown>).pe_id)}`;
      expect(fake.store.has(birthKey)).toBe(true);
      if (tamper === 'missing') {
        fake.store.delete(birthKey);
      } else if (tamper === 'tampered') {
        replaceIdentityActMetadata(fake.store, birthKey, 'platform', 'sdk-forged');
      } else {
        replaceIdentityActRecord(fake.store, birthKey, 'prev_hash', 'e'.repeat(64));
        const hash = rehashIdentityAct(fake.store, birthKey);
        fake.store.set(indexKey, { ...(fake.store.get(indexKey) as Record<string, unknown>), pe_hash: hash });
      }
      expect(await inboundDeps(fake).listWatchedWallets()).toEqual([]);
      expect(loggedReasons()).toContain(
        `watched_address_enumeration_invalid:agent_birth_authority:${walletId}`,
      );
    },
  );
});

describe('inbound watcher exclusion visibility ', () => {
  const T0 = Date.now() + 60_000;
  function scanDeps(fake: FakeDb, nowMs: number = T0): InboundUsdcScanDeps {
    return {
      ...inboundDeps(fake),
      getBlockNumber: async () => 131,
      getLogs: async () => [],
      now: () => nowMs,
    };
  }

  test('an orphaned index row (wallet deleted) counts separately and never as an excluded wallet', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    fake.store.delete(`agent_wallets/${walletId}`);
    const report = await scanInboundUsdc(scanDeps(fake), { minConfirmations: 12 });
    expect(report.excluded_wallets).toBe(0);
    expect(report.orphaned_index_rows).toBe(1);
    expect(report.exclusions).toEqual([{
      wallet_id: walletId,
      reason: `watched_address_enumeration_invalid:agent_wallet_missing:${walletId}`,
      kind: 'orphaned_index_row',
    }]);
    expect(fake.store.get(`${WATCHER_ENUMERATION_HEALTH_COLLECTION}/inbound_usdc`)).toMatchObject({
      watcher: 'inbound_usdc',
      excluded_wallets: 0,
      orphaned_index_rows: 1,
      checked_at_ms: T0,
    });
  });

  test('an existing wallet excluded is counted, persisted, and its first-seen time carries forward', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const key = addressIndexKey(BIRTH_ADDRESS);
    const row = fake.store.get(key) as Record<string, unknown>;
    fake.store.set(key, { ...row, created_at_ms: (row.created_at_ms as number) + 1 });

    const first = await scanInboundUsdc(scanDeps(fake), {});
    expect(first.excluded_wallets).toBe(1);
    expect(first.orphaned_index_rows).toBe(0);
    const healthKey = `${WATCHER_ENUMERATION_HEALTH_COLLECTION}/inbound_usdc`;
    expect(fake.store.get(healthKey)).toMatchObject({
      excluded_wallets: 1,
      exclusions: [expect.objectContaining({ wallet_id: walletId, first_seen_at_ms: T0 })],
    });

    const later = scanDeps(fake, T0 + 4_000);
    await scanInboundUsdc(later, {});
    expect(fake.store.get(healthKey)).toMatchObject({
      checked_at_ms: T0 + 4_000,
      exclusions: [expect.objectContaining({ wallet_id: walletId, first_seen_at_ms: T0 })],
    });
  });

  test('a healthy watched set persists zero exclusions (non-vacuous: one wallet watched)', async () => {
    const { app, fake } = buildAgentRoute();
    await createAgentWallet(app);
    const report = await scanInboundUsdc(scanDeps(fake), {});
    expect(report.watched_wallets).toBe(1);
    expect(report.excluded_wallets).toBe(0);
    expect(fake.store.get(`${WATCHER_ENUMERATION_HEALTH_COLLECTION}/inbound_usdc`)).toMatchObject({
      watched_count: 1,
      excluded_wallets: 0,
      orphaned_index_rows: 0,
      exclusions: [],
    });
  });
});


describe('outbound watcher across rotation and recovery, with exclusion visibility ', () => {
  const T0 = Date.now() + 60_000;
  function outboundScanDeps(fake: FakeDb, nowMs: number = T0): OutboundUsdcScanDeps {
    return {
      ...buildBaseOutboundDeps(agentBankDeps(fake)),
      getBlockNumber: async () => 131,
      getLogs: async () => [],
      now: () => nowMs,
    };
  }

  test('verified unaffected: a rotated agent is watched outbound at its new address and fence', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now() + 1, head: 500 });
    const watched = await buildBaseOutboundDeps(agentBankDeps(fake)).listWatchedAddresses();
    expect(watched).toEqual([expect.objectContaining({
      walletId,
      address: SIGNER_ONE.address,
      provenAtBlock: 501,
      source: 'native_agent',
    })]);
  });

  test('verified unaffected: a credential-recovered agent stays watched outbound', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    expect((await recoverAgentCredentials(app, BIRTH_PUBLIC_KEY)).status).toBe(200);
    const watched = await buildBaseOutboundDeps(agentBankDeps(fake)).listWatchedAddresses();
    expect(watched).toEqual([expect.objectContaining({ walletId, address: BIRTH_ADDRESS })]);
  });

  test('an orphaned outbound index row is counted as orphaned, not as an excluded wallet', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    fake.store.delete(`agent_wallets/${walletId}`);
    const report = await scanOutboundUsdc(outboundScanDeps(fake), {});
    expect(report).toMatchObject({ excluded_wallets: 0, orphaned_index_rows: 1 });
    expect(report.exclusions).toEqual([{
      wallet_id: walletId,
      reason: `watched_address_enumeration_invalid:native_wallet_missing:${walletId}`,
      kind: 'orphaned_index_row',
    }]);
    expect(fake.store.get(`${WATCHER_ENUMERATION_HEALTH_COLLECTION}/outbound_usdc`)).toMatchObject({
      watcher: 'outbound_usdc',
      excluded_wallets: 0,
      orphaned_index_rows: 1,
    });
  });

  test('an existing wallet excluded outbound is counted and persisted as invalid authority', async () => {
    const { app, fake } = buildAgentRoute();
    const walletId = await createAgentWallet(app);
    const walletKey = `agent_wallets/${walletId}`;
    fake.store.set(walletKey, {
      ...(fake.store.get(walletKey) as Record<string, unknown>),
      native_watcher_registration: null,
    });
    const report = await scanOutboundUsdc(outboundScanDeps(fake), {});
    expect(report).toMatchObject({ excluded_wallets: 1, orphaned_index_rows: 0 });
    expect(fake.store.get(`${WATCHER_ENUMERATION_HEALTH_COLLECTION}/outbound_usdc`)).toMatchObject({
      excluded_wallets: 1,
      exclusions: [expect.objectContaining({
        wallet_id: walletId,
        reason: `watched_address_enumeration_invalid:native_wallet_fence:${walletId}`,
        kind: 'invalid_authority',
        first_seen_at_ms: T0,
      })],
    });
  });
});
