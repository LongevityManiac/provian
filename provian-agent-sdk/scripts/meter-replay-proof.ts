/**
 * live proof — a single-lane act's replay is refused (run on the device that owns the
 * store, e.g. Atlas's Mac mini; it reads this device's credentials and PE store, sends nothing new
 * that could mint).
 *
 * Three replays of acts this device already sent, against the live relay:
 * A. the device's last accepted batch, rebuilt byte for byte and re-sent → 200 with the STORED
 * receipt (the same answer; nothing is priced again);
 * B. a batch at that OLD seq with a different body → 409 `batch_replay`;
 * C. a NEW batch (next seq, extending the tip) that carries an act from the last accepted batch
 * → 409 `act_chain_broken` (an act is accepted once: it must continue the device's chain).
 * The relay's tip must be unchanged afterwards.
 *
 * node meter-replay-proof.js
 */

import { ProvianClient } from '../src/ProvianClient';
import { loadCredentials } from '../src/scripts/credentials';
import { FsPeStore, defaultPeStoreRoot } from '../src/meter/pe-store';
import type { MeterAnswer, MeterTransport } from '../src/meter/transport';
import { batchHashOf, buildBatch, type PeV2 } from '../src/meter-wire';

interface Tip {
  readonly device_id: string;
  readonly seq: number;
  readonly batch_hash: string;
  readonly last_pe_hash: string;
}

function tipOf(answer: MeterAnswer): Tip {
  const b = answer.body as Partial<Tip> | null;
  if (answer.status !== 200 || !b || typeof b.seq !== 'number' || typeof b.batch_hash !== 'string' || typeof b.device_id !== 'string') {
    throw new Error(`tip unreadable: ${answer.status} ${answer.error ?? ''}`);
  }
  return { device_id: b.device_id, seq: b.seq, batch_hash: b.batch_hash, last_pe_hash: String(b.last_pe_hash) };
}

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('no device credentials on this machine');
  const client = new ProvianClient({
    relayUrl: creds.relayUrl, deviceKey: creds.deviceKey, deviceSecret: creds.deviceSecret,
    deviceId: creds.deviceId, signingMethod: creds.signingMethod, signingKeyAlias: creds.signingKeyAlias,
  });
  const transport = (client as unknown as { meterTransport(): MeterTransport }).meterTransport();
  const before = tipOf(await transport.getTip());
  const store = new FsPeStore(before.device_id, defaultPeStoreRoot());
  const last = await store.lastBatch();
  if (!last || last.created_at_ms === null || last.seq !== before.seq || last.batch_hash !== before.batch_hash) {
    throw new Error(`store's last batch (${last?.seq}) is not the relay's tip (${before.seq}); run again after the daemon's next send settles`);
  }
  const pes = (await store.readPes(last.first_index, last.count)).map((row) => row.pe as PeV2);
  console.log(`tip seq ${before.seq} ${before.batch_hash.slice(0, 16)}…  last batch: ${pes.length} acts, types ${[...new Set(pes.map((p) => p.action_type))].join(',')}`);

  // A — the identical batch, re-sent.
  const same = buildBatch({ device_id: before.device_id, seq: last.seq, prev_batch_hash: last.prev_batch_hash, created_at_ms: last.created_at_ms, pes });
  if (batchHashOf(same) !== last.batch_hash) throw new Error('rebuilt batch does not hash to the accepted one');
  const a = await transport.postBatch(same);
  const receipt = a.body as { seq?: number; acts?: unknown[] } | null;
  console.log(`A same batch re-sent      → ${a.status} (stored receipt seq ${receipt?.seq}, ${receipt?.acts?.length ?? 0} acts)`);

  // B — the old seq, a different body.
  const oldSeq = buildBatch({ device_id: before.device_id, seq: last.seq, prev_batch_hash: last.prev_batch_hash, created_at_ms: last.created_at_ms + 1, pes });
  const b = await transport.postBatch(oldSeq);
  console.log(`B old seq, new body        → ${b.status} ${(b.body as { error?: string } | null)?.error ?? b.error}`);

  // C — a new batch extending the tip that re-carries an already accepted act.
  const replayAct = buildBatch({ device_id: before.device_id, seq: before.seq + 1, prev_batch_hash: before.batch_hash, created_at_ms: Date.now(), pes: [pes[pes.length - 1]] });
  const c = await transport.postBatch(replayAct);
  console.log(`C next seq, accepted act   → ${c.status} ${(c.body as { error?: string } | null)?.error ?? c.error}`);

  const after = tipOf(await transport.getTip());
  console.log(`tip after: seq ${after.seq} ${after.batch_hash.slice(0, 16)}… (${after.batch_hash === before.batch_hash ? 'unchanged' : 'CHANGED'})`);
  const ok = a.status === 200 && receipt?.seq === last.seq
    && b.status === 409 && (b.body as { error?: string }).error === 'batch_replay'
    && c.status === 409 && (c.body as { error?: string }).error === 'act_chain_broken'
    && after.batch_hash === before.batch_hash;
  console.log(ok ? 'PROOF OK: every replay refused; nothing priced again' : 'PROOF FAILED');
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
