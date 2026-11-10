import { recoverySigningRoot, recoveryCommitment, signRecoveryIntent } from './recourse-hash-authorization';
import { privateRecourseEnvelope } from './private-access';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicReplacePrivateFile } from './durable-private-file';
import { durableDirectory } from './durable-directory';
import { tryAcquireFileLock } from './meter/file-lock';
import { encryptKeystore, loadKeystore, withDecryptedKey, withRecoveryMaterial, type AgentKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { guardedFetcher } from './guarded-fetch';
import { signEip191Message } from './link-signing';
import { ownerChainNetwork } from './protocol-runtime';
import { readOwnerChainState, verifyOwnerOperationReceipt } from './recourse-owner-chain';
import { ownerOperationIntent, recoveryOperationId, parseRestorationScope, type RestorationScope, type RecoveryOwnerOperation } from './recourse-owner-operation';

interface RecoveryJournal {
  version: 1; relayUrl: string; requestId: string; identity: string;
  oldKeystore: AgentKeystore; nextKeystore: AgentKeystore;
  apiKey: string; apiSecret: string; generation?: number; installed: boolean;
  restoration?: { transactionHash: string; block: number; kernel: string; scope: RestorationScope };
  previousExecutionKernel?: string;
  operation?: RecoveryOwnerOperation; ownerIntent?: string; authorizationTxHash?: string;
}
const AAD = Buffer.from('provian-recourse-recovery/v1');
const hash = (bytes: Uint8Array): string => `0x${createHash('sha256').update(bytes).digest('hex')}`;
function saveJournal(file: string, journal: RecoveryJournal, passphrase: string): void {
  durableDirectory(path.dirname(file));
  const salt = randomBytes(32), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(journal), 'utf8'), cipher.final()]);
    atomicReplacePrivateFile(file, JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }));
  } finally { key.fill(0); }
}
function loadJournal(file: string, passphrase: string): RecoveryJournal | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe recovery journal');
    const envelope = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (envelope.version !== 1 || typeof envelope.salt !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.salt)
      || typeof envelope.iv !== 'string' || !/^[0-9a-f]{24}$/.test(envelope.iv)
      || typeof envelope.tag !== 'string' || !/^[0-9a-f]{32}$/.test(envelope.tag)
      || typeof envelope.ciphertext !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(envelope.ciphertext)) throw new Error('Invalid recovery journal');
    const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'hex'), 32);
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
      cipher.setAAD(AAD); cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plain = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'hex')), cipher.final()]);
      try { return JSON.parse(plain.toString('utf8')) as RecoveryJournal; } finally { plain.fill(0); }
    } finally { key.fill(0); }
  } finally { fs.closeSync(fd); }
}

/** Find the exact recovery generation selected by an authenticated snapshot.
 * Ordinary rotations retain both encrypted keystores, including an operation
 * whose chain execution completed before the local installation did. */
