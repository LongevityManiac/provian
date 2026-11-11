import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const f = vi.hoisted(() => ({ local: vi.fn(), recover: vi.fn(), inspect: vi.fn() }));
vi.mock('../local-keystore-secret', () => ({ readLocalKeystoreSecret: f.local }));
vi.mock('../recourse-recovery', () => ({ recoverRecourseAgent: f.recover }));
vi.mock('../active-hash-delivery', () => ({ reconcileActiveHashWalletOperation: f.inspect }));
const originalArgs = [...process.argv], originalExit = process.exitCode;
beforeEach(() => { vi.resetModules(); f.local.mockReset(); f.recover.mockReset(); f.inspect.mockReset();
  f.local.mockReturnValue(null); f.recover.mockResolvedValue({ destination: 'recovered address' }); f.inspect.mockResolvedValue({ status: 'pending' });
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.argv = [...originalArgs]; process.exitCode = originalExit; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
test('explicit custom passphrase reaches both recovery and receipt-only CLI paths without being printed', async () => {
  const passphrase = 'original manual passphrase'; vi.stubEnv('PROVIAN_KEYSTORE_PASSPHRASE', passphrase);
  process.argv = ['node', 'recover-recourse']; await import('./recover-recourse.js');
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalledWith(expect.objectContaining({ passphrase })));
  process.argv = ['node', 'prepare-break-recovery', 'account-inspect', `0x${'11'.repeat(32)}`]; await import('./prepare-break-recovery.js');
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledWith(expect.objectContaining({ passphrase })));
  expect(f.local).not.toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(passphrase);
});
test('without an explicit passphrase the generated local secret remains the source', async () => {
  vi.stubEnv('PROVIAN_KEYSTORE_PASSPHRASE', undefined); const passphrase = 'ab'.repeat(32); f.local.mockReturnValue(passphrase);
  process.argv = ['node', 'recover-recourse']; await import('./recover-recourse.js');
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalledWith(expect.objectContaining({ passphrase })));
  expect(f.local).toHaveBeenCalledOnce();
});
