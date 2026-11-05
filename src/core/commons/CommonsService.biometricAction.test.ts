import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
vi.mock('../../services/NotificationService', () => ({ default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null } }));
vi.mock('../network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: '0x' + '11'.repeat(20) }) } }));
import RelayAPIService from '../../services/RelayAPIService';
import { apiFetch } from '../network/apiFetch';
import * as CommonsService from './CommonsService';
import * as EscrowActions from '../wallet/HumanJobEscrowActions';
import { releaseJobPayment } from './jobEscrowFlows';
import { openPrivateAuthenticatedRequest } from '../../../provian-backend/src/core/meter/private-pricing';

const first = 'existing-wallet-secret', renewed = 'refreshed-wallet-secret';
const service = RelayAPIService as unknown as {
    getUserId(): Promise<string | null>; getDeviceId(): Promise<string>;
    authToken: string | null; ensureRegistered(action?: BiometricAction): Promise<void>;
};
beforeEach(async () => {
    vi.restoreAllMocks(); vi.mocked(apiFetch).mockReset();
    await SecureStore.deleteItemAsync('commons_session_token');
    vi.spyOn(service, 'getUserId').mockResolvedValue('fixture_user');
    vi.spyOn(service, 'getDeviceId').mockResolvedValue('fixture_device');
    vi.spyOn(LocalAuthentication, 'hasHardwareAsync').mockResolvedValue(true);
    vi.spyOn(LocalAuthentication, 'isEnrolledAsync').mockResolvedValue(true);
    vi.spyOn(LocalAuthentication, 'authenticateAsync').mockResolvedValue({ success: true });
});
function response(status: number) { return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }); }
function assertPrivateBody(init: RequestInit, secret: string, path: string, body: unknown) {
    const token = new Headers(init.headers).get('authorization')!.slice(7), split = token.lastIndexOf('.');
    expect(token.slice(split + 1)).toBe(createHmac('sha256', secret).update(token.slice(0, split)).digest('hex'));
    const request = { body: JSON.parse(String(init.body)), originalUrl: path };
    openPrivateAuthenticatedRequest(request, secret);
    expect(request.body).toEqual(body);
}
describe('Commons action propagation through actual wallet transport', () => {
    it('production escrow release carries one approval through its first cold read, signer and relay notification', async () => {
        const target = { contract_address: '0x96560fDF49e563eFCdc2d502934676DC074732d0', chain: 'base', onchain_escrow_id: '0x' + 'cd'.repeat(32), depositor_address: '0x' + '11'.repeat(20) };
        let secret: string | null = null, approved: BiometricAction | undefined;
        vi.spyOn(RelayAPIService, 'getAuthSecret').mockImplementation(async () => secret);
        const recover = vi.spyOn(RelayAPIService, 'recoverRelayCredentials').mockImplementation(async (_wallet, action) => {
            assertBiometricAction(action); approved = action; secret = renewed;
            return { userId: 'fixture_user', authSecret: renewed, recovered: true };
        });
        const sign = vi.spyOn(EscrowActions, 'runEscrowActionOnChain').mockImplementation(async (_kind, actual, _reason, action) => {
            assertBiometricAction(action); expect(action).toBe(approved); expect(actual).toEqual(target);
            return { txHash: '0xconfirmed', alreadyDone: false, onchainEscrowId: target.onchain_escrow_id };
        });
        vi.mocked(apiFetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/escrow') ? target : { status: 'completed', payment_released: true }), { status: 200 }));
        const result = await releaseJobPayment('job_1', 'Release payment');
        expect(result.txHash).toBe('0xconfirmed'); expect(result.pending).toBe(false);
        expect(recover).toHaveBeenCalledWith('0x' + '11'.repeat(20), approved);
        expect(sign).toHaveBeenCalledTimes(1); expect(apiFetch).toHaveBeenCalledTimes(2);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });
    it('a cold application recovers credentials under its one approval before sending', async () => {
        let secret: string | null = null;
        vi.spyOn(RelayAPIService, 'getAuthSecret').mockImplementation(async () => secret);
        const recover = vi.spyOn(RelayAPIService, 'recoverRelayCredentials').mockImplementation(async (_wallet, action) => {
            assertBiometricAction(action); secret = renewed;
            return { userId: 'fixture_user', authSecret: renewed, recovered: true };
        });
        vi.mocked(apiFetch).mockResolvedValue(response(200));
        let approved!: BiometricAction;
        await withBiometricAction('Apply', action => { approved = action; return CommonsService.applyForHumanJob('job_1', { cover_note: 'private application' }, action); });
        expect(recover).toHaveBeenCalledWith('0x' + '11'.repeat(20), approved);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        expect(apiFetch).toHaveBeenCalledTimes(1);
        assertPrivateBody(vi.mocked(apiFetch).mock.calls[0][1]!, renewed, '/v1/commons/jobs/job_1/apply', { cover_note: 'private application' });
    });
    it('a 401 rebuilds ciphertext and request-bound auth after rotation, with no second approval', async () => {
        let secret = first;
        vi.spyOn(RelayAPIService, 'getAuthSecret').mockImplementation(async () => secret);
        const recover = vi.spyOn(RelayAPIService, 'recoverRelayCredentials').mockImplementation(async (_wallet, action) => {
            assertBiometricAction(action); secret = renewed;
            return { userId: 'fixture_user', authSecret: renewed, recovered: true };
        });
        vi.mocked(apiFetch).mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));
        let approved!: BiometricAction;
        await withBiometricAction('Publish messaging key', action => { approved = action; return CommonsService.publishMessageKey('public-key-fixture', action); });
        expect(recover).toHaveBeenCalledWith('0x' + '11'.repeat(20), approved);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        const calls = vi.mocked(apiFetch).mock.calls;
        expect(calls).toHaveLength(2);
        assertPrivateBody(calls[0][1]!, first, '/v1/threads/keys', { pubkey: 'public-key-fixture' });
        assertPrivateBody(calls[1][1]!, renewed, '/v1/threads/keys', { pubkey: 'public-key-fixture' });
    });
    it('RED: an unapproved background request never starts credential recovery or biometric UI', async () => {
        vi.spyOn(RelayAPIService, 'getAuthSecret').mockResolvedValue(first);
        const recover = vi.spyOn(RelayAPIService, 'recoverRelayCredentials');
        vi.mocked(apiFetch).mockResolvedValue(response(401));
        await expect(CommonsService.publishMessageKey('public-key-fixture')).rejects.toMatchObject({ status: 401 });
        expect(recover).not.toHaveBeenCalled();
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    });
    it('the standalone token helper threads a live action through cold registration without prompting again', async () => {
        service.authToken = null;
        const register = vi.spyOn(service, 'ensureRegistered').mockImplementation(async action => { assertBiometricAction(action); service.authToken = renewed; });
        let approved!: BiometricAction;
        await withBiometricAction('Token', async action => {
            approved = action;
            expect(await RelayAPIService.getSignedAuthToken('GET', '/v1/commons/stats', undefined, undefined, action)).toBeTruthy();
        });
        expect(register).toHaveBeenCalledWith(approved);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });
    it('RED: a finished action cannot authorize a later cold credential refresh', async () => {
        let ended!: BiometricAction;
        await withBiometricAction('Earlier action', async action => { ended = action; });
        service.authToken = null;
        const register = vi.spyOn(service, 'ensureRegistered');
        await expect(RelayAPIService.getSignedAuthToken('GET', '/v1/commons/stats', undefined, undefined, ended)).rejects.toThrow('live biometric action');
        expect(register).not.toHaveBeenCalled();
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });
});
