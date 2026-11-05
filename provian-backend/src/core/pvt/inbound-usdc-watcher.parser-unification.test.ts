/**
 * follow-up — inbound's canonical-native-index parser is the SHARED one.
 *
 * `inbound-usdc-watcher.ts` carried a private `parseCanonicalNativeAddressIndex`
 * while the outbound watcher already imported the shared one from
 * `native-wallet-registration.ts`. Two copies of an authority parser drift; the
 * follow-up unifies inbound onto the shared parser. This suite pins that
 * unification two ways, each with a negative control:
 *
 * (a) SOURCE-BOUND: the inbound module declares NO local function of that name
 * and imports it from `./native-wallet-registration`. The in-suite negative
 * control feeds the same auditor a copy of the source with a local
 * declaration re-added and asserts the violation is reported.
 *
 * (b) BEHAVIOURAL: inbound's admission decision BINDS to the shared parser.
 * The shared module is `jest.mock`ed with a spy around the real parser; a
 * canonical human wallet is admitted (spy called once), then the spy is
 * mutated to reject and the SAME enumeration excludes the wallet. A stale
 * private copy would never call the spy and would admit the wallet both
 * times, so "unified" cannot pass with the duplicate still in place.
 *
 * RED CONTROL RECORD (observed against the pre-fix source, commit 8b408220,
 * before the private copy was deleted):
 * - (a) `inbound-usdc-watcher.ts declares no local parser and imports the
 * shared one` FAILED: `localDeclaration` was true (the private
 * `function parseCanonicalNativeAddressIndex(` at line 179) and
 * `importsShared` was false.
 * - (b) `inbound admission binds to the SHARED parser` FAILED at
 * `expect(parser).toHaveBeenCalledTimes(1)` received 0 calls: the
 * private copy parsed the row and the shared spy was never reached, so the
 * mutation could not change the decision (the wallet stayed admitted).
 */

import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

const listProvenAddresses = jest.fn(async () => []);
jest.mock('../external-address/link', () => ({ listProvenAddresses }));

jest.mock('./native-wallet-registration', () => {
  const actual = jest.requireActual<typeof import('./native-wallet-registration')>(
    './native-wallet-registration',
  );
  return {
    ...actual,
    parseCanonicalNativeAddressIndex: jest.fn(actual.parseCanonicalNativeAddressIndex),
  };
});

import type { AgentBankDeps } from '../agent-bank/types';
import { buildBaseInboundDeps } from './inbound-usdc-watcher';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  createNativeWalletRegistrationFence,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
} from './native-wallet-registration';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  watcherAddressAdmissionDocId,
} from './watcher-address-admission';

// =============================================================================
// (a) SOURCE-BOUND
// =============================================================================

const INBOUND_SOURCE_PATH = path.join(__dirname, 'inbound-usdc-watcher.ts');

/** A local function/const/let/var declaration of the parser name. */
const LOCAL_DECLARATION = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+parseCanonicalNativeAddressIndex\s*\(|(?:const|let|var)\s+parseCanonicalNativeAddressIndex\b)/;

/** A named import of the parser from the shared module. */
const SHARED_IMPORT = /import\s*\{[^}]*\bparseCanonicalNativeAddressIndex\b[^}]*\}\s*from\s*'\.\/native-wallet-registration'/;

function auditParserBinding(source: string): { localDeclaration: boolean; importsShared: boolean } {
  return {
    localDeclaration: LOCAL_DECLARATION.test(source),
    importsShared: SHARED_IMPORT.test(source),
  };
}

