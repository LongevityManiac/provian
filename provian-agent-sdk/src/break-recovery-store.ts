import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { concat, hashMessage, hexlify, sha256, toUtf8Bytes } from 'ethers';
import { hashDeliveryId } from './hash-account-delivery';
import { atomicReplacePrivateFile } from './durable-private-file';
import { durableDirectory } from './durable-directory';
import { tryAcquireFileLock } from './meter/file-lock';
import { loadKeystore } from './keystore';
import { withBoundRecoveryMaterial } from './recourse-agent-credential';
import { readAddressRecoveryBinding } from './recourse-binding-chain';
import { withArchivedRecoveryMaterial, archivedAgentRestorations } from './recourse-recovery';
import { assertCurrentProtocolTransaction } from './protocol-transaction';
import { readHashAccountState, readHashAccountDepartureRoot, verifyHashAccountVariantReceipt } from './hash-account-chain';
import { prepareHashAccountOperation, signHashAccountMessage, signHashAccountDeparture, type HashAccountIntent, type SignedHashAccountOperation } from './hash-account';
import { readOwnerChainState } from './recourse-owner-chain';
import { breakRestorationDetails, parseBreakRestorationRequest } from './break-restoration-data';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
import { prepareBreakDeploymentRequest } from './break-deployment-proof';
import type { BreakDeploymentRequest } from './break-deployment-data';
import { recoverFreeBreak, type FreeBreakRecoveryPhase } from './free-break-recovery';
import { guardedFetcher } from './guarded-fetch';
import { privateRecourseEnvelope } from './private-access';
import { parseBreakEntitlement } from './break-entitlement';
import { prepareBreakRecovery, readBreakRecoveryContext, type BreakOwnerEntitlement, type PreparedBreakRecovery } from './break-recovery';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { parseRestorationScope } from './recourse-owner-operation';

const AAD = Buffer.from('provian.break-recovery.backup/v1');
const hash = /^0x[0-9a-f]{64}$/;
export interface BreakRecord {
  version: 1; identity: string; commitment: string; context: string;
  destinationSigningSeed: string; nextRecoverySecret: string; nextRecoverySigningSeed: string;
  destination?: string; operationHash?: string | null; prepared?: PreparedBreakRecovery;
  restoredTransaction?: string;
  credentials?: { requestId: string; apiKey: string; apiSecret: string; generation?: number };
  accountSigningSeed?: string;
  completedAccount?: { transactionHash: string; outcome: string };
  pendingAccount?: { intent: HashAccountIntent; nextSeed: string; operation?: SignedHashAccountOperation; cancellation?: SignedHashAccountOperation; cancellationReserved?: boolean };
  replacement?: import('./agent-hash-replacement').AgentHashReplacementState;
}
function recordFile(directory: string, identity: string, commitment: string, context: string): string {
  if (!hash.test(identity) || !hash.test(commitment) || !/^0x[0-9a-f]{40}$/.test(context) || /^0x0+$/.test(context)) throw Error('break_backup_identity_invalid');
  return path.join(directory, 'break-recoveries', `${identity.slice(2)}-${commitment.slice(2)}-${context.slice(2)}.json`);
}
function validateRecord(value: unknown, identity: string, commitment: string, context: string): BreakRecord {
  if (!value || typeof value !== 'object') throw Error('break_backup_invalid');
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || r.identity !== identity || r.commitment !== commitment || r.context !== context
    || !['destinationSigningSeed', 'nextRecoverySecret', 'nextRecoverySigningSeed'].every(k => typeof r[k] === 'string' && hash.test(r[k] as string))
    || (r.destination !== undefined && (typeof r.destination !== 'string' || !/^0x[0-9a-f]{40}$/.test(r.destination)))) throw Error('break_backup_invalid');
  return value as BreakRecord;
}
function readRecord(file: string, passphrase: string, identity: string, commitment: string, context: string): BreakRecord | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('break_backup_unsafe_file');
    const e = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (e.version !== 1 || typeof e.salt !== 'string' || !/^[0-9a-f]{64}$/.test(e.salt)
      || typeof e.iv !== 'string' || !/^[0-9a-f]{24}$/.test(e.iv) || typeof e.tag !== 'string' || !/^[0-9a-f]{32}$/.test(e.tag)
      || typeof e.ciphertext !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(e.ciphertext)) throw Error('break_backup_invalid');
    const key = scryptSync(passphrase, Buffer.from(e.salt, 'hex'), 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
      decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'hex')), decipher.final()]);
      try { return validateRecord(JSON.parse(plain.toString('utf8')), identity, commitment, context); }
      finally { plain.fill(0); }
    } finally { key.fill(0); }
  } finally { fs.closeSync(fd); }
}
function saveRecord(file: string, passphrase: string, record: BreakRecord): void {
  durableDirectory(path.dirname(file));
  const salt = randomBytes(32), iv = randomBytes(12), key = scryptSync(passphrase, salt, 32);
  const plain = Buffer.from(JSON.stringify(record));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    atomicReplacePrivateFile(file, JSON.stringify({ version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') }));
    if (JSON.stringify(readRecord(file, passphrase, record.identity, record.commitment, record.context)) !== JSON.stringify(record)) throw Error('break_backup_readback_failed');
  } finally { key.fill(0); plain.fill(0); }
}
async function locked<T>(directory: string, passphrase: string, action: () => Promise<T>): Promise<T> {
  if (passphrase.length < 8) throw Error('break_backup_passphrase_invalid');
  durableDirectory(directory);
  const release = tryAcquireFileLock(path.join(directory, 'rotation.lock'), { timeoutMs: 0, staleMs: 0, syncOnly: false });
  if (!release) throw Error('break_backup_transition_in_progress');
  try { return await action(); } finally { release(); }
}
/** Persist the hash-account seed before requesting its deployment. The public
 * root is safe to give to a gas sponsor; no seed leaves this encrypted store. */
export async function provisionBreakRecovery(input: { directory: string; passphrase: string; identity: string; commitment: string; context: string }): Promise<{ signingRoot: string }> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const file = recordFile(directory, input.identity, input.commitment, input.context);
    let record = readRecord(file, input.passphrase, input.identity, input.commitment, input.context);
    if (!record) {
      record = { version: 1, identity: input.identity, commitment: input.commitment, context: input.context,
        destinationSigningSeed: hexlify(randomBytes(32)), nextRecoverySecret: hexlify(randomBytes(32)), nextRecoverySigningSeed: hexlify(randomBytes(32)) };
      saveRecord(file, input.passphrase, record);
    }
    const seed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
    try { return { signingRoot: await recoverySigningRoot(seed) }; } finally { seed.fill(0); }
  });
}
async function withSnapshotRecovery<T>(directory: string, passphrase: string,
  e: Pick<BreakOwnerEntitlement, 'identity' | 'commitment'>,
  use: (secret: Uint8Array, signingSeed: Uint8Array) => Promise<T>): Promise<T> {
  const active = readActiveHashWallet(directory);
  if (active && active.identity !== e.identity) throw Error('break_backup_identity_changed');
  if (active) {
    const previous = readRecord(recordFile(directory, active.identity, active.commitment, active.context), passphrase, active.identity, active.commitment, active.context);
    if (!previous || previous.destination !== active.address || previous.restoredTransaction !== active.transactionHash) throw Error('break_backup_active_wallet_invalid');
  }
  // A last-good snapshot can predate a locally completed restoration.
  // Select by exact independent commitment, never by newest local state.
  // Pending records count too: the chain may have executed before a reply
  // was lost. The authenticated snapshot establishes which pair is valid.
  for (const name of fs.readdirSync(path.join(directory, 'break-recoveries')).sort()) {
    if (!name.startsWith(`${e.identity.slice(2)}-`) || !/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)) continue;
    const oldCommitment = `0x${name.slice(65,129)}`, oldContext = `0x${name.slice(130,170)}`;
    const previous = readRecord(recordFile(directory, e.identity, oldCommitment, oldContext), passphrase, e.identity, oldCommitment, oldContext);
    if (!previous) throw Error('break_backup_history_missing');
    const secret = Buffer.from(previous.nextRecoverySecret.slice(2), 'hex');
    const signingSeed = Buffer.from(previous.nextRecoverySigningSeed.slice(2), 'hex');
    try {
      if (recoveryCommitment(secret, await recoverySigningRoot(signingSeed)) === e.commitment) return await use(secret, signingSeed);
    } finally { secret.fill(0); signingSeed.fill(0); }
  }
  const archived = await withArchivedRecoveryMaterial({ directory, passphrase, identity: e.identity, commitment: e.commitment }, use);
  if (archived.found) return archived.value;
  const keystore = loadKeystore(path.join(directory, 'agent-keystore.json'));
  if (!keystore || keystore.version !== 2) throw Error('break_backup_owner_material_missing');
  return withBoundRecoveryMaterial(keystore, passphrase, e.identity, async (secret, signingSeed) => {
    if (recoveryCommitment(secret, await recoverySigningRoot(signingSeed)) !== e.commitment) throw Error('break_backup_recovery_material_unavailable');
    return use(secret, signingSeed);
  });
}

