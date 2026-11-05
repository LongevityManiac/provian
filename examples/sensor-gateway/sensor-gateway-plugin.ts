/**
 * A GATEWAY PLUGIN for the Provian observer — new-type intake .
 *
 * "The type of work is never the gate." A sensor (a kiln controller, a soil probe, a lab
 * instrument) drops one JSON reading per file into a directory on a registered machine. This
 * plugin reads each new file and hands the observer one PE per reading, typed with the reading's
 * own `action_type`, its digest in `output_digests`. The observer — never this plugin — stamps
 * the act with `metadata.source = 'observer_plugin'` and `metadata.observer_plugin =
 * 'sensor-gateway'` (the registered machine's observer is the witness), and the relay:
 *
 * - RECORDS a never-seen type with no mint (record_only), queues it for the operator’s review under
 * `device_gateway_observer`, and shows it on the public proposals dashboard
 * (GET /v1/pe/earning-proposals);
 * - earns it only once the operator signs a matrix row for that type — from the row's activation
 * forward, once per witnessed act;
 * - refuses a NAMED type (`send`, `escrow_completed`, …) and any type in a relay-owned namespace
 * (`service:…`, `git_…`): their witness is someone else's.
 *
 * Reading file shape (one per file, `*.json`):
 *
 * { "action_type" "kiln_cycle_completed", // the type of work, any well-formed identifier
 * "reading_id" "kiln-3/2026-10-22T12:00:00Z", // unique per reading (rides the PE's metadata)
 * "observed_at" 1792675200000, // epoch ms the sensor observed it (optional)
 *...any other fields // hashed into the digest, never sent }
 *
 * ONE READING, ONE PE. Each reading is keyed by the sha256 of its bytes: the PE carries that digest
 * (`output_digests`) and is recorded under the idempotency key `sensor_<digest hex>`, so the same
 * bytes seen again — a file still on disk after a crash or a failed move, a restart, a rescan — are
 * answered by this machine's PE store with the PE already recorded, never a second one. Only
 * `reading_id` is copied into metadata; the bytes never leave the machine.
 *
 * NOTHING IS OVERWRITTEN. Once its PE is recorded, a reading moves to `processed/<name>.<digest>.json`
 * holding exactly the bytes the PE's digest commits to (written with exclusive create; the source is
 * removed only if it still holds those bytes — a sensor that rewrote `latest.json` meanwhile keeps
 * its new reading in place for the next scan). A file that is not a valid reading moves to
 * `rejected/<name>.<digest>.json` the same way. A reading that could not be recorded stays in place
 * and is retried next tick. `finalize()` waits for every move in flight, so a clean shutdown leaves
 * no half-moved reading.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { ObserverPlugin, PluginPE, ProvianObserver } from '@provian/agent-sdk/observer';

/** The relay's action_type grammar (`action-type-syntax.ts`): flat, or lowercase namespace:name. */
const ACTION_TYPE_RE = /^(?:[A-Za-z][A-Za-z0-9_]*|[a-z][a-z0-9]*:[a-z][a-z0-9_]*)$/;
const MAX_ACTION_TYPE_LENGTH = 128; // the PE store's bound (the relay allows 200)
/** Namespaces the relay names for its own witness lanes; it refuses them from a gateway. */
const RELAY_OWNED_PREFIXES = ['service:', 'git_'];
const READING_ID_RE = /^[\x21-\x7E]{1,200}$/;
const MAX_READING_BYTES = 64 * 1024;

type PECommitOutcome = Parameters<NonNullable<ObserverPlugin['onCommitted']>>[1];

interface ParsedReading {
  readonly actionType: string;
  readonly readingId: string;
  readonly observedAtMs: number | null;
}

/** The sha256 hex of a reading's bytes: its PE digest, idempotency key and archive name. */
export function readingDigestHex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The idempotency key a reading is recorded under (the SDK/PE-store grammar: [A-Za-z0-9_-]{16,128}). */
export function readingIdempotencyKey(digestHex: string): string {
  return `sensor_${digestHex}`;
}

