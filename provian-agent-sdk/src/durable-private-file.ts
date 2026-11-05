import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Atomically replace a private local state file and do not return until both
 * the file contents/metadata and containing-directory rename are fsynced.
 *
 * This is for restart-critical non-secret markers. Secret-bearing formats may
 * layer encryption on top, but must retain the same temp -> fsync -> rename ->
 * file fsync -> directory fsync ordering.
 */
export function atomicReplacePrivateFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const tempFd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(tempFd, contents, 'utf8');
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    const installedFd = fs.openSync(filePath, 'r');
    try {
      const installed = fs.fstatSync(installedFd);
      if (!installed.isFile()
        || (process.platform !== 'win32' && (installed.mode & 0o777) !== 0o600)) {
        throw new Error(`Durable private file ${filePath} is not a 0600 regular file`);
      }
      fs.fsyncSync(installedFd);
    } finally { fs.closeSync(installedFd); }
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* renamed or already removed */ }
  }
}