/** Internal replacement coordinator access. The same authenticated encrypted
 * records retain every independent recovery generation for future snapshots.
 * Callbacks must finish before the transition lock or key material is released. */
export async function withAgentHashRecoveryRecord<T>(supplied: { directory: string; passphrase: string; identity: string;
  commitment: string; context: string; create?: boolean }, use: (record: BreakRecord, persist: () => void) => Promise<T>): Promise<T> {
  const input = { ...supplied };
  const directory = path.resolve(input.directory), file = recordFile(directory, input.identity, input.commitment, input.context);
  return locked(directory, input.passphrase, async () => {
    let record = readRecord(file, input.passphrase, input.identity, input.commitment, input.context);
    if (!record && input.create) {
      record = { version: 1, identity: input.identity, commitment: input.commitment, context: input.context,
        destinationSigningSeed: hexlify(randomBytes(32)), nextRecoverySecret: hexlify(randomBytes(32)), nextRecoverySigningSeed: hexlify(randomBytes(32)) };
      saveRecord(file, input.passphrase, record);
    }
    if (!record) throw Error('hash_replacement_record_missing');
    const retained = record;
    let active = true;
    try { return await use(retained, () => {
      if (!active) throw Error('hash_replacement_record_lock_expired');
      if (retained.identity !== input.identity || retained.commitment !== input.commitment || retained.context !== input.context) throw Error('hash_replacement_record_binding_changed');
      saveRecord(file, input.passphrase, retained);
    }); } finally { active = false; }
  });
}
export function withAgentRecoveryMaterial<T>(input: { directory: string; passphrase: string; identity: string; commitment: string },
  use: (secret: Uint8Array, signingSeed: Uint8Array) => Promise<T>): Promise<T> {
  return withSnapshotRecovery(path.resolve(input.directory), input.passphrase, { identity: input.identity, commitment: input.commitment }, use);
}

/** Only public plans leave the encrypted store. These are recovery candidates,
 * never authority: the coordinator must match current independent chain state. */
export async function listAgentHashReplacements(supplied: { directory: string; passphrase: string; identity: string; context: string }): Promise<{
  plan: import('./agent-hash-replacement').AgentHashReplacementPlan;
  state: import('./agent-hash-replacement').AgentHashReplacementState;
}[]> {
  const input = { ...supplied }, directory = path.resolve(input.directory);
  recordFile(directory, input.identity, `0x${'00'.repeat(32)}`, input.context);
  return locked(directory, input.passphrase, async () => {
    let names: string[];
    try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: { plan: import('./agent-hash-replacement').AgentHashReplacementPlan; state: import('./agent-hash-replacement').AgentHashReplacementState }[] = [];
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)
        || !name.startsWith(`${input.identity.slice(2)}-`) || !name.endsWith(`-${input.context.slice(2)}.json`)) continue;
      const commitment = `0x${name.slice(65, 129)}`;
      const record = readRecord(recordFile(directory, input.identity, commitment, input.context), input.passphrase, input.identity, commitment, input.context);
      if (!record?.replacement || !record.destination) continue;
      const seed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
      try { result.push({ plan: { identity: input.identity, commitment, context: input.context, nonce: record.replacement.nonce,
        account: record.destination, initialRoot: await recoverySigningRoot(seed), deployed: false }, state: record.replacement }); }
      finally { seed.fill(0); }
    }
    return result;
  });
}

