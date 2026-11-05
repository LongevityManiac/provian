import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';

let mockFirestore: Firestore;
jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: () => mockFirestore,
  },
}));

import { checkDevicePERateLimit } from './device-pe-rate-limiter';

describe('device PE rate-limit retry identity', () => {
  it('lets the same canonical PE resume without consuming a second setup slot', async () => {
    const fake = createFakeFirestore();
    mockFirestore = fake as unknown as Firestore;
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      await expect(checkDevicePERateLimit(
        'secure-enclave-device',
        null,
        'wallet_created',
        'pe_original',
      )).resolves.toMatchObject({ allowed: true });

      // Simulate a crash before pe_history: retrying the exact marker is still
      // allowed, and the timestamp list remains one slot.
      await expect(checkDevicePERateLimit(
        'secure-enclave-device',
        null,
        'wallet_created',
        'pe_original',
      )).resolves.toMatchObject({ allowed: true });

      await expect(checkDevicePERateLimit(
        'secure-enclave-device',
        null,
        'wallet_created',
        'pe_different',
      )).resolves.toMatchObject({ allowed: false });
      expect(fake.store.get('device_pe_rate_limits/secure-enclave-device_wallet_created'))
        .toMatchObject({
          recorded_at: [10_000],
          recorded_pe_ids: { pe_original: 10_000 },
        });
    } finally {
      now.mockRestore();
    }
  });
});
