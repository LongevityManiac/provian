/**
 * live proof — the PE Archive's local drop, run on the device that keeps the PEs.
 *
 * A device drops a day only when the Archive has CONFIRMED it and the day is at least 30 days old
 * (`archiveDayDroppable`). The meter is days old, so no real day is old enough yet. This runs the
 * device's REAL keeper against the REAL relay and Archive with ONE thing changed: the clock it uses for
 * the drop decision is shifted forward (`--shift-days`). Upload readiness never reads the clock (a day
 * uploads only when every batch holds a verified anchor proof), so the shift cannot upload an open day.
 * The keeper still reads the day back, opens it with the owner's key and matches every PE before it
 * drops anything. Back up the store before running `drop`.
 *
 * PROVIAN_KEYSTORE_PASSPHRASE=… node archive-drop-proof.js status
 * PROVIAN_KEYSTORE_PASSPHRASE=… node archive-drop-proof.js drop --shift-days 31
 * PROVIAN_KEYSTORE_PASSPHRASE=… node archive-drop-proof.js check --pe <pe_id>
 * PROVIAN_KEYSTORE_PASSPHRASE=… node archive-drop-proof.js verify --pe <pe_id> [--rpc <base rpc>]
 *
 * `verify` re-proves one act without presenting it (no burn): it builds the act's two-hop proof
 * from this device's store (pulling a dropped day back from the Archive), checks hop 1 offline
 * (act leaf → acts_root → batch leaf) and hop 2 on Base (`PEAnchor.verifyPE`, a free view call —
 * the anchored tree's own hashing, so the chain is the check).
 */
import { ProvianClient } from '../src/ProvianClient';
import { loadCredentials } from '../src/scripts/credentials';
import { agentMessageSecretProvider } from '../src/meter/message-key';
import type { ArchiveKeeperOptions } from '../src/meter/archive';
import { peFactFromStore } from '../src/meter/prove';
import { verifyActInclusion } from '../src/meter-wire';
import { PROVIAN_BASE_PE_ANCHOR } from '../src/presentation-verify';
import type { PeStore } from '../src/meter/pe-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function keeper(shiftDays: number) {
  const creds = loadCredentials();
  if (!creds) throw new Error('no device credentials on this machine');
  const client = new ProvianClient({
    relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
    deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
  });
  const options: Partial<Omit<ArchiveKeeperOptions, 'store' | 'transport'>> = {
    messageSecretKey: agentMessageSecretProvider(creds.agentWalletId),
    now: () => Date.now() + shiftDays * DAY_MS,
    log: (level, msg, extra) => console.log(`[${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
  };
  const k = await client.createArchiveKeeper(options);
  const store = await (client as unknown as { getPeStore(): Promise<{ findPe(id: string): Promise<unknown>; findArchived?(id: string): Promise<unknown>; listArchivedDays?(): Promise<unknown[]> }> }).getPeStore();
  return { k, store };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const { k, store } = await keeper(0);
    console.log('ready days (upload):', (await k.readyDays()).map((d) => `${d.day}:${d.batches.length} batches`).join(', ') || '(none)');
    console.log('dropped days here:', JSON.stringify((await store.listArchivedDays?.()) ?? []));
    return;
  }
  if (cmd === 'drop') {
    const shift = Number(arg('shift-days') ?? '31');
    if (!Number.isInteger(shift) || shift < 0 || shift > 60) throw new Error('--shift-days must be an integer 0..60');
    const { k, store } = await keeper(shift);
    console.log(`drop decision clock: ${new Date(Date.now() + shift * DAY_MS).toISOString()} (real now + ${shift} days)`);
    console.log('report', JSON.stringify(await k.run()));
    console.log('dropped days here:', JSON.stringify((await store.listArchivedDays?.()) ?? []));
    return;
  }
  if (cmd === 'check') {
    const pe = arg('pe');
    if (!pe) throw new Error('--pe is required');
    const { store } = await keeper(0);
    console.log(JSON.stringify({ pe, held_in_full_here: (await store.findPe(pe)) !== null, archived_pointer: (await store.findArchived?.(pe)) ?? null }));
    return;
  }
  if (cmd === 'verify') {
    const pe = arg('pe');
    if (!pe) throw new Error('--pe is required');
    const { k, store } = await keeper(0);
    const fact = await peFactFromStore(store as unknown as PeStore, pe, k);
    if (!fact.ok) throw new Error(fact.detail);
    const { inclusion } = fact.fact;
    const anchor = inclusion.anchor;
    if (!anchor) throw new Error('not anchored');
    const hop1 = verifyActInclusion(fact.fact.pe, inclusion);
    if (!hop1.ok) throw new Error(`hop 1 failed: ${hop1.reason}`);
    const { keccak256, concat, createPublicClient, http } = await import('viem');
    const leaf = keccak256(concat(['0x00', `0x${hop1.batch_leaf.replace(/^0x/, '')}`]));
    const client = createPublicClient({ transport: http(arg('rpc') ?? 'https://mainnet.base.org') });
    const onchain = await client.readContract({
      address: PROVIAN_BASE_PE_ANCHOR as `0x${string}`,
      abi: [{ type: 'function', name: 'verifyPE', stateMutability: 'view', inputs: [{ name: 'batchId', type: 'bytes32' }, { name: 'peHash', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }], outputs: [{ name: '', type: 'bool' }] }] as const,
      functionName: 'verifyPE',
      args: [anchor.anchor_batch_id as `0x${string}`, leaf, anchor.proof as `0x${string}`[]],
    });
    console.log(JSON.stringify({
      pe, held_in_full_here: (await store.findPe(pe)) !== null, day: anchor.day, pe_hash: fact.fact.envelopeHash,
      hop1_act_in_batch: true, batch_leaf: hop1.batch_leaf, anchored_leaf: leaf, merkle_root: anchor.merkle_root,
      anchor_contract: PROVIAN_BASE_PE_ANCHOR, anchor_tx: anchor.tx_hash, verifyPE_on_base: onchain,
    }));
    return;
  }
  throw new Error('usage: status | drop --shift-days <n> | check --pe <pe_id> | verify --pe <pe_id>');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
