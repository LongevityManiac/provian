import { constants, openSync, closeSync, fsyncSync, fstatSync, readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, toUtf8Bytes } from 'ethers';
const ensure = (value, reason) => { if (!value) throw Error('changeover_artifacts_' + reason); };
const digest = payload => sha256(toUtf8Bytes(JSON.stringify(payload)));

/** Immutable local review artifacts, never private signing material. Atomic
 * create elects one canonical phase plan across crashes or competing invocations.
 * File and directory fsync precede success. Hashes detect damaged files; callers
 * must still independently reconstruct their execution facts from the chain. */
export function openChangeoverArtifacts(directory) {
  const root = resolve(directory); mkdirSync(root, { recursive: true, mode: 0o700 });
  const directoryBarrier = () => {
    for (let current = root; ; current = dirname(current)) {
      const fd = openSync(current, constants.O_RDONLY);
      try { ensure(fstatSync(fd).isDirectory(), 'directory_invalid'); fsyncSync(fd); } finally { closeSync(fd); }
      if (dirname(current) === current) break;
    }
  };
  directoryBarrier();
  const path = name => {
    ensure(typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name), 'name_invalid'); return join(root, `${name}.json`);
  };
  const read = name => {
    directoryBarrier();
    let fd;
    try { fd = openSync(path(name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      ensure(fstatSync(fd).isFile(), 'file_invalid');
      const row = JSON.parse(readFileSync(fd, 'utf8'));
      ensure(row?.schema === 'provian.changeover-artifact.v1' && row.name === name
        && row.payload !== undefined && row.payloadHash === digest(row.payload), 'record_changed');
      fsyncSync(fd); return row.payload;
    } finally { closeSync(fd); }
  };
  return { read,
    create(name, incoming) {
      const payload = structuredClone(incoming), target = path(name);
      ensure(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload_invalid');
      const payloadHash = digest(payload);
      const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        try { writeFileSync(fd, JSON.stringify({ schema: 'provian.changeover-artifact.v1', name, payloadHash, payload }, null, 2) + '\n'); fsyncSync(fd); }
        finally { closeSync(fd); }
        try { linkSync(temporary, target); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const saved = read(name);
        ensure(saved !== null && digest(saved) === payloadHash, 'conflicting_record');
        const folder = openSync(root, constants.O_RDONLY);
        try { fsyncSync(folder); } finally { closeSync(folder); }
        return saved;
      } finally { unlinkSync(temporary); }
    },
  };
}
