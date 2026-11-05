/**
 * The device's pending output citations : when an agent on this device RECEIVES
 * an output carrying its producer's signature (an HTTP response's `Provian-Output-Signature`,
 * captured by the SDK's fetch wrappers after checking the signature names the bytes actually
 * received), the next PE this device's observer records cites it. The queue lives beside the
 * device's own PE store (`<store>/pending-output-citations.jsonl`), on the device, never at the
 * relay; it is emptied into the next recorded PE.
 *
 * The citing PE is the device's own observed act, so the citation rides on a WITNESSED act; that
 * is what lets it count (the signature names the producer, nothing more). There is deliberately no
 * public "cite this signature" call: a citation is captured from what the device received, never
 * declared.
 *
 * Concurrency: appends are single `appendFileSync` writes (O_APPEND); a drain renames the file
 * first (atomic), so a citation appended during a drain lands in the next file, never lost.
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeOutputSignature, type OutputSignature } from '../output-signature';

export const PENDING_OUTPUT_CITATIONS_FILE = 'pending-output-citations.jsonl';
/** At most this many citations ride one PE (the input_origins cap is 64; leave room for the lane's own). */
export const MAX_CITATIONS_PER_PE = 16;
/** A queue longer than this drops its oldest entries (an output received but never followed by work). */
export const MAX_PENDING_CITATIONS = 256;

/** In-memory queues for stores without a directory (tests, embedders with a memory store). */
const memoryQueues = new Map<string, OutputSignature[]>();

function queueDir(location: string): string | null {
  try {
    if (fs.statSync(location).isDirectory()) return location;
  } catch {
    // absent: a file store on a device that has not recorded its first PE yet (below)
  }
  // A file store's location is an absolute path. Create it (0700) so the citation survives this
  // process: capture (a fetch) and the PE that cites it (the hook, the daemon) are different
  // processes, and the first outputs a brand-new device receives must not be lost.
  if (path.isAbsolute(location)) {
    try {
      fs.mkdirSync(location, { recursive: true, mode: 0o700 });
      return location;
    } catch {
      return null;
    }
  }
  return null;
}

/** Queue one received, signed output for this device's next PE. Never throws. */
export function enqueueOutputCitation(storeLocation: string, signature: OutputSignature): boolean {
  const s = normalizeOutputSignature(signature);
  if (s === null) return false;
  try {
    const dir = queueDir(storeLocation);
    if (dir === null) {
      const q = memoryQueues.get(storeLocation) ?? [];
      q.push(s);
      memoryQueues.set(storeLocation, q.slice(-MAX_PENDING_CITATIONS));
      return true;
    }
    fs.appendFileSync(path.join(dir, PENDING_OUTPUT_CITATIONS_FILE), `${JSON.stringify(s)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take up to `max` pending citations (oldest first, deduped by signer + hash); the rest stay queued.
 * Never throws: a failure answers [] and leaves the queue as it was.
 */
export function drainOutputCitations(storeLocation: string, max: number = MAX_CITATIONS_PER_PE): OutputSignature[] {
  const dedupe = (items: readonly OutputSignature[]): OutputSignature[] => {
    const seen = new Set<string>();
    const out: OutputSignature[] = [];
    for (const s of items) {
      const k = `${s.signer.kind}:${s.signer.id}|${s.hash}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  };
  try {
    const dir = queueDir(storeLocation);
    if (dir === null) {
      const all = dedupe(memoryQueues.get(storeLocation) ?? []);
      memoryQueues.set(storeLocation, all.slice(max));
      return all.slice(0, max);
    }
    const file = path.join(dir, PENDING_OUTPUT_CITATIONS_FILE);
    if (!fs.existsSync(file)) return [];
    const taking = `${file}.${process.pid}.${Date.now()}.draining`;
    fs.renameSync(file, taking);
    const parsed: OutputSignature[] = [];
    for (const line of fs.readFileSync(taking, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const s = normalizeOutputSignature(JSON.parse(line));
        if (s !== null) parsed.push(s);
      } catch {
        // a torn line is skipped, never fatal
      }
    }
    const all = dedupe(parsed).slice(-MAX_PENDING_CITATIONS);
    const rest = all.slice(max);
    for (const s of rest) fs.appendFileSync(file, `${JSON.stringify(s)}\n`, { mode: 0o600 });
    fs.rmSync(taking, { force: true });
    return all.slice(0, max);
  } catch {
    return [];
  }
}

/** Put citations back (the PE they were drained for was not recorded). */
export function requeueOutputCitations(storeLocation: string, signatures: readonly OutputSignature[]): void {
  for (const s of signatures) enqueueOutputCitation(storeLocation, s);
}
