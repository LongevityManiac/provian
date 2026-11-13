import { addressRecoveryBinding } from './address-binding';
import { beforeEach, expect, it, vi } from 'vitest';
import { deriveHumanAccount, installHumanAccountSelection, readHumanAccountSelection } from './human-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';
import type { BiometricAction } from '../security/biometricAction';
vi.mock('expo-device',()=>({isDevice:false}));
vi.mock('../../../scripts/recourse/native/config',()=>({default:{relay:'http://127.0.0.1:18551',pointer:'0x1111111111111111111111111111111111111111',pointerRuntimeHash:`0x${'11'.repeat(32)}`}}));
vi.mock('../protocol/pointer-pin.generated',async importOriginal=>{
 const {createRequire}=await import('node:module'),{resolve}=await import('node:path');
 const hook=createRequire(import.meta.url)('../../../scripts/recourse/native/metro-hook.cjs');
 const root=resolve(import.meta.dirname,'../../..'),pin=resolve(root,'src/core/protocol/pointer-pin.generated.ts');
 const config=hook({resolver:{resolveRequest:()=>({type:'sourceFile',filePath:pin})}},root);
 const resolved=config.resolver.resolveRequest({originModulePath:resolve(root,'src/core/recourse/human-account.ts')},'../protocol/pointer-pin.generated','ios');
 if(resolved.filePath===pin)return importOriginal();
 return import(resolved.filePath);
});
const memory = vi.hoisted(() => new Map<string, string>());
const fault = vi.hoisted(() => ({ unreadable: false }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => { if (fault.unreadable) throw new Error('keystore_unavailable'); return memory.get(key) ?? null; },
  setItemAsync: async (key: string, value: string) => { memory.set(key, value); },
}));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: (action: unknown) => { if (action !== 'approved') throw new Error('biometric_required'); } }));
const mnemonic = 'test test test test test test test test test test test junk';
const action = 'approved' as unknown as BiometricAction;
beforeEach(() => { memory.clear(); fault.unreadable = false; });
it('isolated Metro pin permits the actual replacement-account installation', async () => {
  const localPointer = '0x1111111111111111111111111111111111111111';
  const root = await deriveHumanAccount(mnemonic, 0), next = await deriveHumanAccount(mnemonic, 1);
  const localBinding = addressRecoveryBinding({chainId:'8453',pointer:localPointer,origin:root.evm});
  const localCommitment = recoveryCommitment(humanRecoverySecret(mnemonic,1,localBinding),
    await recoverySigningRoot(humanRecoverySigningSeed(mnemonic,1,localBinding)));
  await expect(installHumanAccountSelection(mnemonic,{rootAddress:root.evm,generation:1,...next,
    recoveryCommitment:localCommitment,requestId:`0x${'11'.repeat(32)}`},action)).resolves.toBeUndefined();
  expect(await readHumanAccountSelection(root.evm)).toMatchObject({ generation: 1, evm: next.evm, recoveryCommitment: localCommitment });
});
