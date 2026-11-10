import * as fs from 'fs';
import * as path from 'path';

/** Persist every directory link before returning a root backed by a new seed.
 * Sync existing ancestors too: an earlier interrupted attempt may have created
 * them without reaching its parent fsync. File fsync alone cannot close this gap. */
export function durableDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = path.resolve(directory);
  for (;;) {
    const fd = fs.openSync(current, 'r');
    try {
      if (!fs.fstatSync(fd).isDirectory()) throw Error('private_backup_directory_invalid');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