/** Parse one reading file. Returns the reason to set it aside for anything the relay would refuse. */
export function parseReading(bytes: Buffer): { reading: ParsedReading } | { skip: string } {
  if (bytes.length === 0 || bytes.length > MAX_READING_BYTES) return { skip: 'size' };
  let json: unknown;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { return { skip: 'not_json' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { skip: 'not_an_object' };
  const r = json as Record<string, unknown>;
  const actionType = r.action_type;
  if (typeof actionType !== 'string' || actionType.length > MAX_ACTION_TYPE_LENGTH || !ACTION_TYPE_RE.test(actionType)) {
    return { skip: 'bad_action_type' };
  }
  if (RELAY_OWNED_PREFIXES.some((prefix) => actionType.startsWith(prefix))) return { skip: 'relay_owned_namespace' };
  if (typeof r.reading_id !== 'string' || !READING_ID_RE.test(r.reading_id)) return { skip: 'bad_reading_id' };
  const observedAtMs = typeof r.observed_at === 'number' && Number.isSafeInteger(r.observed_at) && r.observed_at > 0
    ? r.observed_at
    : null;
  return { reading: { actionType, readingId: r.reading_id, observedAtMs } };
}

/**
 * Move `bytes` (read from `source`) to `<dir>/<stem>.<digest>.json` WITHOUT overwriting anything:
 * the destination is created exclusively (an existing one already holds these exact bytes, since
 * its name carries their digest), and the source is removed only if it still holds these bytes.
 */
export async function archiveReading(source: string, bytes: Buffer, digestHex: string, dir: string): Promise<void> {
  const stem = path.basename(source, '.json');
  const destination = path.join(dir, `${stem}.${digestHex}.json`);
  try {
    await fs.writeFile(destination, bytes, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let current: Buffer;
  try { current = await fs.readFile(source); } catch { return; } // already gone
  if (readingDigestHex(current) === digestHex) await fs.unlink(source).catch(() => {});
}

export class SensorGatewayPlugin implements ObserverPlugin {
  readonly name = 'sensor-gateway';
  private readonly queued: PluginPE[] = [];
  /** digest hex → the file and bytes it was read from, from the scan until its move finishes. */
  private readonly pending = new Map<string, { file: string; bytes: Buffer }>();
  /** Moves in flight; `finalize()` waits for them. */
  private readonly moves = new Set<Promise<void>>();
  private scanning: Promise<void> | null = null;

  constructor(private readonly dir: string, private readonly log: (msg: string) => void = () => {}) {}

  async init(_observer: ProvianObserver): Promise<void> {
    await fs.mkdir(path.join(this.dir, 'processed'), { recursive: true });
    await fs.mkdir(path.join(this.dir, 'rejected'), { recursive: true });
  }

  async start(): Promise<void> { /* the observer's tick drives the scan */ }

  async stop(): Promise<void> {
    await this.scan(); // hand over anything that arrived since the last tick
  }

  /** Called by the observer after its final drain: wait for every move still in flight. */
  async finalize(): Promise<void> {
    if (this.scanning) await this.scanning;
    await Promise.allSettled([...this.moves]);
  }

  tick(): null {
    void this.scan();
    return null;
  }

  drainPEs(): PluginPE[] {
    return this.queued.splice(0);
  }

  onCommitted(pe: PluginPE, outcome: PECommitOutcome): void {
    const hash = pe.output_digests?.[0]?.hash;
    const digestHex = typeof hash === 'string' && hash.startsWith('sha256:') ? hash.slice(7) : null;
    if (digestHex === null) return;
    const entry = this.pending.get(digestHex);
    if (!entry) return;
    if (outcome === 'failed') {
      this.pending.delete(digestHex); // stays on disk; the next scan hands it over again (same key)
      return;
    }
    // `pending` keeps the digest until the move finishes, so a scan racing the move skips it.
    this.track(archiveReading(entry.file, entry.bytes, digestHex, path.join(this.dir, 'processed'))
      .catch((err: unknown) => this.log(`sensor-gateway: could not move ${entry.file}: ${(err as Error).message}`))
      .finally(() => this.pending.delete(digestHex)));
  }

  private track(move: Promise<void>): void {
    this.moves.add(move);
    void move.finally(() => this.moves.delete(move));
  }

  private scan(): Promise<void> {
    if (!this.scanning) this.scanning = this.scanOnce().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const file = path.join(this.dir, name);
      let bytes: Buffer;
      try { bytes = await fs.readFile(file); } catch { continue; }
      const digestHex = readingDigestHex(bytes);
      if (this.pending.has(digestHex)) continue; // handed over, or being moved
      const parsed = parseReading(bytes);
      if ('skip' in parsed) {
        // Set aside once (so it is not re-read every tick); the relay would refuse it anyway.
        this.log(`sensor-gateway: setting aside ${name} (${parsed.skip})`);
        this.pending.set(digestHex, { file, bytes });
        this.track(archiveReading(file, bytes, digestHex, path.join(this.dir, 'rejected'))
          .catch(() => {})
          .finally(() => this.pending.delete(digestHex)));
        continue;
      }
      const { reading } = parsed;
      this.pending.set(digestHex, { file, bytes });
      const at = reading.observedAtMs ?? Date.now();
      this.queued.push({
        actionType: reading.actionType,
        // Only the reading id rides as metadata; the observer adds its own witness marker.
        metadata: { reading_id: reading.readingId },
        output_digests: [{ hash: `sha256:${digestHex}`, kind: 'sensor' }],
        windowStart: at,
        windowEnd: at + 1,
        // One reading, one PE: its own identity, never folded into a session window.
        skipDedupClaim: true,
        identityDecided: true,
        // The same bytes are answered with the PE already recorded (see the header).
        idempotencyKey: readingIdempotencyKey(digestHex),
        occurredAtMs: at,
      });
    }
  }
}
