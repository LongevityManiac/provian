import { getBytes, hexlify, randomBytes, Wallet } from 'ethers';
import { readRecoursePoolChain } from './recourse-pool-chain';
import { parseMemberBindingChallenge, type MemberBindingConsent } from './recourse-member-binding';
import { deriveMembershipExitSecret, membershipExitCommitment, standingMembershipSigningHash } from './recourse-membership-authorization';
import { recoverRecourseAgent, retainedMembershipExitSecret } from './recourse-recovery';
import { recoverySigningRoot, recoveryCommitment } from './recourse-hash-authorization';
import { guardedFetcher } from './guarded-fetch';
import { initializeRecoveryKeystore, withDecryptedKey, withRecoveryMaterial, type AgentKeystore } from './keystore';
import { withBoundRecoveryMaterial } from './recourse-agent-credential';
import { addressRecoveryBinding } from './recourse-address-binding';
import { signEip191Message } from './link-signing';
import { currentProtocolDeployment, ownerChainNetwork } from './protocol-runtime';
import { acceptedBindingDigest, waitForRecourseBinding } from './recourse-binding-chain';
import { signActiveHashWalletMessage, signBoundHashWalletMessage, signBoundHashWalletDeparture } from './break-recovery-store';
import { beginMembershipTransition, readMembershipTransition, submitMembershipConsent, retainMembershipDeparture,
  type MembershipConsentChallenge, type MembershipRelay } from './recourse-membership-client';
import { loadKeystore } from './keystore';
import * as path from 'path';

export interface RecourseConfig {
  readonly relayUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly walletId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}