describe(' follow-up (a): inbound imports the shared canonical-native-index parser', () => {
  const source = fs.readFileSync(INBOUND_SOURCE_PATH, 'utf8');

  it('inbound-usdc-watcher.ts declares no local parser and imports the shared one', () => {
    // Population guard: the source must actually reference the parser, else
    // both assertions below would pass over an empty subject.
    expect(source).toMatch(/parseCanonicalNativeAddressIndex\(/);
    expect(auditParserBinding(source)).toEqual({ localDeclaration: false, importsShared: true });
  });

  it('NEGATIVE CONTROL: re-adding a local declaration is reported as a violation', () => {
    const readded = `${source}\n\nfunction parseCanonicalNativeAddressIndex(raw: unknown, documentId: string) {\n  return raw as never;\n}\n`;
    expect(auditParserBinding(readded).localDeclaration).toBe(true);
    const asConst = `${source}\n\nconst parseCanonicalNativeAddressIndex = (raw: unknown) => raw as never;\n`;
    expect(auditParserBinding(asConst).localDeclaration).toBe(true);
  });

  it('NEGATIVE CONTROL: dropping the shared import is reported as a violation', () => {
    const withoutImport = source.replace(/\bparseCanonicalNativeAddressIndex,?\n/, '');
    expect(withoutImport).not.toBe(source);
    expect(auditParserBinding(withoutImport).importsShared).toBe(false);
  });
});

// =============================================================================
// (b) BEHAVIOURAL
// =============================================================================

const HUMAN_WALLET_ID = 'wallet_human_1';
const HUMAN_USER_ID = 'user_human_1';
const HUMAN_ADDRESS = '0x1111111111111111111111111111111111111111';

/**
 * The SAME three-plus-one documents a native human registration writes
 * (`genesis-ingress.ts`): the wallet doc carrying its registration fence, the
 * human registration index row, the canonical native address index row, and
 * the registration-fenced inbound admission. Mirrors the fixture in
 * `watcher-enumeration.test.ts`.
 */
function seedCanonicalHumanAuthority(db: ReturnType<typeof createFakeFirestore>): void {
  const createdAt = 1;
  const fence = createNativeWalletRegistrationFence(140);
  db.store.set(`wallets/${HUMAN_WALLET_ID}`, {
    id: HUMAN_WALLET_ID,
    type: 'human',
    user_id: HUMAN_USER_ID,
    evm_address: HUMAN_ADDRESS,
    created_at: createdAt,
    native_watcher_registration: fence,
  });
  db.store.set(`human_wallet_registration_by_user_v1/${HUMAN_USER_ID}`, {
    schema_version: 'human-wallet-registration/v2',
    user_id: HUMAN_USER_ID,
    request_fingerprint: '2'.repeat(64),
    wallet_id: HUMAN_WALLET_ID,
    pe_id: `pe_human_${HUMAN_USER_ID}`,
    pe_hash: '3'.repeat(64),
    prev_hash: 'genesis',
    address: HUMAN_ADDRESS,
    public_key_sha256: '4'.repeat(64),
    economic_device_id: `device-${HUMAN_USER_ID}`,
    created_at_ms: createdAt,
    genesis_qualification_id: `gq-${HUMAN_USER_ID}`,
    standard_accrual_status: 'complete',
    standard_accrual_acknowledged_at_ms: createdAt,
  });
  db.store.set(
    `${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(HUMAN_ADDRESS)}`,
    {
      schema_version: 'native-wallet-address-index/v1',
      chain_id: 8453,
      address: HUMAN_ADDRESS,
      wallet_id: HUMAN_WALLET_ID,
      owner_type: 'human',
      owner_id: HUMAN_USER_ID,
      created_at_ms: createdAt,
    },
  );
  const target = {
    direction: 'inbound' as const,
    chainId: 8453,
    address: HUMAN_ADDRESS,
    walletId: HUMAN_WALLET_ID,
    agentId: HUMAN_USER_ID,
    eligibilityStartBlock: fence.eligibility_start_block,
  };
  db.store.set(`${WATCHER_ADDRESS_ADMISSION_COLLECTION}/${watcherAddressAdmissionDocId(target)}`, {
    schema_version: 'pvt-watcher-address-admission/v3',
    direction: 'inbound',
    chain_id: 8453,
    address: HUMAN_ADDRESS,
    wallet_id: HUMAN_WALLET_ID,
    agent_id: HUMAN_USER_ID,
    eligibility_start_block: fence.eligibility_start_block,
    state: 'live',
    backfill_next_block: fence.eligibility_start_block,
    catch_up_through_block: fence.eligibility_start_block - 1,
    membership_generation: 1,
    generation_fenced_at_registration: true,
    revision: 1,
    created_at_ms: createdAt,
    updated_at_ms: createdAt,
  });
}

describe(' follow-up (b): inbound admission binds to the SHARED parser', () => {
  const parser = parseCanonicalNativeAddressIndex as jest.MockedFunction<
    typeof parseCanonicalNativeAddressIndex
  >;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    parser.mockClear();
    listProvenAddresses.mockClear();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('mutating the shared parser flips inbound\'s admission decision for the same rows', async () => {
    const db = createFakeFirestore();
    seedCanonicalHumanAuthority(db);
    const inbound = buildBaseInboundDeps({ db: db as unknown as Firestore } as AgentBankDeps);

    // Baseline: the canonical wallet is admitted THROUGH the shared parser.
    const admitted = await inbound.listWatchedWallets();
    expect(admitted).toEqual([
      expect.objectContaining({
        walletId: HUMAN_WALLET_ID,
        agentId: HUMAN_USER_ID,
        address: HUMAN_ADDRESS,
        ownerType: 'human',
        eligibilityStartBlock: 141,
      }),
    ]);
    // A stale private copy never reaches this spy (pre-fix: 0 calls).
    expect(parser).toHaveBeenCalledTimes(1);
    expect(parser).toHaveBeenCalledWith(
      expect.objectContaining({ wallet_id: HUMAN_WALLET_ID, owner_type: 'human' }),
      nativeWalletAddressIndexId(HUMAN_ADDRESS),
    );

    // Mutation: the shared parser now rejects the row. The identical stored
    // documents must now be EXCLUDED — proving the decision is the shared
    // parser's, not a local copy's.
    parser.mockImplementationOnce(() => {
      throw new Error('watched_address_enumeration_invalid:native_address_index:mutated');
    });
    const afterMutation = await inbound.listWatchedWallets();
    expect(afterMutation).toEqual([]);
    expect(parser).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('wallet excluded this cycle'),
      expect.objectContaining({
        message: 'watched_address_enumeration_invalid:native_address_index:mutated',
      }),
    );

    // Restoration: the real parser admits the wallet again (the mutation was
    // one-shot), so the exclusion above was the mutation and nothing else.
    expect(await inbound.listWatchedWallets()).toHaveLength(1);
  });
});
