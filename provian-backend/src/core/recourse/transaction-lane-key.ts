import { Wallet } from 'ethers';
import { isProvianServiceWallet } from '../pvt/provian-service-wallets';

/** The Recourse gas wallet. It is never the settlement minter, the batch
 * approver or any authority key; the lane refuses to sign if it is. */
export const RECOURSE_GAS_KEY_ENV = 'RECOURSE_GAS_KEY';
let cached: { readonly key: string; readonly wallet: Wallet } | null = null;
export function recourseLaneWallet(env: NodeJS.ProcessEnv = process.env): Wallet {
  const key = env[RECOURSE_GAS_KEY_ENV];
  if (!key) throw Error('recourse_lane_key_unavailable');
  if (cached?.key !== key) cached = { key, wallet: new Wallet(key) };
  return cached.wallet;
}
/** The address every Recourse gas plan names as its sender. */
export function recourseLaneAddress(env: NodeJS.ProcessEnv = process.env): string {
  return recourseLaneWallet(env).address.toLowerCase();
}
/** The lane signs only from a pinned Provian service wallet, so a transfer funding its gas
 * never mints for the sender. A rotated key is pinned (or named by RECOURSE_GAS_ADDRESS) first. */
export function assertLaneKeyPinned(address: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isProvianServiceWallet(address, env)) throw Error('recourse_lane_key_unpinned');
}
