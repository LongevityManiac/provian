import { BUILT_IN_PROTOCOL_PROOF } from './proof.generated';
import { protocolRpc } from './rpc';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { PROTOCOL_POINTER_PIN } from './pointer-pin.generated';
import type { PointerRpc, ProtocolDeployment } from './pointer';
import { createProtocolVerification } from './verification';
import type { OwnerChainNetwork } from '../recourse/owner-chain';

const urls = ['https://mainnet.base.org', 'https://base.drpc.org'] as const;
const revisionKey = 'provian.protocol.pointer.revision';
const verificationKey = 'provian.protocol.verified.v1';
let verification: ReturnType<typeof createProtocolVerification> | undefined;
function transport(url: typeof urls[number]): PointerRpc { return protocolRpc(url, fetch); }
function verifier(): ReturnType<typeof createProtocolVerification> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw new Error('protocol_pointer_not_deployed');
  return verification ??= createProtocolVerification({ pointer: address, runtimeHash, operators: urls, builtInProof: BUILT_IN_PROTOCOL_PROOF,
    rpcs: [transport(urls[0]), transport(urls[1])],
    minimumRevision: async () => {
      const stored = await AsyncStorage.getItem(revisionKey);
      if (stored !== null && !/^[0-9]+$/.test(stored)) throw Error('protocol_pointer_revision_invalid');
      return stored === null ? 0n : BigInt(stored);
    },
    // The proof is not a secret, but accepting it skips expensive immutable
    // checks: keep its integrity under device storage protection, not plain KV.
    store: {
      load: () => SecureStore.getItemAsync(verificationKey),
      save: async (revision, value) => {
        await SecureStore.setItemAsync(verificationKey, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        await AsyncStorage.setItem(revisionKey, revision.toString());
      },
    },
  });
}
export function verifiedProtocolSnapshot(): ProtocolDeployment { return verifier().snapshot(); }
/** Unconfirmed hint for speculative reads only. */
export async function protocolDeploymentCandidate(): Promise<ProtocolDeployment | undefined> { return verifier().candidate(); }
export async function currentProtocolDeployment(): Promise<ProtocolDeployment> { return verifier().current(); }
export function ownerChainNetwork(): OwnerChainNetwork {
  return { rpcs: [transport(urls[0]), transport(urls[1])], deployment: currentProtocolDeployment };
}
