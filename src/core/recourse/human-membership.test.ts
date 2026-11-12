import { beforeEach, expect, test, vi } from 'vitest';
import { getBytes, hashMessage } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import { signHumanMembershipBytes, signHumanMembershipDeparture } from './human-membership';
const f = vi.hoisted(() => ({ selected: '', signer: '', getKey: vi.fn(async () => 'private'), hash: vi.fn(), sign: vi.fn(async () => 'curve-signature'), bound:vi.fn(), hashSign:vi.fn(async()=> 'bound-signature'), biometric:vi.fn(), departure:vi.fn(), departureRoot:vi.fn(), departureSign:vi.fn(async()=> 'departure-signature'), network:{deployment:async()=>({blockHash:'block'}),rpcs:[{request:async()=> '0x6000'},{request:async()=> '0x6000'}]}, seed:new Uint8Array(32).fill(1) }));
vi.mock('../../services/RelayAPIService', () => ({ default: { recourseRequest: vi.fn() } }));
vi.mock('../wallet/SeedManager', () => ({ default: { getMnemonic: async () => 'backup', getEVMPrivateKey: f.getKey } }));
vi.mock('../security/ActionWallet', () => ({ ActionWallet: class { address = f.signer; signMessage = f.sign; } }));
vi.mock('../security/biometricAction', () => ({ withBiometricAction: vi.fn(), assertBiometricAction:f.biometric }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => f.network }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: f.selected }) } }));
vi.mock('../../i18n/translate', () => ({ translate: (_key: string, fallback: string) => fallback }));
vi.mock('./human-hash-message', () => ({ signHumanHashDigest: f.hash }));
vi.mock('./human-bound-hash-account',()=>({discoverBoundHumanHashAccount:f.bound,discoverBoundHumanDepartureAccount:f.departure}));
vi.mock('./human-secret',()=>({humanBreakKey:()=>f.seed,humanMembershipExitSecret:vi.fn()}));
vi.mock('./hash-account',()=>({signHashAccountMessage:f.hashSign,signHashAccountDeparture:f.departureSign}));
vi.mock('./hash-account-chain',()=>({readHashAccountDepartureRoot:f.departureRoot}));
vi.mock('./hash-authorization',()=>({recoverySigningRoot:async()=> 'initial-root'}));
const account = `0x${'11'.repeat(20)}`, bytes = getBytes(`0x${'22'.repeat(32)}`), action = {} as BiometricAction;
beforeEach(() => { vi.clearAllMocks(); f.selected = account; f.signer = account; f.hash.mockResolvedValue(null); });
test('managed curve wallet signs bytes only when the selected and derived accounts both match', async () => {
  expect(await signHumanMembershipBytes(account, bytes, action)).toBe('curve-signature');
  expect(f.hash).toHaveBeenCalledWith('backup', account, hashMessage(bytes), action);
  expect(f.sign).toHaveBeenCalledWith(bytes);
  f.sign.mockClear(); f.getKey.mockClear(); f.selected = `0x${'33'.repeat(20)}`;
  await expect(signHumanMembershipBytes(account, bytes, action)).rejects.toThrow('wrong_wallet'); expect(f.getKey).not.toHaveBeenCalled();
  f.selected = account; f.signer = `0x${'44'.repeat(20)}`;
  await expect(signHumanMembershipBytes(account, bytes, action)).rejects.toThrow('wrong_wallet'); expect(f.sign).not.toHaveBeenCalled();
});
test('hash account signing uses the EIP-191 digest and never accesses a curve key on failure', async () => {
  f.hash.mockResolvedValue('hash-signature');
  expect(await signHumanMembershipBytes(account, bytes, action)).toBe('hash-signature'); expect(f.getKey).not.toHaveBeenCalled();
  f.hash.mockRejectedValue(Error('root changed'));
  await expect(signHumanMembershipBytes(account, bytes, action)).rejects.toThrow('root changed');
  expect(f.getKey).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
});

test('recovered auxiliary authorization uses its binding and rechecks its recovery state',async()=>{
 f.selected='0x'+'33'.repeat(20);const binding='0x'+'66'.repeat(32);
 const current={evm:account,manifestHash:'manifest',recoveryCommitment:'commitment',hashAccount:{nonce:'2'}};
 f.bound.mockResolvedValue(current);f.seed.fill(1);
 expect(await signHumanMembershipBytes(account,bytes,action,binding)).toBe('bound-signature');
 expect(f.bound).toHaveBeenCalledWith('backup',binding,f.network);expect(f.biometric).toHaveBeenCalledTimes(2);
 expect(f.seed.every(v=>v===0)).toBe(true);expect(f.getKey).not.toHaveBeenCalled();
 f.bound.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,recoveryCommitment:'changed'});
 await expect(signHumanMembershipBytes(account,bytes,action,binding)).rejects.toThrow('membership_changed');
 expect(f.getKey).not.toHaveBeenCalled();
});

test('native departure survives spending rotation and refuses a changed recovery owner',async()=>{
 const binding='0x'+'66'.repeat(32),current={evm:account,manifestHash:'manifest',recoveryGeneration:1,recoveryCommitment:'owner',hashAccount:{nonce:'7'}};
 f.departure.mockResolvedValue(current);f.departureRoot.mockResolvedValue({root:'initial-root',manifestHash:'manifest'});f.seed.fill(1);
 f.departure.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,hashAccount:{nonce:'8'}});
 expect(await signHumanMembershipDeparture(account,binding,bytes,action)).toBe('departure-signature');
 expect(f.departureSign).toHaveBeenCalledWith(account,hashMessage(bytes),f.seed);expect(f.seed.every(n=>n===0)).toBe(true);
 expect(f.getKey).not.toHaveBeenCalled();expect(f.hashSign).not.toHaveBeenCalled();
 f.departure.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,recoveryGeneration:2});
 await expect(signHumanMembershipDeparture(account,binding,bytes,action)).rejects.toThrow('membership_changed');
});