import { recourseBindingMessage, type RecourseBinding } from './recourse-binding';
export { recourseBindingMessage, type RecourseBinding } from './recourse-binding';
async function request(config: RecourseConfig, path: string, body?: unknown): Promise<unknown> {
  const response = await guardedFetcher(config.fetch)(`${config.relayUrl.replace(/\/$/, '')}/v1/recourse/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}:${config.apiSecret}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`recourse_request_refused:${response.status}`);
  return response.json();
}
export function recourseMembershipRelay(config: RecourseConfig): MembershipRelay {
  return { request: (path, body) => request(config, path, body) };
}
async function signAgentMembership(config: RecourseConfig, input: { directory: string; passphrase: string; account: string; binding?: string; departure?: boolean }, bytes: Uint8Array): Promise<string> {
  const keystore = loadKeystore(path.join(input.directory, 'agent-keystore.json'));
  if (!keystore || keystore.wallet_id !== config.walletId) throw Error('recourse_wallet_mismatch');
  const hashed = input.binding ? await (input.departure ? signBoundHashWalletDeparture : signBoundHashWalletMessage)({ ...input, binding: input.binding, message: bytes, network: ownerChainNetwork() })
    : await signActiveHashWalletMessage({ ...input, message: bytes, network: ownerChainNetwork() });
  if (hashed !== null) return hashed;
  if (keystore.address.toLowerCase() !== input.account.toLowerCase()) throw Error('recourse_wallet_mismatch');
  return withDecryptedKey(keystore, input.passphrase, key => new Wallet(key.privateKey).signMessage(bytes));
}
export async function beginAgentMembership(config: RecourseConfig, kind: 'join' | 'leave' | 'renew') {
  return beginMembershipTransition(recourseMembershipRelay(config), kind);
}
export async function readAgentMembershipTransition(config: RecourseConfig, id?: string) {
  return readMembershipTransition(recourseMembershipRelay(config), id);
}
export async function authorizeAgentMembershipConsent(config: RecourseConfig, input: { directory: string; passphrase: string;
  transitionId: string; kind: 'join' | 'leave' | 'renew'; challenge: MembershipConsentChallenge }) {
  const account = input.challenge.consent.account;
  return submitMembershipConsent(recourseMembershipRelay(config), ownerChainNetwork(), { ...input, account,
    signBytes: bytes => signAgentMembership(config, { ...input, account, binding: input.challenge.consent.binding, departure:input.kind==='leave' }, bytes),
    exitSecret:(salt,expectedCommitment)=>retainedMembershipExitSecret({directory:input.directory,passphrase:input.passphrase,
      walletId:config.walletId,domain:input.challenge.domain,binding:input.challenge.consent.binding,salt,expectedCommitment}) });
}
export async function leaveAgentMembership(config:RecourseConfig,input:{directory:string;passphrase:string;transitionId:string}):Promise<void>{
  return retainMembershipDeparture(recourseMembershipRelay(config),ownerChainNetwork(),{transitionId:input.transitionId,
    signBytes:(account,binding,bytes)=>signAgentMembership(config,{...input,account,binding,departure:true},bytes),
    exitSecret:(challenge,salt,expectedCommitment)=>retainedMembershipExitSecret({...input,walletId:config.walletId,
      domain:challenge.domain,binding:challenge.consent.binding,salt,expectedCommitment})});
}
export interface BindRecourseOptions {
  /** Wait for the binding to appear on chain. Install paths pass false: the relay
   * sends it in the background and the daemon re-signs if the signature expires. */
  readonly wait?: boolean;
  /** Called with the signed binding before it is submitted. */
  readonly onSigned?: (binding: RecourseBinding) => void;
}
/** Durably encrypt an independent secret before registering only its hash. */
export async function bindRecourseOwnership(config: RecourseConfig, input: {
  readonly keystore: AgentKeystore; readonly passphrase: string; readonly keystorePath: string;
  readonly external?: { readonly address: string; readonly sign: (message: string) => Promise<string>; readonly signBytes?: (message: Uint8Array) => Promise<string> };
}, options: BindRecourseOptions = {}): Promise<unknown> {
  if (input.keystore.wallet_id !== config.walletId) throw new Error('recourse_wallet_mismatch');
  const keystore = initializeRecoveryKeystore(input.keystore, input.passphrase, input.keystorePath);
  const address = (input.external?.address ?? keystore.address).toLowerCase();
  const deployment = await currentProtocolDeployment();
  const identity = addressRecoveryBinding({ chainId: '8453', pointer: deployment.pointer.toLowerCase(), origin: address });
  const { commitment, signingRoot } = await withBoundRecoveryMaterial(keystore, input.passphrase, identity, async (secret, seed) => {
    const signingRoot = await recoverySigningRoot(seed);
    return { signingRoot, commitment: recoveryCommitment(secret, signingRoot) };
  });
  const raw = await request(config, 'binding-challenge', { address, recoveryCommitment: commitment, signingRoot });
  if (!raw || typeof raw !== 'object' || !('binding' in raw) || !('message' in raw)
    || !raw.binding || typeof raw.binding !== 'object') throw new Error('recourse_challenge_invalid');
  const binding = raw.binding as RecourseBinding;
  if (binding.identity !== identity || binding.address !== address || binding.recoveryCommitment !== commitment || binding.signingRoot !== signingRoot
    || binding.kernel !== (await currentProtocolDeployment()).addresses.kernel.toLowerCase()
    || binding.expiresAtMs < Date.now() || binding.expiresAtMs > Date.now() + 5 * 60_000
    || raw.message !== recourseBindingMessage(binding)) throw new Error('recourse_challenge_invalid');
  const signature = input.external ? await input.external.sign(raw.message as string)
    : await withDecryptedKey(keystore, input.passphrase, key => signEip191Message(key.privateKey, raw.message as string));
  let memberConsent: MemberBindingConsent | undefined;
  if ('memberConsent' in raw && raw.memberConsent !== null && raw.memberConsent !== undefined) {
    const pool = await readRecoursePoolChain(identity, ownerChainNetwork());
    const challenge = parseMemberBindingChallenge(raw.memberConsent, binding, {
      domain: { chainId: '8453', pointer: deployment.pointer.toLowerCase(), kernel: binding.kernel, pool: pool.pool },
      revision: String(deployment.revision), nonce: pool.consentNonce, ruleHash: pool.signedRuleHash, timestamp: pool.timestamp, earningsBps: pool.earningsBps,
    });
    const exitSalt = hexlify(randomBytes(32));
    const exitCommitment = await withRecoveryMaterial(keystore, input.passphrase, async (secret, seed) => {
      const material = new Uint8Array([...secret,...seed]);
      try { return membershipExitCommitment(deriveMembershipExitSecret(material, challenge.domain, binding.identity, exitSalt)); }
      finally { material.fill(0); }
    });
    const authorization = { consent: challenge.consent, admissionMonth: pool.month, rejoinPayments:[],fixedChargePayer:false, burnLimit: "0", reserveLimit: "0",
      earningsBpsLimit: challenge.earningsBpsLimit, exitSalt, exitCommitment };
    const bytes = getBytes(standingMembershipSigningHash(challenge.domain, authorization));
    if (input.external && !input.external.signBytes) throw Error('recourse_external_membership_signer_required');
    const ownerSignature = input.external ? await input.external.signBytes!(bytes)
      : await withDecryptedKey(keystore, input.passphrase, key => new Wallet(key.privateKey).signMessage(bytes));
    memberConsent = { authorization, ownerSignature };
  }
  options.onSigned?.(binding);
  const result = await request(config, 'bind', { binding, signature, ...(memberConsent ? { memberConsent } : {}) });
  const digest = acceptedBindingDigest(result, binding);
  if (options.wait !== false) await waitForRecourseBinding(binding, ownerChainNetwork(), config.signal, digest);
  return result;
}

export async function readRecourseOwnership(config: RecourseConfig): Promise<unknown> {
  return request(config, 'ownership');
}

/** One agent action fixes a fresh recovery key and the exact observed loss.
 * Adjudication and execution use that one-use scope without another signature. */
export async function submitAgentRestorationRequest(config: RecourseConfig, input: {
  readonly directory: string; readonly passphrase: string; readonly transactionHash: string; readonly block: number;
  /** The loss the member reviewed, atomic PVT; the relay's prepared loss must equal it before anything is submitted. */
  readonly expectedMaximumLoss?: string;
}): Promise<{ walletId: string; destination: string; generation: number; restorationRequestId?: string }> {
  const recovered = await recoverRecourseAgent({ ...input, relayUrl: config.relayUrl, fetch: config.fetch, signal: config.signal,
    restoration: { transactionHash: input.transactionHash, block: input.block, apiKey: config.apiKey, apiSecret: config.apiSecret,
      ...(input.expectedMaximumLoss !== undefined ? { expectedMaximumLoss: input.expectedMaximumLoss } : {}) } });
  if (recovered.walletId !== config.walletId || !recovered.restorationRequestId) throw new Error('recourse_wallet_mismatch');
  return recovered;
}
/** The pool state the relay reads for this owner, with its private membership view. */
export async function readRecoursePool(config: RecourseConfig): Promise<unknown> {
  return request(config, 'pool');
}
export async function readRestorationRequests(config: RecourseConfig): Promise<unknown> {
  return request(config, 'restoration-requests');
}
