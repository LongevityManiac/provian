/**
 * The escrow admin-key acknowledgement shows once per wallet: a recorded acknowledgement is read
 * back for the same wallet (any address casing), never for another, and an unreadable flag shows
 * the sheet again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { escrowAdminAckKey, hasAcknowledgedEscrowAdmin, recordEscrowAdminAck } from './escrowAdminAck';

const A = '0xAbCdEf0000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.spyOn(AsyncStorage, 'getItem').mockImplementation(async (k: string) => store.get(k) ?? null);
  vi.spyOn(AsyncStorage, 'setItem').mockImplementation(async (k: string, v: string) => { store.set(k, v); });
});

describe('escrow admin-key acknowledgement', () => {
  it('is not acknowledged before the person acknowledges it', async () => {
    expect(await hasAcknowledgedEscrowAdmin(A)).toBe(false);
  });

  it('is acknowledged for the same wallet after recording, whatever the address casing', async () => {
    await recordEscrowAdminAck(A);
    expect(store.get(escrowAdminAckKey(A))).toBe('true');
    expect(await hasAcknowledgedEscrowAdmin(A)).toBe(true);
    expect(await hasAcknowledgedEscrowAdmin(A.toLowerCase())).toBe(true);
  });

  it('RED: one wallet acknowledging does not acknowledge another', async () => {
    await recordEscrowAdminAck(A);
    expect(await hasAcknowledgedEscrowAdmin(B)).toBe(false);
  });

  it('RED: no wallet, or an unreadable flag, shows the sheet again', async () => {
    await recordEscrowAdminAck(A);
    expect(await hasAcknowledgedEscrowAdmin(null)).toBe(false);
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage unavailable'));
    expect(await hasAcknowledgedEscrowAdmin(A)).toBe(false);
  });

  it('a failed write does not throw (the sheet simply shows again)', async () => {
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    await expect(recordEscrowAdminAck(A)).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });
});
