import { withBiometricAction } from '../../core/security/biometricAction';
import {describe,it,expect,vi,beforeEach} from 'vitest';
import {createHmac} from 'crypto';
vi.mock('../NotificationService',()=>({default:{getBackendUrl:async()=> 'https://relay.test',getPushToken:async()=>null}}));
vi.mock('../../core/network/apiFetch',()=>({apiFetch:vi.fn(),default:vi.fn()}));
vi.mock('../../store/walletStore',()=>({useWalletStore:{getState:()=>({address:'0x'+'11'.repeat(20)})}}));
import RelayAPIService from '../RelayAPIService';
import {apiFetch} from '../../core/network/apiFetch';
import {sealPrivatePricing} from '../../core/meter/privatePricing';
import {openPrivateAuthenticatedRequest,unwrapPrivateBatch} from '../../../provian-backend/src/core/meter/private-pricing';
const first='existing-wallet-auth-secret',renewed='existing-recovered-wallet-auth-secret';
const svc=RelayAPIService as any;
beforeEach(()=>{vi.restoreAllMocks();vi.mocked(apiFetch).mockReset();vi.spyOn(svc,'getUserId').mockResolvedValue('user_private_fixture');vi.spyOn(svc,'getDeviceId').mockResolvedValue('device_fixture');});
function response(status:number){return {status,ok:status===200,text:async()=> '{}'} as Response;}
function assertToken(init:RequestInit,secret:string){const token=new Headers(init.headers).get('authorization')!.slice(7),split=token.lastIndexOf('.');expect(token.slice(split+1)).toBe(createHmac('sha256',secret).update(token.slice(0,split)).digest('hex'));}
describe(' actual phone authenticated request privacy and recovery',()=>{
    it('RED wrapping an already-encrypted cursor resets pagination; actual401 retry re-encrypts the original cursor', async () => {
        let secret = first; vi.spyOn(svc, 'getAuthSecret').mockImplementation(async () => secret); vi.spyOn(svc, 'recoverRelayCredentials').mockImplementation(async () => { secret = renewed; });
        const calls: { url: string; init: RequestInit }[] = []; vi.mocked(apiFetch).mockImplementation(async (url, init) => { calls.push({ url: String(url), init: init! }); return response(calls.length === 1 ? 401 : 200); });
        await withBiometricAction('request', action => svc.makeAuthenticatedRequest('/v1/meter/mobile/mailbox?after=private-PE-derived-cursor&limit=2', {}, true, action));
        expect(calls).toHaveLength(2);
        for (const [i, call] of calls.entries()) {
            expect(call.url).not.toContain('private-PE-derived-cursor'); assertToken(call.init, i === 0 ? first : renewed);
            const req = { query: Object.fromEntries(new URL(call.url).searchParams), originalUrl: call.url.replace('https://relay.test', '') }; openPrivateAuthenticatedRequest(req, i === 0 ? first : renewed); expect(req.query).toEqual({ after: 'private-PE-derived-cursor', limit: '2' });
        }
        const bad = { query: { private_query: JSON.stringify(sealPrivatePricing({ request: { private_query: 'previous-ciphertext' } }, renewed, 'provian-private-request:v1:/v1/meter/mobile/mailbox')) }, originalUrl: '/v1/meter/mobile/mailbox' }; openPrivateAuthenticatedRequest(bad, renewed); expect(bad.query).not.toHaveProperty('after');
    });
    it('RED old-secret batch fails after credential recovery; actual retry rebuilds only transport ciphertext and retains the batch', async () => {
        let secret = first; vi.spyOn(svc, 'getAuthSecret').mockImplementation(async () => secret); vi.spyOn(svc, 'recoverRelayCredentials').mockImplementation(async () => { secret = renewed; });
        const calls: RequestInit[] = []; vi.mocked(apiFetch).mockImplementation(async (_url, init) => { calls.push(init!); return response(calls.length === 1 ? 401 : 200); });
        const batch = { device_id: 'device_fixture', seq: 1, prev_batch_hash: 'private-previous-hash', acts: [], acts_root: 'immutable-root' }, openings = {};
        const old = { private_batch: sealPrivatePricing({ batch, openings }, first, 'provian-private-batch:v1') }; expect(() => unwrapPrivateBatch(old, renewed)).toThrow();
        await withBiometricAction('batch', action => svc.meterRequest('POST', '/v1/meter/batch/mobile', undefined, (current: string) => JSON.stringify({ private_batch: sealPrivatePricing({ batch, openings }, current, 'provian-private-batch:v1') }), action));
        expect(calls).toHaveLength(2); for (const [i, init] of calls.entries()) { assertToken(init, i === 0 ? first : renewed); expect(unwrapPrivateBatch(JSON.parse(String(init.body)), i === 0 ? first : renewed).batch).toEqual(batch); expect(String(init.body)).not.toContain('private-previous-hash'); }
    });
 it('one captured credential binds ciphertext and token even if the next credential read would change',async()=>{
  const read=vi.spyOn(svc,'getAuthSecret').mockResolvedValueOnce(first).mockResolvedValue(renewed);
  let sent:RequestInit|undefined;vi.mocked(apiFetch).mockImplementation(async(_url,init)=>{sent=init;return response(200);});
  const original={pe_facts:[{metadata:{repo:'private-repo'}}],burn_tx:'existing-burn'};
  await svc.makeAuthenticatedRequest('/v1/wallet/present',{method:'POST',body:JSON.stringify(original)},false);
  expect(read).toHaveBeenCalledTimes(1);assertToken(sent!,first);
  const req={body:JSON.parse(String(sent!.body)),originalUrl:'/v1/wallet/present'};expect(String(sent!.body)).not.toContain('private-repo');openPrivateAuthenticatedRequest(req,first);expect(req.body).toEqual(original);
 });
});
