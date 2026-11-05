/**
 * `provian process-lane status` reads the lane's state as the observer last wrote it — but only under
 * the record it judged. A re-record (by hand, or a `provian` command healing the wrapper, the
 * correction) makes that state stale until the observer reads the new record: status says "starting",
 * never the old flag.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { currentProcessLaneState } from './process-lane';
import { LAUNCHER_RECORD_SCHEMA, launcherRecordKey, readLauncherRecord, writeLauncherRecord, processLauncherPath, processLaneStatePath } from '../observer/plugins/process-lane/launcher';

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

describe('currentProcessLaneState', () => {
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-status-'));
    writeLauncherRecord({ schema: LAUNCHER_RECORD_SCHEMA, fingerprint: 'f'.repeat(64), mode: 'template', template: ['a'.repeat(64)], recorded_at_ms: 5, source: 'doctor' }, processLauncherPath(home));
    const rec = readLauncherRecord(processLauncherPath(home));
    expect(rec).not.toBeNull();
    const writeState = (state: string, record: string | undefined) =>
      fs.writeFileSync(processLaneStatePath(home), JSON.stringify({ state, at_ms: 9, v: 2, ...(record === undefined ? {} : { record }) }));
    return { home, key: launcherRecordKey(rec!), writeState };
  };

  it('a state judged under the current record is read as written', () => {
    const { home, key, writeState } = setup();
    writeState('launcher_changed', sha(key));
    expect(currentProcessLaneState(home)).toBe('launcher_changed');
  });

  it('after a re-record the old state reads as starting (RED: under the same record it is the flag)', () => {
    const { home, writeState } = setup();
    writeState('launcher_changed', sha('the-record-before-the-heal'));
    expect(currentProcessLaneState(home)).toBe('starting');
  });

  it('no state file reads as unknown; a file with no record hash is read as written', () => {
    const { home, writeState } = setup();
    expect(currentProcessLaneState(home)).toBeNull();
    writeState('active', undefined);
    expect(currentProcessLaneState(home)).toBe('active');
  });
});
