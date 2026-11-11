import { recoverRecourseAgent } from './recourse-recovery';
import { recoverySigningRoot, recoveryCommitment } from './recourse-hash-authorization';
import { guardedFetcher } from './guarded-fetch';
import { initializeRecoveryKeystore, withDecryptedKey, type AgentKeystore } from './keystore';
import { withBoundRecoveryMaterial } from './recourse-agent-credential';
import { addressRecoveryBinding } from './recourse-address-binding';
import { signEip191Message } from './link-signing';
import { currentProtocolDeployment, ownerChainNetwork } from './protocol-runtime';
import { waitForRecourseBinding } from './recourse-binding-chain';

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

/** Durably encrypt an independent secret before registering only its hash. */
export async function bindRecourseOwnership(config: RecourseConfig, input: {
  readonly keystore: AgentKeystore; readonly passphrase: string; readonly keystorePath: string;
  readonly external?: { readonly address: string; readonly sign: (message: string) => Promise<string> };
}): Promise<unknown> {
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
  const result = await request(config, 'bind', { binding, signature });
  await waitForRecourseBinding(binding, ownerChainNetwork(), config.signal);
  return result;
}

export async function readRecourseOwnership(config: RecourseConfig): Promise<unknown> {
  return request(config, 'ownership');
}

/** One agent action fixes a fresh recovery key and the exact observed loss.
 * Adjudication and execution use that one-use scope without another signature. */
export async function submitAgentRestorationRequest(config: RecourseConfig, input: {
  readonly directory: string; readonly passphrase: string; readonly transactionHash: string; readonly block: number;
}): Promise<{ walletId: string; destination: string; generation: number; restorationRequestId?: string }> {
  const recovered = await recoverRecourseAgent({ ...input, relayUrl: config.relayUrl, fetch: config.fetch, signal: config.signal,
    restoration: { transactionHash: input.transactionHash, block: input.block, apiKey: config.apiKey, apiSecret: config.apiSecret } });
  if (recovered.walletId !== config.walletId || !recovered.restorationRequestId) throw new Error('recourse_wallet_mismatch');
  return recovered;
}
export async function readRestorationRequests(config: RecourseConfig): Promise<unknown> {
  return request(config, 'restoration-requests');
}