/** Resume an initial free restoration whose chain execution preceded its relay
 * cut or local activation. A public locator alone cannot mark it complete. */
export async function agentInitialBreakNeedsInstall(supplied: { directory: string; passphrase: string; identity: string;
  context: string; commitment: string; destination: string }): Promise<boolean> {
  const input = { ...supplied }, directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    let names: string[];
    try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    for (const name of names) {
      if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)
        || !name.startsWith(`${input.identity.slice(2)}-`) || !name.endsWith(`-${input.context.slice(2)}.json`)) continue;
      const commitment = `0x${name.slice(65, 129)}`;
      const record = readRecord(recordFile(directory, input.identity, commitment, input.context), input.passphrase, input.identity, commitment, input.context);
      if (!record?.prepared || record.replacement || record.destination !== input.destination) continue;
      const secret = Buffer.from(record.nextRecoverySecret.slice(2), 'hex'), seed = Buffer.from(record.nextRecoverySigningSeed.slice(2), 'hex');
      try {
        if (recoveryCommitment(secret, await recoverySigningRoot(seed)) !== input.commitment) continue;
        const active = readActiveHashWallet(directory);
        return !record.credentials?.generation || !record.restoredTransaction || active?.identity !== input.identity
          || active.commitment !== commitment || active.context !== input.context || active.address !== input.destination
          || active.transactionHash !== record.restoredTransaction;
      } finally { secret.fill(0); seed.fill(0); }
    }
    return false;
  });
}

export async function retainedAgentRestorations(supplied: { directory: string; passphrase: string; identity: string }): Promise<import('./agent-hash-replacement').AgentHashRestoration[]> {
  const input = { ...supplied }, directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const losses = archivedAgentRestorations(input);
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name) || !name.startsWith(`${input.identity.slice(2)}-`)) continue;
      const commitment = `0x${name.slice(65, 129)}`, context = `0x${name.slice(130, 170)}`;
      const record = readRecord(recordFile(directory, input.identity, commitment, context), input.passphrase, input.identity, commitment, context);
      for (const loss of [record?.replacement?.loss, ...(record?.replacement?.continuedLosses ?? [])]) if (loss) losses.push(loss);
    }
    const unique = new Map<string, import('./agent-hash-replacement').AgentHashRestoration>();
    for (const loss of losses) {
      const scope = { ...parseRestorationScope(loss.scope) };
      if (!/^0x[0-9a-f]{64}$/.test(loss.transactionHash) || !Number.isSafeInteger(loss.block) || loss.block < 1
        || !/^0x[0-9a-f]{40}$/.test(loss.kernel)) throw Error('hash_recovery_loss_history_invalid');
      const value = { transactionHash: loss.transactionHash, block: loss.block, kernel: loss.kernel, scope };
      const previous = unique.get(scope.request);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw Error('hash_recovery_loss_history_changed');
      unique.set(scope.request, value);
    }
    return [...unique.values()];
  });
}

export async function prepareAgentBreakDeployment(input: { directory: string; passphrase: string;
  entitlement: BreakOwnerEntitlement; network: OwnerChainNetwork }): Promise<BreakDeploymentRequest> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const e = input.entitlement, context = await readBreakRecoveryContext(input.network);
    const file = recordFile(directory, e.identity, e.commitment, context);
    const record = readRecord(file, input.passphrase, e.identity, e.commitment, context);
    if (!record) throw Error('break_backup_provision_first');
    const destinationSigningSeed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
    try {
      return await withSnapshotRecovery(directory, input.passphrase, e, (recoverySecret, recoverySigningSeed) => prepareBreakDeploymentRequest({
        network:input.network, entitlement:e, expectedBreakOrigin:context, destinationSigningSeed, recoverySecret, recoverySigningSeed,
        async persistBeforePublishing(selected) {
          if (selected.breakOrigin !== context || (record.destination && record.destination !== selected.account)) throw Error('break_backup_destination_changed');
          record.destination = selected.account; saveRecord(file, input.passphrase, record);
        },
      }));
    } finally { destinationSigningSeed.fill(0); }
  });
}

/** Discover the private entitlement using a current or historical registered
 * backup credential. The snapshot proof is still verified by preparation. */