export async function withArchivedRecoveryMaterial<T>(input: {
  directory: string; passphrase: string; identity: string; commitment: string;
}, use: (secret: Uint8Array, signingSeed: Uint8Array) => Promise<T>): Promise<{ found: false } | { found: true; value: T }> {
  const directory = path.resolve(input.directory);
  const archive = path.join(directory, 'recoveries');
  let names: string[] = [];
  try { names = fs.readdirSync(archive).filter(name => /^0x[0-9a-f]{64}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = [path.join(directory, 'recourse-recovery.json'), ...names.map(name => path.join(archive, name))];
  for (const file of files) {
    const journal = loadJournal(file, input.passphrase);
    if (!journal) continue;
    if (journal.version !== 1 || !journal.oldKeystore || !journal.nextKeystore
      || journal.oldKeystore.wallet_id !== journal.nextKeystore.wallet_id
      || journal.identity !== hash(Buffer.from(JSON.stringify(['provian ownership', 'agent', journal.oldKeystore.wallet_id])))
      || (file !== files[0] && path.basename(file) !== `${journal.requestId}.json`)) throw Error('Recovery journal binding mismatch');
    if (journal.identity !== input.identity) continue;
    for (const keystore of [journal.oldKeystore, journal.nextKeystore]) {
      if (keystore.version !== 2) continue;
      const result = await withRecoveryMaterial(keystore, input.passphrase, async (secret, signingSeed) => {
        if (recoveryCommitment(secret, await recoverySigningRoot(signingSeed)) !== input.commitment) return { found: false } as const;
        return { found: true, value: await use(secret, signingSeed) } as const;
      });
      if (result.found) return result;
    }
  }
  return { found: false };
}

/** Resume the same independently authenticated recovery after a lost response.
 * The encrypted journal retains the retired key for other assets and deposits.
 * No old-key transaction or asset sweep is attempted by this operation. */
export async function recoverRecourseAgent(input: {
  relayUrl: string; directory: string; passphrase: string; fetch?: typeof globalThis.fetch;
  /** Begin a new recovery only after the preceding operation finished. */
  newRecovery?: boolean;
  restoration?: { transactionHash: string; block: number; apiKey: string; apiSecret: string };
  signal?: AbortSignal;
}): Promise<{ walletId: string; destination: string; generation: number; restorationRequestId?: string }> {
  const directory = path.resolve(input.directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = tryAcquireFileLock(path.join(directory, 'rotation.lock'), { timeoutMs: 0, staleMs: 0, syncOnly: false });
  if (!release) throw new Error('Another wallet transition is running');
  try {
    const file = path.join(directory, 'recourse-recovery.json');
    const relayUrl = input.relayUrl.replace(/\/+$/, '');
    let journal = loadJournal(file, input.passphrase);
    if (input.restoration && (!/^0x[0-9a-f]{64}$/.test(input.restoration.transactionHash)
      || !Number.isSafeInteger(input.restoration.block) || input.restoration.block < 1)) throw new Error('Restoration occurrence invalid');
    if (journal && (input.newRecovery || (journal.installed && input.restoration
      && (journal.restoration?.transactionHash !== input.restoration.transactionHash || journal.restoration.block !== input.restoration.block)))) {
      if (!journal.installed) throw new Error('Finish the pending recovery before starting another');
      saveJournal(path.join(directory, 'recoveries', `${journal.requestId}.json`), journal, input.passphrase);
      journal = null;
    }
    if (!journal) {
      const oldKeystore = loadKeystore(path.join(directory, 'agent-keystore.json'));
      if (!oldKeystore || oldKeystore.version !== 2) throw new Error('No registered recovery secret is available');
      // Verify the backup before generating or persisting a replacement.
      await withRecoveryMaterial(oldKeystore, input.passphrase, secret => hash(secret));
      let restoration: RecoveryJournal['restoration'];
      if (input.restoration) {
        const response = await guardedFetcher(input.fetch)(`${relayUrl}/v1/recourse/restoration-intents`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.restoration.apiKey}:${input.restoration.apiSecret}` },
          body: JSON.stringify({ transactionHash: input.restoration.transactionHash, block: input.restoration.block }), signal: input.signal,
        });
        if (!response.ok) throw new Error('Restoration evidence preparation refused');
        const prepared: unknown = await response.json();
        if (!prepared || typeof prepared !== 'object' || !('kernel' in prepared) || typeof prepared.kernel !== 'string'
          || !('request' in prepared) || !('lossHash' in prepared) || !('maximumLoss' in prepared)) throw new Error('Restoration preparation invalid');
        restoration = { transactionHash: input.restoration.transactionHash, block: input.restoration.block, kernel: prepared.kernel,
          scope: parseRestorationScope({ request: prepared.request, lossHash: prepared.lossHash, maximumLoss: prepared.maximumLoss }) };
      }
      const next = generateAgentKeyPair(), secret = randomBytes(32);
      try {
        journal = { version: 1, relayUrl, requestId: `0x${randomBytes(32).toString('hex')}`,
          identity: hash(Buffer.from(JSON.stringify(['provian ownership', 'agent', oldKeystore.wallet_id]))),
          oldKeystore, nextKeystore: encryptKeystore({ ...next, walletId: oldKeystore.wallet_id,
            passphrase: input.passphrase, recoverySecret: Buffer.from(secret).toString('hex') }),
          apiKey: `pvn_live_${randomBytes(16).toString('hex')}`, apiSecret: `pvns_${randomBytes(32).toString('hex')}`, installed: false,
          ...(restoration ? { restoration } : {}) };
      } finally { secret.fill(0); }
      saveJournal(file, journal, input.passphrase);
    }
    if (journal.version !== 1 || journal.relayUrl !== relayUrl || journal.oldKeystore.wallet_id !== journal.nextKeystore.wallet_id
      || journal.identity !== hash(Buffer.from(JSON.stringify(['provian ownership', 'agent', journal.oldKeystore.wallet_id])))) throw new Error('Recovery journal binding mismatch');
    if (input.restoration && (journal.restoration?.transactionHash !== input.restoration.transactionHash
      || journal.restoration.block !== input.restoration.block)) throw new Error('Another recovery request is pending');
    const active = loadKeystore(path.join(directory, 'agent-keystore.json'));
    if (!active || active.wallet_id !== journal.oldKeystore.wallet_id
      || ![journal.oldKeystore.address, journal.nextKeystore.address].includes(active.address)) throw new Error('Wallet changed outside the recovery journal');
    if (journal.installed) {
      if (active.address !== journal.nextKeystore.address || journal.generation === undefined) throw new Error('Completed recovery identity mismatch');
      return { walletId: journal.nextKeystore.wallet_id, destination: journal.nextKeystore.address.toLowerCase(), generation: journal.generation, ...(journal.restoration ? { restorationRequestId: journal.restoration.scope.request } : {}) };
    }
    if (journal.generation === undefined) {
      const { nextCommitment, nextSigningRoot } = await withRecoveryMaterial(journal.nextKeystore, input.passphrase, async (secret, seed) => {
        const nextSigningRoot = await recoverySigningRoot(seed);
        return { nextSigningRoot, nextCommitment: recoveryCommitment(secret, nextSigningRoot) };
      });
      const state = journal;
      if (state.operation && !state.authorizationTxHash) {
        const chain = await readOwnerChainState(state.identity, ownerChainNetwork());
        const old = state.operation;
        if ((chain.deployment.addresses.kernel.toLowerCase() !== old.kernel || chain.deployment.revision.toString() !== old.revision)
          && chain.nonce === old.nonce && chain.commitment === recoveryCommitment(Buffer.from(old.proof.recoverySecret.slice(2), 'hex'), old.proof.signingRoot)
          && chain.signingRoot === old.proof.signingRoot) {
          // The old payload requires its exact pointer revision and can no
          // longer execute. A new payload retains the same destination and
          // credentials; a changed kernel also requires a new signed domain.
          if (chain.deployment.addresses.kernel.toLowerCase() === old.kernel) {
            state.operation = { ...old, revision: chain.deployment.revision.toString() };
          } else {
            state.previousExecutionKernel = old.kernel;
            delete state.operation; delete state.ownerIntent;
          }
          saveJournal(file, state, input.passphrase);
        }
      }
      if (!state.operation) {
        const chain = await readOwnerChainState(state.identity, ownerChainNetwork());
        if (state.restoration && !state.previousExecutionKernel && state.restoration.kernel !== chain.deployment.addresses.kernel.toLowerCase()) throw new Error('Restoration snapshot kernel changed');
        state.operation = await withRecoveryMaterial(state.oldKeystore, input.passphrase, async (secret, seed) => {
          const signingRoot = await recoverySigningRoot(seed);
          if (chain.commitment !== recoveryCommitment(secret, signingRoot) || chain.signingRoot !== signingRoot) {
            throw new Error('Recovery backup does not match the current owner commitment');
          }
          const operation: RecoveryOwnerOperation = {
            kernel: chain.deployment.addresses.kernel.toLowerCase(), revision: chain.deployment.revision.toString(),
            identity: state.identity, destination: state.nextKeystore.address.toLowerCase(), nonce: chain.nonce,
            ...(state.restoration ? { restoration: state.restoration.scope } : {}),
            proof: { recoverySecret: `0x${Buffer.from(secret).toString('hex')}`, signingRoot, nextCommitment, nextSigningRoot,
              publicKey: `0x${'00'.repeat(32)}`, signature: '0x' },
          };
          const signed = await signRecoveryIntent(seed, ownerOperationIntent(operation), { async reserve(_root, intent) {
            if (state.ownerIntent && state.ownerIntent !== intent) throw new Error('Pending recovery intent changed');
            state.ownerIntent = intent; saveJournal(file, state, input.passphrase);
          } });
          return { ...operation, proof: { ...operation.proof, ...signed } };
        });
        saveJournal(file, state, input.passphrase);
      }
      if (!state.authorizationTxHash) {
        const operation = state.operation;
        const id = recoveryOperationId(operation);
        const privateRequest = async (path: string, body: unknown = null) => {
          const envelope = await withRecoveryMaterial(state.oldKeystore, input.passphrase,
            (secret, seed) => privateRecourseEnvelope(state.identity, secret, seed, path, body));
          return guardedFetcher(input.fetch)(`${relayUrl}/v1/recourse/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: input.signal,
          });
        };
        let response = await privateRequest('owner-operations/recovery', operation);
        while (true) {
          if (!response.ok) throw new Error(`Recovery authorization refused (${response.status})`);
          const status: unknown = await response.json();
          if (!status || typeof status !== 'object' || !('id' in status) || status.id !== id
            || !('status' in status) || !['queued', 'submitted', 'confirmed', 'failed'].includes(String(status.status))
            || !('transactionHash' in status)) throw new Error('Recovery authorization response binding mismatch');
          if (status.status === 'failed') throw new Error('Recovery authorization did not execute; recovery material remains saved');
          if (status.status === 'confirmed') {
            if (typeof status.transactionHash !== 'string') throw new Error('Recovery authorization receipt missing');
            await verifyOwnerOperationReceipt(operation, status.transactionHash, ownerChainNetwork());
            state.authorizationTxHash = status.transactionHash;
            saveJournal(file, state, input.passphrase);
            break;
          }
          input.signal?.throwIfAborted();
          await new Promise<void>(resolve => setTimeout(resolve, 5000));
          input.signal?.throwIfAborted();
          response = await privateRequest(`owner-operations/${id}`);
        }
      }
      await verifyOwnerOperationReceipt(state.operation, state.authorizationTxHash, ownerChainNetwork());
      const result: unknown = await withRecoveryMaterial(state.oldKeystore, input.passphrase, async (secret, seed) => {
        const signingRoot = await recoverySigningRoot(seed);
        const preimage = Buffer.concat([secret, Buffer.from(signingRoot.slice(2), 'hex')]);
        try {
        const expiresAtMs = Date.now() + 300_000;
        const destination = state.nextKeystore.address.toLowerCase();
        const credentialHash = createHash('sha256').update(`${state.apiKey}:${state.apiSecret}`).digest('hex');
        const message = ['Provian agent ownership recovery', 'chain:8453', `kernel:${state.operation!.kernel}`,
          `identity:${state.identity}`, `recovery:${hash(preimage)}`, `destination:${destination}`, `next:${nextCommitment}`, `next-hash-authority:${nextSigningRoot}`,
          `public-key:${state.nextKeystore.public_key}`, `credentials:${credentialHash}`,
          `authorization:${state.authorizationTxHash}`, `authorization-nonce:${state.operation!.nonce}`, `request:${state.requestId}`, `expires:${expiresAtMs}`].join('\n');
        const signature = await withDecryptedKey(state.nextKeystore, input.passphrase, key => signEip191Message(key.privateKey, message));
        const response = await guardedFetcher(input.fetch)(`${relayUrl}/v1/recourse/recover-agent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kernel: state.operation!.kernel, identity: state.identity, preimage: `0x${preimage.toString('hex')}`,
            destination, nextCommitment, nextSigningRoot, authorizationTxHash: state.authorizationTxHash, authorizationNonce: state.operation!.nonce, requestId: state.requestId, expiresAtMs,
            publicKey: state.nextKeystore.public_key, apiKey: state.apiKey, apiSecret: state.apiSecret, signature }),
        });
        if (!response.ok) throw new Error(`Recovery refused (${response.status})`);
        return response.json();
        } finally { preimage.fill(0); }
      });
      if (!result || typeof result !== 'object' || !('walletId' in result) || result.walletId !== journal.oldKeystore.wallet_id
        || !('destination' in result) || result.destination !== journal.nextKeystore.address.toLowerCase()
        || !('generation' in result) || typeof result.generation !== 'number' || !Number.isSafeInteger(result.generation)
        || result.generation < 1) throw new Error('Recovery response binding mismatch');
      journal.generation = result.generation;
      saveJournal(file, journal, input.passphrase);
    }
    if (!journal.operation || !journal.authorizationTxHash) throw new Error('Recovery authorization missing');
    await verifyOwnerOperationReceipt(journal.operation, journal.authorizationTxHash, ownerChainNetwork());
    // Both installs are repeatable from the durable record after a partial write.
    atomicReplacePrivateFile(path.join(directory, 'agent-keystore.json'), JSON.stringify(journal.nextKeystore));
    atomicReplacePrivateFile(path.join(directory, 'agent-credentials.json'), JSON.stringify({ wallet_id: journal.nextKeystore.wallet_id,
      address: journal.nextKeystore.address, api_key: journal.apiKey, api_secret: journal.apiSecret }));
    journal.installed = true;
    saveJournal(file, journal, input.passphrase);
    return { walletId: journal.nextKeystore.wallet_id, destination: journal.nextKeystore.address.toLowerCase(), generation: journal.generation, ...(journal.restoration ? { restorationRequestId: journal.restoration.scope.request } : {}) };
  } finally { release(); }
}
