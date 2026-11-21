import { beforeEach, expect, test, vi } from 'vitest';
import { getBytes } from 'ethers';
vi.mock('../NotificationService', () => ({ default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null } }));
vi.mock('../../core/network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: `0x${'11'.repeat(20)}` }) } }));
import RelayAPIService, { RECOURSE_BINDING_AWAITING_FINALITY } from '../RelayAPIService';
import { apiFetch } from '../../core/network/apiFetch';
import { privateRecourseIntent, type RecoursePrivateAuthorization } from '../../core/recourse/private-access-data';
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
const identity = `0x${'11'.repeat(32)}`, path = `owner-operations/0x${'22'.repeat(32)}`;
const material = () => ({ identity, secret: new Uint8Array(32).fill(3), signingSeed: new Uint8Array(32).fill(4) });
test('membership transport preserves only the join finality response', async () => {
  vi.spyOn(RelayAPIService, 'getAuthSecret').mockResolvedValue('test-secret');
  vi.spyOn(RelayAPIService, 'getUserId').mockResolvedValue('test-owner');
  const pending = (status: number) => new Response(JSON.stringify({ error: RECOURSE_BINDING_AWAITING_FINALITY }), { status });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  vi.mocked(apiFetch).mockResolvedValueOnce(pending(409)).mockResolvedValueOnce(pending(503)).mockResolvedValueOnce(pending(409));
  await expect(RelayAPIService.recourseRequest('membership-transitions', { kind: 'join' }))
    .rejects.toThrow(RECOURSE_BINDING_AWAITING_FINALITY);
  await expect(RelayAPIService.recourseRequest('membership-transitions', { kind: 'join' })).rejects.toThrow('recourse_request_refused');
  await expect(RelayAPIService.recourseRequest('pool')).rejects.toThrow('recourse_request_refused');
  expect(timers.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(3);
  expect(timers.mock.calls.filter(([, delay]) => delay === 15_000)).toHaveLength(0);
});
test('actual phone recovery transport requires a private proof and sends it only in a POST body', async () => {
  await expect(RelayAPIService.recourseRecoveryRequest(path)).rejects.toThrow('private_access_required');
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ status: 'queued' })));
  expect(await RelayAPIService.recourseRecoveryRequest(path, undefined, material())).toEqual({ status: 'queued' });
  const [url, options] = vi.mocked(apiFetch).mock.calls[0];
  expect(String(url)).toBe(`https://relay.test/v1/recourse/${path}`); expect(options?.method).toBe('POST');
  const body = JSON.parse(String(options?.body)) as { authorization: RecoursePrivateAuthorization; request: unknown };
  expect(body.request).toBeNull(); expect(body.authorization.identity).toBe(identity);
  expect(String(url)).not.toContain(body.authorization.recoverySecret);
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  expect(slh_dsa_sha2_128s.verify(getBytes(body.authorization.signature), getBytes(privateRecourseIntent(body.authorization, path)),
    getBytes(body.authorization.publicKey))).toBe(true);
}, 15000);
test('only private refusals permit predecessor-credential retry; the independent recovery proof is unchanged', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await expect(RelayAPIService.recourseRecoveryRequest(path, undefined, material())).rejects.toThrow('recourse_private_unavailable');
  await expect(RelayAPIService.recourseRecoveryRequest(path, undefined, material())).rejects.toThrow('recourse_recovery_refused');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}'));
  const request = { independent: 'fresh-key-proof' };
  await RelayAPIService.recourseRecoveryRequest('recover-human', request);
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[2][1]?.body))).toEqual(request);
}, 15000);

test.each([`restoration-history/${identity}`, `owner-recovery-state/${identity}/0`])(
  'recovery discovery transport binds its private proof to %s', async route => {
    await expect(RelayAPIService.recourseRecoveryRequest(route)).rejects.toThrow('private_access_required');
    expect(apiFetch).not.toHaveBeenCalled();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ candidates: [] })));
    await expect(RelayAPIService.recourseRecoveryRequest(route, undefined, material())).resolves.toEqual({ candidates: [] });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(String(url)).toBe(`https://relay.test/v1/recourse/${route}`);
    expect(options?.method).toBe('POST');
    const body = JSON.parse(String(options?.body)) as { authorization: RecoursePrivateAuthorization; request: unknown };
    expect(body.request).toBeNull();
    const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
    expect(slh_dsa_sha2_128s.verify(getBytes(body.authorization.signature), getBytes(privateRecourseIntent(body.authorization, route)),
      getBytes(body.authorization.publicKey))).toBe(true);
    expect(slh_dsa_sha2_128s.verify(getBytes(body.authorization.signature), getBytes(privateRecourseIntent(body.authorization, path)),
      getBytes(body.authorization.publicKey))).toBe(false);
  }, 15000);
test.each([`restoration-history/${identity}?public=true`, `restoration-history/${identity}/extra`,
  `owner-recovery-state/${identity}/-1`, `owner-recovery-state/${identity}/01`,
  `owner-recovery-state/${identity}/1/extra`, `owner-recovery-state/${identity}/1?public=true`,
  'https://elsewhere.test/recover-human', '../recover-human'])(
  'recovery discovery rejects malformed or unlisted route %s before transport', async route => {
    await expect(RelayAPIService.recourseRecoveryRequest(route, undefined, material())).rejects.toThrow('recourse_recovery_path_invalid');
    expect(apiFetch).not.toHaveBeenCalled();
  });
