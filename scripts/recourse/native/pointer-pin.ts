import * as Device from 'expo-device';
import config from './config';

if (!__DEV__ || Device.isDevice || config.relay !== 'http://127.0.0.1:18551') {
  throw Error('isolated_native_build_required');
}
// Account derivation and chain reads must share the same isolated domain.
export const PROTOCOL_POINTER_PIN = Object.freeze({
  chainId: 8453,
  address: config.pointer,
  runtimeHash: config.pointerRuntimeHash,
});