export async function readAgentBreakEntitlement(input: { directory: string; passphrase: string;
  network: OwnerChainNetwork; relayUrl: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal }): Promise<BreakOwnerEntitlement> {
  const directory = path.resolve(input.directory), keystore = loadKeystore(path.join(directory, 'agent-keystore.json'));
  if (!keystore || keystore.version !== 2) throw Error('break_backup_owner_material_missing');
  const identity = await readAddressRecoveryBinding(keystore.address.toLowerCase(), input.network);
  const origin = await readBreakRecoveryContext(input.network), relay = new URL(input.relayUrl);
  if (relay.protocol !== 'https:' || relay.username || relay.password || relay.search || relay.hash) throw Error('break_recovery_relay_invalid');
  const route = `break-entitlements/${origin}/${identity}`;
  const payload = await withBoundRecoveryMaterial(keystore, input.passphrase, identity,
    (secret, seed) => privateRecourseEnvelope(identity, secret, seed, route));
  const response = await guardedFetcher(input.fetch)(`${relay.toString().replace(/\/+$/, '')}/v1/recourse/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: input.signal,
  });
  if (!response.ok) throw Error('break_recovery_relay_refused');
  const entitlement = parseBreakEntitlement(await response.json());
  if (entitlement.identity !== identity || await readBreakRecoveryContext(input.network) !== origin) throw Error('break_recovery_context_changed');
  return entitlement;
}

/** Network waits do not hold the keystore lock. Each preparation and final
 * installation takes its own short lock and verifies durable encrypted state. */
export async function recoverAgentBreak(input: { directory: string; passphrase: string; entitlement: BreakOwnerEntitlement;
  network: OwnerChainNetwork; relayUrl: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal;
  phase?(phase: FreeBreakRecoveryPhase): void }): Promise<ActiveHashWallet> {
  const context = await readBreakRecoveryContext(input.network), e = input.entitlement, directory = path.resolve(input.directory);
  const relay = new URL(input.relayUrl);
  if (relay.protocol !== 'https:' || relay.username || relay.password || relay.search || relay.hash) throw Error('break_recovery_relay_invalid');
  const relayUrl = relay.toString().replace(/\/+$/, '');
  await provisionBreakRecovery({ directory, passphrase:input.passphrase, identity:e.identity, commitment:e.commitment, context });
  const transport = { async request(route: string, body?: unknown): Promise<unknown> {
      if (!/^(?:recover-agent|break-(?:deployments|registrations|restorations)(?:\/0x[0-9a-f]{64})?)$/.test(route)) throw Error('break_recovery_route_invalid');
      // The retained curve keystore is installed only after the relay credential
      // cut. Its commitment is registered even when chain recovery has advanced
      // to a newer snapshot commitment that the relay has not accepted yet.
      const keystore = loadKeystore(path.join(directory, 'agent-keystore.json'));
      if (!keystore || keystore.version !== 2
        || await readAddressRecoveryBinding(keystore.address.toLowerCase(), input.network) !== e.identity) throw Error('break_backup_identity_changed');
      const payload = route === 'recover-agent' ? body : await withBoundRecoveryMaterial(keystore, input.passphrase, e.identity,
        (secret, seed) => privateRecourseEnvelope(e.identity, secret, seed, route, body ?? null));
      const response = await guardedFetcher(input.fetch)(`${relayUrl}/v1/recourse/${route}`, { method:'POST',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:input.signal });
      if (!response.ok) throw Error('break_recovery_relay_refused'); return response.json();
    } };
  const result = await recoverFreeBreak({ network:input.network, signal:input.signal, phase:input.phase, transport,
    prepareDeployment:() => prepareAgentBreakDeployment(input),
    prepareRecovery:destination => prepareAgentBreakRecovery({...input,destination}),
    pendingRestoration:() => locked(directory,input.passphrase,async () => {
      const record = readRecord(recordFile(directory,e.identity,e.commitment,context),input.passphrase,e.identity,e.commitment,context);
      return record?.prepared?.phase === 'restore_balance' ? record.prepared : null;
    }),
  });
  await recoverAgentBreakCredentials({directory,passphrase:input.passphrase,identity:e.identity,commitment:e.commitment,
    transactionHash:result.transactionHash,network:input.network,transport});
  return completeAgentBreakRecovery({ directory,passphrase:input.passphrase,identity:e.identity,commitment:e.commitment,
    transactionHash:result.transactionHash,network:input.network });
}

/** The relay cut and local credential install are repeatable from one encrypted
 * request journal. The old EOA keystore remains available for unrelated assets.
 * The active PVT account locator is published only after this step succeeds. */
export async function recoverAgentBreakCredentials(input: {directory: string; passphrase: string; identity: string;
  commitment: string; transactionHash: string; network: OwnerChainNetwork;
  transport: {request(route: string, body?: unknown): Promise<unknown>} }): Promise<void> {
  const directory=path.resolve(input.directory), context=await readBreakRecoveryContext(input.network);
  const file=recordFile(directory,input.identity,input.commitment,context);
  const staged=await locked(directory,input.passphrase,async()=>{
    const record=readRecord(file,input.passphrase,input.identity,input.commitment,context);
    if(!record?.prepared?.ownerIntent || !record.destination)throw Error('break_backup_restoration_missing');
    await verifyBreakRecoveryReceipt(record.prepared,input.transactionHash,input.network);
    const old=loadKeystore(path.join(directory,'agent-keystore.json'));
    if(!old || await readAddressRecoveryBinding(old.address.toLowerCase(),input.network)!==input.identity)throw Error('break_backup_identity_changed');
    if(!record.credentials){record.credentials={requestId:hexlify(randomBytes(32)),apiKey:`pvn_live_${randomBytes(16).toString('hex')}`,
      apiSecret:`pvns_${randomBytes(32).toString('hex')}`};saveRecord(file,input.passphrase,record);}
    const credentials=record.credentials;
    if(!hash.test(credentials.requestId)||!/^pvn_live_[0-9a-f]{32}$/.test(credentials.apiKey)||!/^pvns_[0-9a-f]{64}$/.test(credentials.apiSecret))throw Error('break_backup_credentials_invalid');
    const request=parseBreakRestorationRequest({kernel:record.prepared.kernel,ownerIntent:record.prepared.ownerIntent,data:record.prepared.data});
    const details=breakRestorationDetails(request),owner=await readOwnerChainState(input.identity,input.network);
    const seed=Buffer.from((record.accountSigningSeed??record.destinationSigningSeed).slice(2),'hex');
    try {
      const account=await readHashAccountState(record.destination,input.network);
      if(await recoverySigningRoot(seed)!==account.root)throw Error('hash_wallet_reconcile_pending_receipt');
      const preimage=concat([details.proof.recoverySecret,details.proof.signingRoot]),expiresAtMs=Date.now()+300000;
      const body={kernel:record.prepared.kernel,identity:input.identity,preimage,destination:record.destination,
        nextCommitment:details.proof.nextCommitment,nextSigningRoot:details.proof.nextSigningRoot,
        authorizationTxHash:input.transactionHash,authorizationNonce:owner.nonce-1,publicKey:`hash:${record.destination}`,
        apiKey:credentials.apiKey,apiSecret:credentials.apiSecret,requestId:credentials.requestId,expiresAtMs,
        destinationKind:'hash' as const,breakDestinationRoot:details.destinationKeyRoot};
      const message=['Provian agent ownership recovery','chain:8453',`kernel:${body.kernel}`,`identity:${body.identity}`,
        `recovery:${sha256(preimage)}`,`destination:${body.destination}`,`next:${body.nextCommitment}`,`next-hash-authority:${body.nextSigningRoot}`,
        `public-key:${body.publicKey}`,`credentials:${sha256(toUtf8Bytes(`${credentials.apiKey}:${credentials.apiSecret}`)).slice(2)}`,
        `authorization:${body.authorizationTxHash}`,`authorization-nonce:${body.authorizationNonce}`,`request:${credentials.requestId}`,
        `expires:${expiresAtMs}`,'destination-signature:hash',`break-destination-root:${body.breakDestinationRoot}`].join('\n');
      return {walletId:old.wallet_id,prepared:record.prepared,credentials:{...credentials},body:{...body,
        signature:await signHashAccountMessage(record.destination,hashMessage(message),seed)}};
    }finally{seed.fill(0);}
  });
  const result=await input.transport.request('recover-agent',staged.body);
  if(!result||typeof result!=='object'||!('walletId'in result)||result.walletId!==staged.walletId
    ||!('destination'in result)||result.destination!==staged.body.destination||!('generation'in result)
    ||typeof result.generation!=='number'||!Number.isSafeInteger(result.generation)||result.generation<1)throw Error('break_backup_credentials_reply_invalid');
  await verifyBreakRecoveryReceipt(staged.prepared,input.transactionHash,input.network);
  const generation=result.generation;
  await locked(directory,input.passphrase,async()=>{
    const record=readRecord(file,input.passphrase,input.identity,input.commitment,context);
    if(!record?.credentials||record.credentials.requestId!==staged.credentials.requestId
      ||record.credentials.apiKey!==staged.credentials.apiKey||record.credentials.apiSecret!==staged.credentials.apiSecret
      ||record.prepared?.ownerIntent!==staged.prepared.ownerIntent)throw Error('break_backup_credentials_changed');
    atomicReplacePrivateFile(path.join(directory,'agent-credentials.json'),JSON.stringify({wallet_id:staged.walletId,
      address:staged.body.destination,api_key:staged.credentials.apiKey,api_secret:staged.credentials.apiSecret}));
    record.credentials.generation=generation;saveRecord(file,input.passphrase,record);
  });
}

/** Resume agent restoration without replacing the old curve wallet or losing
 * its other assets. The encrypted record retains the new hash-account key and
 * next recovery generation. Receipt verification must precede any installation. */
export async function prepareAgentBreakRecovery(input: { directory: string; passphrase: string; entitlement: BreakOwnerEntitlement;
  destination: string; network: OwnerChainNetwork }): Promise<PreparedBreakRecovery> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const e = input.entitlement, context = await readBreakRecoveryContext(input.network);
    const file = recordFile(directory, e.identity, e.commitment, context);
    const record = readRecord(file, input.passphrase, e.identity, e.commitment, context);
    if (!record) throw Error('break_backup_provision_first');
    if (record.destination && record.destination !== input.destination) throw Error('break_backup_destination_changed');
    const destinationSigningSeed = Buffer.from(record.destinationSigningSeed.slice(2), 'hex');
    const nextRecoverySecret = Buffer.from(record.nextRecoverySecret.slice(2), 'hex');
    const nextRecoverySigningSeed = Buffer.from(record.nextRecoverySigningSeed.slice(2), 'hex');
    try {
      const result = await withSnapshotRecovery(directory, input.passphrase, e, (recoverySecret, recoverySigningSeed) => prepareBreakRecovery({
        network: input.network, entitlement: e, expectedBreakOrigin: context, destination: input.destination, recoverySecret, recoverySigningSeed,
        destinationSigningSeed, nextRecoverySecret, nextRecoverySigningSeed,
        async persistBeforePublishing(backup) {
          if (hexlify(backup.destinationSigningSeed) !== record.destinationSigningSeed || hexlify(backup.nextRecoverySecret) !== record.nextRecoverySecret
            || hexlify(backup.nextRecoverySigningSeed) !== record.nextRecoverySigningSeed) throw Error('break_backup_material_changed');
          record.destination = backup.destination; record.operationHash = backup.operationHash;
          saveRecord(file, input.passphrase, record);
        },
      }));
      record.prepared = result; saveRecord(file, input.passphrase, record); return result;
    } finally { destinationSigningSeed.fill(0); nextRecoverySecret.fill(0); nextRecoverySigningSeed.fill(0); }
  });
}

export interface ActiveHashWallet {
  readonly identity: string; readonly commitment: string; readonly context: string; readonly address: string; readonly transactionHash: string;
}
/** Publish only a locator after the immutable encrypted key record and exact
 * restoration receipt are durable. Repeating this after a lost response is safe.
 * The old EOA keystore is retained for unrelated assets and historical records. */
export async function completeAgentBreakRecovery(input: { directory: string; passphrase: string; identity: string;
  commitment: string; transactionHash: string; network: OwnerChainNetwork }): Promise<ActiveHashWallet> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const context = await readBreakRecoveryContext(input.network);
    const file = recordFile(directory, input.identity, input.commitment, context);
    const record = readRecord(file, input.passphrase, input.identity, input.commitment, context);
    if (!record?.prepared || record.prepared.phase !== 'restore_balance' || !record.destination) throw Error('break_backup_restoration_missing');
    if (record.restoredTransaction && record.restoredTransaction !== input.transactionHash) throw Error('break_backup_receipt_changed');
    await verifyBreakRecoveryReceipt(record.prepared, input.transactionHash, input.network);
    record.restoredTransaction = input.transactionHash;
    saveRecord(file, input.passphrase, record);
    const active: ActiveHashWallet = { identity: record.identity, commitment: record.commitment, context: record.context,
      address: record.destination, transactionHash: input.transactionHash };
    const index = path.join(directory, 'active-hash-wallet.json');
    atomicReplacePrivateFile(index, JSON.stringify(active));
    if (JSON.stringify(readActiveHashWallet(directory)) !== JSON.stringify(active)) throw Error('break_backup_activation_readback_failed');
    return active;
  });
}
export function readActiveHashWallet(directory: string): ActiveHashWallet | null {
  let fd: number;
  try { fd = fs.openSync(path.join(path.resolve(directory), 'active-hash-wallet.json'), fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('break_backup_active_wallet_invalid');
    const v: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('break_backup_active_wallet_invalid');
    const r = v as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== 'address,commitment,context,identity,transactionHash'
      || !['identity','commitment','transactionHash'].every(key => typeof r[key] === 'string' && hash.test(r[key] as string))
      || typeof r.context !== 'string' || !/^0x[0-9a-f]{40}$/.test(r.context)
      || typeof r.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(r.address)) throw Error('break_backup_active_wallet_invalid');
    return v as ActiveHashWallet;
  } finally { fs.closeSync(fd); }
}

/** Offline backup validation. Call while holding the transition lock or on an
 * unpublished restore directory. A locator is never a substitute for its key. */
export function validateAgentHashBackup(directory: string, passphrase: string): void {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of names) {
    if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)) throw Error('break_backup_invalid');
    const identity = `0x${name.slice(0, 64)}`, commitment = `0x${name.slice(65, 129)}`, context = `0x${name.slice(130, 170)}`;
    if (!readRecord(recordFile(directory, identity, commitment, context), passphrase, identity, commitment, context)) throw Error('break_backup_history_missing');
  }
  const active = readActiveHashWallet(directory);
  if (active) {
    const record = readRecord(recordFile(directory, active.identity, active.commitment, active.context), passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('break_backup_active_wallet_invalid');
  }
}

export interface HashWalletCall { readonly target: string; readonly value: string; readonly callGas: string; readonly data: string; }
/** Message signatures use the selected hash account's independent spending
 * material. A selected account that cannot verify never falls back to a curve
 * key. This does not rotate the account or publish a transaction. */
export async function signActiveHashWalletMessage(input: { directory: string; passphrase: string; account: string;
  message: string | Uint8Array; network: OwnerChainNetwork }): Promise<string | null> {
  const directory = path.resolve(input.directory), digest = hashMessage(input.message);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) return null;
    if (active.address !== input.account.toLowerCase()) throw Error('hash_wallet_account_changed');
    const record = readRecord(recordFile(directory, active.identity, active.commitment, active.context), input.passphrase,
      active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    const state = await readHashAccountState(active.address, input.network);
    const seed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2), 'hex');
    try {
      if (await recoverySigningRoot(seed) !== state.root) throw Error('hash_wallet_reconcile_pending_receipt');
      const signature = await signHashAccountMessage(active.address, digest, seed);
      const after = await readHashAccountState(active.address, input.network);
      if (after.root !== state.root || after.nonce !== state.nonce || after.manifestHash !== state.manifestHash) throw Error('hash_wallet_state_changed');
      return signature;
    } finally { seed.fill(0); }
  });
}
/** A recovered auxiliary address is independently keyed and never selected by
 * the primary-wallet index. Both its recovery binding and spending root must
 * still match the independently read chain before and after signing. */
export async function signBoundHashWalletMessage(input: { directory: string; passphrase: string; account: string;
  binding: string; message: Uint8Array; network: OwnerChainNetwork }): Promise<string | null> {
  if (!hash.test(input.binding) || !/^0x[0-9a-f]{40}$/.test(input.account)) throw Error('hash_wallet_account_changed');
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    let names: string[];
    try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const context = await readBreakRecoveryContext(input.network);
    const candidates: BreakRecord[] = [];
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)
        || !name.startsWith(input.binding.slice(2)+'-') || !name.endsWith('-'+context.slice(2)+'.json')) continue;
      const commitment = '0x'+name.slice(65,129);
      const record = readRecord(recordFile(directory,input.binding,commitment,context),input.passphrase,input.binding,commitment,context);
      if (record?.destination === input.account) candidates.push(record);
    }
    if (!candidates.length) return null;
    const owner = await readOwnerChainState(input.binding,input.network), state = await readHashAccountState(input.account,input.network);
    if (owner.destination !== input.account || owner.deployment.manifestHash !== state.manifestHash) throw Error('hash_wallet_account_changed');
    for (const record of candidates) {
      const seed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2),'hex');
      try {
        if (await recoverySigningRoot(seed) !== state.root) continue;
        const signature = await signHashAccountMessage(input.account,hashMessage(input.message),seed);
        const latest = await readOwnerChainState(input.binding,input.network), after = await readHashAccountState(input.account,input.network);
        if (after.root !== state.root || after.nonce !== state.nonce || after.manifestHash !== state.manifestHash
          || latest.destination !== owner.destination || latest.commitment !== owner.commitment || latest.nonce !== owner.nonce
          || latest.signingRoot !== owner.signingRoot || latest.deployment.manifestHash !== owner.deployment.manifestHash) throw Error('hash_wallet_state_changed');
        return signature;
      } finally { seed.fill(0); }
    }
    throw Error('hash_wallet_reconcile_pending_receipt');
  });
}
/** A separate revocation-only signer retains the constructor seed. Ordinary
 * account messages above still require the current spending key and nonce. */
export async function signBoundHashWalletDeparture(input: { directory: string; passphrase: string; account: string;
  binding: string; message: Uint8Array; network: OwnerChainNetwork }): Promise<string | null> {
  if (!hash.test(input.binding) || !/^0x[0-9a-f]{40}$/.test(input.account)) throw Error('hash_wallet_account_changed');
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    let names: string[];
    try { names = fs.readdirSync(path.join(directory, 'break-recoveries')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const context = await readBreakRecoveryContext(input.network);
    const candidates: BreakRecord[] = [];
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{40}\.json$/.test(name)
        || !name.startsWith(input.binding.slice(2)+'-') || !name.endsWith('-'+context.slice(2)+'.json')) continue;
      const commitment = '0x'+name.slice(65,129);
      const record = readRecord(recordFile(directory,input.binding,commitment,context),input.passphrase,input.binding,commitment,context);
      if (record?.destination === input.account) candidates.push(record);
    }
    if (!candidates.length) return null;
    const owner = await readOwnerChainState(input.binding,input.network), state = await readHashAccountDepartureRoot(input.account,input.network);
    if (owner.destination !== input.account || owner.deployment.manifestHash !== state.manifestHash) throw Error('hash_wallet_account_changed');
    for (const record of candidates) {
      const seed = Buffer.from(record.destinationSigningSeed.slice(2),'hex');
      try {
        if (await recoverySigningRoot(seed) !== state.root) continue;
        const signature = await signHashAccountDeparture(input.account,hashMessage(input.message),seed);
        const latest = await readOwnerChainState(input.binding,input.network), after = await readHashAccountDepartureRoot(input.account,input.network);
        if (after.root !== state.root || after.manifestHash !== state.manifestHash
          || latest.destination !== owner.destination || latest.commitment !== owner.commitment || latest.nonce !== owner.nonce
          || latest.signingRoot !== owner.signingRoot || latest.deployment.manifestHash !== owner.deployment.manifestHash) throw Error('hash_wallet_state_changed');
        return signature;
      } finally { seed.fill(0); }
    }
    throw Error('hash_wallet_reconcile_pending_receipt');
  });
}
/** A hash-wallet operation rotates a signing key even when its inner call fails.
 * Keep the predecessor and successor encrypted, reserve one exact nonce/intent,
 * and expose a public gas-sponsorable call only after durable readback. */
export async function prepareActiveHashWalletOperation(input: { directory: string; passphrase: string;
  network: OwnerChainNetwork; call: HashWalletCall }): Promise<SignedHashAccountOperation> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) throw Error('hash_wallet_not_active');
    const file = recordFile(directory, active.identity, active.commitment, active.context);
    const record = readRecord(file, input.passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    const deployment = await assertCurrentProtocolTransaction(input.network, input.call.target, input.call.data);
    const state = await readHashAccountState(active.address, input.network);
    if (state.manifestHash !== deployment.manifestHash) throw Error('hash_wallet_protocol_changed');
    const signingSeed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2), 'hex');
    try {
      if (await recoverySigningRoot(signingSeed) !== state.root) throw Error('hash_wallet_reconcile_pending_receipt');
      const base = { chainId: '8453', account: active.address, nonce: state.nonce, target: input.call.target,
        value: input.call.value, callGas: input.call.callGas, data: input.call.data };
      if (record.pendingAccount) {
        const { nextCommitment: _next, ...reserved } = record.pendingAccount.intent;
        if (JSON.stringify(reserved) !== JSON.stringify(base)) throw Error('hash_wallet_exact_operation_pending');
      }
      const nextSeed = record.pendingAccount ? Buffer.from(record.pendingAccount.nextSeed.slice(2), 'hex') : randomBytes(32);
      try {
        const operation = await prepareHashAccountOperation({ intent: base, signingSeed, nextSigningSeed: nextSeed,
          async persistBeforeSigning(intent, replacement) {
            record.pendingAccount = { ...record.pendingAccount, intent, nextSeed: hexlify(replacement) };
            saveRecord(file, input.passphrase, record);
          },
        });
        record.pendingAccount = { ...record.pendingAccount, intent: { ...base, nextCommitment: operation.nextCommitment }, nextSeed: hexlify(nextSeed), operation };
        saveRecord(file, input.passphrase, record);
        if ((await assertCurrentProtocolTransaction(input.network, input.call.target, input.call.data)).manifestHash !== deployment.manifestHash) throw Error('hash_wallet_protocol_changed');
        return operation;
      } finally { nextSeed.fill(0); }
    } finally { signingSeed.fill(0); }
  });
}
/** Advance the local key after exact chain proof. Failed inner calls still
 * advance it. Keeping history makes an interrupted install recoverable. */
export async function completeActiveHashWalletOperation(input: { directory: string; passphrase: string;
  transactionHash: string; network: OwnerChainNetwork }): Promise<'succeeded' | 'target_failed' | 'cancelled'> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) throw Error('hash_wallet_not_active');
    const file = recordFile(directory, active.identity, active.commitment, active.context);
    const record = readRecord(file, input.passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    if (!hash.test(input.transactionHash)) throw Error('hash_wallet_receipt_invalid');
    if (record.completedAccount?.transactionHash === input.transactionHash) {
      if (record.completedAccount.outcome !== 'succeeded' && record.completedAccount.outcome !== 'target_failed' && record.completedAccount.outcome !== 'cancelled') throw Error('hash_wallet_history_invalid');
      return record.completedAccount.outcome;
    }
    if (!record.pendingAccount) throw Error('hash_wallet_pending_operation_missing');
    const variants = [record.pendingAccount.operation, record.pendingAccount.cancellation].filter((value): value is SignedHashAccountOperation => value !== undefined);
    if (variants.length === 0) throw Error('hash_wallet_pending_operation_missing');
    const verified = await verifyHashAccountVariantReceipt(variants, input.transactionHash, input.network);
    const outcome = verified.operation === record.pendingAccount.cancellation ? 'cancelled' : verified.outcome;
    record.completedAccount = { transactionHash: input.transactionHash, outcome };
    // Each completed generation has its own encrypted file. The live record
    // stays bounded while all predecessor keys remain recoverable.
    const archive = path.join(directory, 'hash-wallet-history', `${active.identity.slice(2)}-${input.transactionHash.slice(2)}.json`);
    saveRecord(archive, input.passphrase, record);
    // The index is only a locator: reads must authenticate the encrypted archive
    // and compare its exact operation id. Persist it before clearing pending.
    for (const variant of variants) {
      const index = path.join(directory, 'hash-wallet-operations', `${hashDeliveryId(variant).slice(2)}.json`);
      durableDirectory(path.dirname(index));
      const value = JSON.stringify({ transactionHash: input.transactionHash });
      atomicReplacePrivateFile(index, value);
      if (fs.readFileSync(index, 'utf8') !== value) throw Error('hash_wallet_history_index_unconfirmed');
    }
    record.accountSigningSeed = record.pendingAccount.nextSeed;
    delete record.pendingAccount;
    saveRecord(file, input.passphrase, record);
    return outcome;
  });
}

/** Public signatures may already have reached a gas sponsor even when its reply
 * was lost. Expose retained variants for receipt discovery; never erase them. */
export async function pendingActiveHashWalletOperations(input: { directory: string; passphrase: string }):
Promise<{ operation: SignedHashAccountOperation | null; cancellation: SignedHashAccountOperation | null }> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) throw Error('hash_wallet_not_active');
    const record = readRecord(recordFile(directory, active.identity, active.commitment, active.context), input.passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    return { operation: record.pendingAccount?.operation ?? null, cancellation: record.pendingAccount?.cancellation ?? null };
  });
}
/** A completion can precede the delivery-status write. Recover its original
 * variants from encrypted history rather than treating the missing pending
 * record as permission to sign another operation. No spending seed is returned. */
export async function readActiveHashWalletDelivery(input: { directory: string; passphrase: string; operationId?: string }): Promise<{
  active: ActiveHashWallet; operation: SignedHashAccountOperation | null; cancellation: SignedHashAccountOperation | null;
  completed: { transactionHash: string; outcome: 'succeeded' | 'target_failed' | 'cancelled' } | null;
}> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) throw Error('hash_wallet_not_active');
    const record = readRecord(recordFile(directory, active.identity, active.commitment, active.context), input.passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    const matches = (pending: BreakRecord['pendingAccount']) => !input.operationId || [pending?.operation, pending?.cancellation]
      .some(operation => operation && hashDeliveryId(operation) === input.operationId);
    if (input.operationId !== undefined && !hash.test(input.operationId)) throw Error('hash_wallet_delivery_invalid');
    if (record.pendingAccount && matches(record.pendingAccount)) return { active, operation: record.pendingAccount.operation ?? null, cancellation: record.pendingAccount.cancellation ?? null, completed: null };
    let completed = record.completedAccount;
    if (input.operationId) {
      const index = path.join(directory, 'hash-wallet-operations', `${input.operationId.slice(2)}.json`);
      let fd: number;
      try { fd = fs.openSync(index, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { active, operation: null, cancellation: null, completed: null }; }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('hash_wallet_history_invalid');
        const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>;
        if (!value || Object.keys(value).join(',') !== 'transactionHash' || typeof value.transactionHash !== 'string' || !hash.test(value.transactionHash)) throw Error('hash_wallet_history_invalid');
        const saved = readRecord(path.join(directory, 'hash-wallet-history', `${active.identity.slice(2)}-${value.transactionHash.slice(2)}.json`),
          input.passphrase, active.identity, active.commitment, active.context);
        if (!saved || !matches(saved.pendingAccount) || saved.completedAccount?.transactionHash !== value.transactionHash) throw Error('hash_wallet_history_invalid');
        completed = saved.completedAccount;
      } finally { fs.closeSync(fd); }
    }
    if (!completed) return { active, operation: null, cancellation: null, completed: null };
    if (!hash.test(completed.transactionHash) || !['succeeded', 'target_failed', 'cancelled'].includes(completed.outcome)) throw Error('hash_wallet_history_invalid');
    const archive = readRecord(path.join(directory, 'hash-wallet-history', `${active.identity.slice(2)}-${completed.transactionHash.slice(2)}.json`),
      input.passphrase, active.identity, active.commitment, active.context);
    if (!archive?.pendingAccount || archive.destination !== active.address || archive.restoredTransaction !== active.transactionHash
      || archive.completedAccount?.transactionHash !== completed.transactionHash || archive.completedAccount.outcome !== completed.outcome) throw Error('hash_wallet_history_invalid');
    return { active, operation: archive.pendingAccount.operation ?? null, cancellation: archive.pendingAccount.cancellation ?? null,
      completed: { transactionHash: completed.transactionHash, outcome: completed.outcome as 'succeeded' | 'target_failed' | 'cancelled' } };
  });
}
/** Explicit cancellation competes at the same nonce as the reserved call.
 * Both alternatives install the SAME durable successor key, so neither outcome
 * can strand it. A target retirement cannot prevent this owner-only no-op. */
export async function cancelActiveHashWalletOperation(input: { directory: string; passphrase: string;
  network: OwnerChainNetwork }): Promise<SignedHashAccountOperation> {
  const directory = path.resolve(input.directory);
  return locked(directory, input.passphrase, async () => {
    const active = readActiveHashWallet(directory);
    if (!active) throw Error('hash_wallet_not_active');
    const file = recordFile(directory, active.identity, active.commitment, active.context);
    const record = readRecord(file, input.passphrase, active.identity, active.commitment, active.context);
    if (!record || record.destination !== active.address || record.restoredTransaction !== active.transactionHash) throw Error('hash_wallet_record_mismatch');
    const pending = record.pendingAccount;
    if (!pending) throw Error('hash_wallet_pending_operation_missing');
    const state = await readHashAccountState(active.address, input.network);
    const seed = Buffer.from((record.accountSigningSeed ?? record.destinationSigningSeed).slice(2), 'hex');
    const nextSeed = Buffer.from(pending.nextSeed.slice(2), 'hex');
    try {
      if (await recoverySigningRoot(seed) !== state.root || state.nonce !== pending.intent.nonce) throw Error('hash_wallet_reconcile_pending_receipt');
      const operation = await prepareHashAccountOperation({
        intent: { chainId: '8453', account: active.address, nonce: pending.intent.nonce,
          target: active.address, value: '0', callGas: '50000', data: '0x' },
        signingSeed: seed, nextSigningSeed: nextSeed,
        async persistBeforeSigning(intent, replacement) {
          if (hexlify(replacement) !== pending.nextSeed || intent.nextCommitment !== pending.intent.nextCommitment) throw Error('hash_wallet_cancellation_key_changed');
          pending.cancellationReserved = true;
          saveRecord(file, input.passphrase, record);
        },
      });
      pending.cancellation = operation;
      saveRecord(file, input.passphrase, record);
      const latest = await readHashAccountState(active.address, input.network);
      if (latest.root !== state.root || latest.nonce !== state.nonce) throw Error('hash_wallet_reconcile_pending_receipt');
      return operation;
    } finally { seed.fill(0); nextSeed.fill(0); }
  });
}
