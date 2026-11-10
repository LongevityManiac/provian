import { createHash, createHmac, randomUUID } from 'crypto';
import { verifyWalletAuthTokenWithBinding, type WalletAuthDeps } from './wallet-auth';

const binding = { method: 'POST', path: '/v1/agent/wallet/test/human-unlink', bodyHash: createHash('sha256').update('{}').digest('hex') };
function token(secret: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'owner', device_id: 'device', iat: Date.now(),
    exp: Date.now() + 90000, jti: randomUUID(), mth: binding.method, pth: binding.path, bh: binding.bodyHash })).toString('base64');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
function fixture() {
  const get = jest.fn(async () => ({ exists: true, data: () => ({ secret: 'replacement' }) }));
  const cached = jest.fn(async () => 'stolen');
  const deps = { db: { collection: () => ({ doc: () => ({ get }) }) }, cache: {
    getUserAuthSecret: cached, isEnabled: () => true, setNx: async () => true,
  } } as unknown as WalletAuthDeps;
  return { deps, get, cached };
}
test('the retired credential is refused even while Redis retains it', async () => {
  const f = fixture();
  expect(await verifyWalletAuthTokenWithBinding(token('stolen'), binding, f.deps)).toMatchObject({ ok: false, status: 401 });
  expect(await verifyWalletAuthTokenWithBinding(token('replacement'), binding, f.deps)).toMatchObject({ ok: true, userId: 'owner' });
  expect(f.cached).not.toHaveBeenCalled();
});
test('a database outage never falls back to a cached credential', async () => {
  const f = fixture(); f.get.mockRejectedValueOnce(new Error('offline'));
  expect(await verifyWalletAuthTokenWithBinding(token('stolen'), binding, f.deps)).toEqual({ ok: false, status: 503, error: 'Auth state unavailable' });
  expect(f.cached).not.toHaveBeenCalled();
});
