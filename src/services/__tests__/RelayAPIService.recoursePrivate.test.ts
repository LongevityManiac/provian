import { beforeEach, expect, test, vi } from 'vitest';
import { getBytes } from 'ethers';
vi.mock('../NotificationService', () => ({ default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null } }));
vi.mock('../../core/network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: `0x${'11'.repeat(20)}` }) } }));
import RelayAPIService from '../RelayAPIService';
import { apiFetch } from '../../core/network/apiFetch';
import { privateRecourseIntent, type RecoursePrivateAuthorization } from '../../core/recourse/private-access-data';
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
const identity = `0x${'11'.repeat(32)}`, path = `owner-operations/0x${'22'.repeat(32)}`;
const material = () => ({ identity, secret: new Uint8Array(32).fill(3), signingSeed: new Uint8Array(32).fill(4) });
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
