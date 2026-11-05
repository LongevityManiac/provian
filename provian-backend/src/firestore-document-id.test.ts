/**
 * F62 — isValidFirestoreDocumentId is the guard that keeps a caller-supplied id
 * from ever reaching Firestore `.doc()` (which throws synchronously on a '/', and
 * in an async middleware turns that throw into a process-killing unhandled
 * rejection). RED controls: the exact crash trigger ('/') and the reserved shapes
 * MUST be rejected; real relay ids MUST pass.
 */
import { describe, it, expect } from '@jest/globals';
import { isValidFirestoreDocumentId } from './firestore-document-id';

describe('isValidFirestoreDocumentId (F62 crash guard)', () => {
  it('RED: rejects a value containing "/" (the exact `.doc()` throw trigger)', () => {
    expect(isValidFirestoreDocumentId('pvn_live_/aaaaaaaaaaaaaa')).toBe(false);
    expect(isValidFirestoreDocumentId('a/b')).toBe(false);
    expect(isValidFirestoreDocumentId('usr_1/../secret')).toBe(false);
  });

  it('RED: rejects the other reserved shapes Firestore refuses', () => {
    expect(isValidFirestoreDocumentId('')).toBe(false);
    expect(isValidFirestoreDocumentId('.')).toBe(false);
    expect(isValidFirestoreDocumentId('..')).toBe(false);
    expect(isValidFirestoreDocumentId('__proto__')).toBe(false); // __.*__
    expect(isValidFirestoreDocumentId('__id5__')).toBe(false);
    expect(isValidFirestoreDocumentId('a'.repeat(1501))).toBe(false); // > 1500 bytes
  });

  it('RED: rejects non-strings (no id at all)', () => {
    expect(isValidFirestoreDocumentId(undefined)).toBe(false);
    expect(isValidFirestoreDocumentId(null)).toBe(false);
    expect(isValidFirestoreDocumentId(42 as unknown)).toBe(false);
  });

  it('accepts the real relay ids that must keep working', () => {
    expect(isValidFirestoreDocumentId('pvn_live_0123456789abcde')).toBe(true); // api-key prefix
    expect(isValidFirestoreDocumentId('user_2f1c0e2a-1111-2222-3333-444455556666')).toBe(true);
    expect(isValidFirestoreDocumentId('usr_abc')).toBe(true);
    expect(isValidFirestoreDocumentId('pdk_0123456789abcdef01')).toBe(true); // device-key prefix
    expect(isValidFirestoreDocumentId('device_abc-123')).toBe(true);
    // A '.' inside an id is allowed (only exactly '.'/'..' are reserved).
    expect(isValidFirestoreDocumentId('a.b')).toBe(true);
  });
});
