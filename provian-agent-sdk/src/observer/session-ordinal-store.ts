/**
 * the durable session ordinal, agent-side.
 *
 * The relay now keeps a per-device registry and requires each new session to
 * present exactly `current_ordinal + 1` (see
 * `provian-backend/src/core/pvt/device-session-registry.ts`). That is what makes
 * sessions countable and non-forkable — and it means the ordinal CANNOT live in
 * memory: an observer restart would reset it to 1, the relay would refuse every
 * session after the first with `session_superseded`, and every observed PE would
 * stop being recorded.
 *
 * So it is persisted, with the same durability the rest of this SDK's
 * restart-critical markers use: temp file → fsync → rename → fsync → directory
 * fsync, via `atomicReplacePrivateFile`.
 *
 * RESERVE-BEFORE-USE. `reserveNext()` writes `n + 1` to disk BEFORE returning
 * `n`. A crash between the write and the session opening therefore SKIPS an
 * ordinal rather than reusing one — and a skip is refused by the relay
 * (`session_ordinal_gap`) while a reuse would be a silent fork. Given a choice
 * between losing a session and forking one, lose it: the loud failure is
 * recoverable, the quiet one corrupts the count the registry exists to provide.
 *
 * The file is keyed by device id. A different device starts its own sequence at
 * 1, because the relay's registry is per device too.
 */

import * as fs from 'fs';
import { atomicReplacePrivateFile } from '../durable-private-file';

export interface SessionOrdinalState {
  readonly device_id: string;
  /** The next ordinal to hand out. 1-based. */
  readonly next_ordinal: number;
}

export interface SessionOrdinalStore {
  /** Durably reserve and return the next ordinal for this device. */
  reserveNext(): number;
  /** Current value without reserving. For diagnostics and tests. */
  peek(): number;
  /**
   * adopt the ordinal the RELAY says it expects next.
   *
   * Reserve-before-use burns an ordinal at session open, but the relay only
   * advances when a PE carrying it is admitted. A session that opened and never
   * landed a lineage-bearing PE therefore left this counter one ahead, and every
   * later session was refused `session_ordinal_gap` forever, with the observed
   * PEs no longer being recorded at all. called that skip "recoverable";
   * nothing implemented the recovery. This is it.
   *
   * The value comes from the relay's own registry, so adopting it hands the
   * client nothing it could not compute: only one session can ever occupy an
   * ordinal, and the relay's counter still only moves forward.
   */
  adoptRelayOrdinal(nextOrdinal: number): void;
}

/** A file that belongs to a DIFFERENT device. Distinct from absent on purpose. */
export class ForeignDeviceOrdinalFileError extends Error {
  constructor(filePath: string, fileDeviceId: string, expectedDeviceId: string) {
    super(
      `session ordinal file ${filePath} belongs to device ${fileDeviceId}, not ${expectedDeviceId}. `
      + 'Two devices must not share one sessionOrdinalPath.',
    );
    this.name = 'ForeignDeviceOrdinalFileError';
  }
}

type ReadOutcome =
  | { kind: 'absent' }
  | { kind: 'foreign'; deviceId: string }
  | { kind: 'ok'; state: SessionOrdinalState };

function readState(filePath: string, deviceId: string): ReadOutcome {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { kind: 'absent' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'absent' };
    const s = parsed as Partial<SessionOrdinalState>;
    if (typeof s.device_id !== 'string' || typeof s.next_ordinal !== 'number') {
      return { kind: 'absent' };
    }
    if (!Number.isSafeInteger(s.next_ordinal) || s.next_ordinal < 1) return { kind: 'absent' };
    // a foreign file is REFUSED, not ignored.
    //
    // It used to be treated as absent, and `reserveNext` then OVERWROTE it. Two
    // devices pointed at one `sessionOrdinalPath` (a configuration the option's
    // own docstring invites) would each keep clobbering the other back to 1 and
    // both would be locked out permanently, with no message naming the cause.
    if (s.device_id !== deviceId) return { kind: 'foreign', deviceId: s.device_id };
    return { kind: 'ok', state: s as SessionOrdinalState };
  } catch {
    // A corrupt file is treated as absent. That restarts the sequence at 1; the
    // relay refuses that loudly and now returns its expected ordinal, which
    // `adoptRelayOrdinal` uses to resynchronise.
    return { kind: 'absent' };
  }
}

function currentOrdinal(filePath: string, deviceId: string): number {
  const outcome = readState(filePath, deviceId);
  if (outcome.kind === 'foreign') {
    throw new ForeignDeviceOrdinalFileError(filePath, outcome.deviceId, deviceId);
  }
  return outcome.kind === 'ok' ? outcome.state.next_ordinal : 1;
}

/**
 * an exclusive lock around the read-modify-write.
 *
 * `reserveNext` was a bare read-then-write, so two observer processes sharing
 * one device credential (and therefore one file) could both read `n` and both
 * return it — two lineage ids at one ordinal, which the registry refuses as a
 * fork, dropping the loser's PEs every session. `wx` is the atomic primitive:
 * exactly one creator wins.
 */
function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 2_000;
  let handle: number | null = null;
  for (;;) {
    try {
      handle = fs.openSync(lockPath, 'wx');
      break;
    } catch {
      if (Date.now() >= deadline) {
        // A stale lock must not wedge the observer forever. Steal it: the worst
        // case is the pre- behaviour, and the relay still refuses a fork.
        try { fs.unlinkSync(lockPath); } catch { /* raced; retry */ }
      }
    }
  }
  try {
    return fn();
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch { /* ignore */ } }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

export function createSessionOrdinalStore(
  filePath: string,
  deviceId: string,
): SessionOrdinalStore {
  return {
    peek(): number {
      return currentOrdinal(filePath, deviceId);
    },
    reserveNext(): number {
      return withFileLock(filePath, () => {
        const current = currentOrdinal(filePath, deviceId);
        const next: SessionOrdinalState = { device_id: deviceId, next_ordinal: current + 1 };
        // Persist FIRST. See the reserve-before-use note above.
        atomicReplacePrivateFile(filePath, JSON.stringify(next));
        return current;
      });
    },
    adoptRelayOrdinal(nextOrdinal: number): void {
      if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal < 1) return;
      withFileLock(filePath, () => {
        atomicReplacePrivateFile(
          filePath,
          JSON.stringify({ device_id: deviceId, next_ordinal: nextOrdinal }),
        );
      });
    },
  };
}
