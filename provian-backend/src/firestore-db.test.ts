/**
 * firestore-db: ONE setting (`FIRESTORE_DATABASE_ID`) selects the relay's
 * Firestore database.
 */

const mockDefaultDb = { kind: 'default-db' };
const mockApp = { name: '[DEFAULT]' };
const mockFirestore = jest.fn(() => mockDefaultDb);
const mockAppFn = jest.fn(() => mockApp);

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { firestore: () => mockFirestore(), app: () => mockAppFn() },
}));

const mockNamedDbs = new Map<string, { id: string; settings: jest.Mock }>();
const mockGetFirestore = jest.fn((app: unknown, id: string) => {
  let db = mockNamedDbs.get(id);
  if (!db) {
    db = { id, settings: jest.fn() };
    mockNamedDbs.set(id, db);
  }
  return db;
});
jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  getFirestore: (app: unknown, id: string) => mockGetFirestore(app, id),
}));

import {
  __resetRelayDbCacheForTests,
  isValidFirestoreDatabaseId,
  relayDatabaseId,
  relayDb,
} from './firestore-db';
import { RELAY_FIRESTORE_SETTINGS } from './firestore-settings';

const ORIGINAL = process.env.FIRESTORE_DATABASE_ID;

beforeEach(() => {
  delete process.env.FIRESTORE_DATABASE_ID;
  __resetRelayDbCacheForTests();
  mockNamedDbs.clear();
  mockFirestore.mockClear();
  mockGetFirestore.mockClear();
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.FIRESTORE_DATABASE_ID;
  else process.env.FIRESTORE_DATABASE_ID = ORIGINAL;
});

describe('relayDatabaseId', () => {
  it('is (default) when unset, empty, or whitespace', () => {
    expect(relayDatabaseId()).toBe('(default)');
    process.env.FIRESTORE_DATABASE_ID = '';
    expect(relayDatabaseId()).toBe('(default)');
    process.env.FIRESTORE_DATABASE_ID = '   ';
    expect(relayDatabaseId()).toBe('(default)');
  });

  it('returns a trimmed named id', () => {
    process.env.FIRESTORE_DATABASE_ID = '  relay  ';
    expect(relayDatabaseId()).toBe('relay');
    process.env.FIRESTORE_DATABASE_ID = '(default)';
    expect(relayDatabaseId()).toBe('(default)');
  });

  it.each([
    'Relay',          // uppercase
    'rel',            // too short
    '1relay',         // must start with a letter
    'relay-',         // must not end with a hyphen
    'relay_db',       // underscore
    '(default',
    'a'.repeat(64),   // too long
    'relay/../x',
  ])('REFUSES the invalid id %p (fail closed, never a silent fallback to (default))', (bad) => {
    process.env.FIRESTORE_DATABASE_ID = bad;
    expect(isValidFirestoreDatabaseId(bad)).toBe(false);
    expect(() => relayDatabaseId()).toThrow(/not a valid Firestore database id/);
    expect(() => relayDb()).toThrow(/not a valid Firestore database id/);
    expect(mockFirestore).not.toHaveBeenCalled();
    expect(mockGetFirestore).not.toHaveBeenCalled();
  });
});

describe('relayDb', () => {
  it('returns admin.firestore() exactly for (default), on every call, with no named client', () => {
    expect(relayDb()).toBe(mockDefaultDb);
    expect(relayDb()).toBe(mockDefaultDb);
    expect(mockFirestore).toHaveBeenCalledTimes(2);
    expect(mockGetFirestore).not.toHaveBeenCalled();
  });

  it('returns ONE cached named client with the relay settings applied exactly once', () => {
    process.env.FIRESTORE_DATABASE_ID = 'relay';
    const first = relayDb();
    const second = relayDb();
    expect(first).toBe(second);
    expect(mockGetFirestore).toHaveBeenCalledTimes(1);
    expect(mockGetFirestore).toHaveBeenCalledWith(mockApp, 'relay');
    expect(mockFirestore).not.toHaveBeenCalled();
    const named = mockNamedDbs.get('relay');
    expect(named?.settings).toHaveBeenCalledTimes(1);
    expect(named?.settings).toHaveBeenCalledWith(RELAY_FIRESTORE_SETTINGS);

    // A cache reset (firebase-admin still holds the same instance) must not
    // re-apply settings — Firestore refuses a second settings() call.
    __resetRelayDbCacheForTests();
    expect(relayDb()).toBe(first);
    expect(named?.settings).toHaveBeenCalledTimes(1);
  });

  it('follows the env var: rollback to (default) returns admin.firestore() again', () => {
    process.env.FIRESTORE_DATABASE_ID = 'relay';
    expect(relayDb()).not.toBe(mockDefaultDb);
    delete process.env.FIRESTORE_DATABASE_ID;
    expect(relayDb()).toBe(mockDefaultDb);
  });
});
