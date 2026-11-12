import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import config from './config';
import { resolveProtocolDeployment, type PointerRpc, type ProtocolDeployment } from '../../../src/core/protocol/pointer';
import type { OwnerChainNetwork } from '../../../src/core/recourse/owner-chain';
const requireIsolation = () => {
  if (!__DEV__ || Device.isDevice || config.relay !== 'http://127.0.0.1:18551') throw Error('isolated_native_build_required');
};
let snapshot: ProtocolDeployment | undefined;
const rpc = (leg: string): PointerRpc => ({ async request(method, params) {
  requireIsolation();
  const reply = await fetch(`${config.relay}/rpc/${leg}`, { method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
  const data=await reply.json();
  if(!reply.ok || data.error || !Object.hasOwn(data,'result'))throw Error('isolated_rpc_refused');
  return data.result;
} });
export function ownerChainNetwork(): OwnerChainNetwork { requireIsolation();return {rpcs:[rpc('one'),rpc('two')],deployment:currentProtocolDeployment}; }
export function verifiedProtocolSnapshot():ProtocolDeployment {if(!snapshot)throw Error('protocol_pointer_resolution_required');return snapshot;}
export async function currentProtocolDeployment():Promise<ProtocolDeployment>{
 requireIsolation();const key=`isolated.recourse.revision.${config.instanceId}`;
 const prior=await AsyncStorage.getItem(key);if(prior!==null&&!/^[0-9]+$/.test(prior))throw Error('protocol_pointer_revision_invalid');
 const result=await resolveProtocolDeployment([rpc('one'),rpc('two')],config.pointer,config.pointerRuntimeHash,BigInt(prior??'0'));
 await AsyncStorage.setItem(key,String(result.revision));snapshot=result;return result;
}
