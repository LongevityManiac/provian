/** Export a retired key in the existing portable keystore format. It controls
 * the original EVM addresses AND the original KDF-derived Solana address. */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { readLocalKeystoreSecret } from './local-keystore-secret';
import { readRotationJournal } from './rotation-journal';
import { loadKeystore } from './keystore';
export function exportRetiredKeystore(destination: string, rotationId?: string, directory = path.join(homedir(), '.provian')): string {
  if (rotationId && !/^rotation_[0-9a-f-]{36}$/.test(rotationId)) throw new Error('Invalid rotation id');
  const secret = readLocalKeystoreSecret(path.join(directory, 'agent-keystore.secret'));
  if (!secret) throw new Error('The existing keystore secret is missing');
  const journal = readRotationJournal(rotationId ? path.join(directory, 'rotations', `${rotationId}.json`) : path.join(directory, 'rotation-journal.json'), secret);
  const retired = journal?.oldKeystore ?? (!rotationId ? loadKeystore(path.join(directory, 'agent-keystore.retired.json')) : null);
  if (!retired) throw new Error('No retired keystore found');
  // Never let an export overwrite current keys, credentials, secret or journals.
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const resolved = path.join(parent, path.basename(destination));
  const relative = path.relative(fs.realpathSync(directory), resolved);
  if ((!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Export retired keys outside the active wallet directory');
  // Exclusive creation also refuses a final-component symlink and existing
  // destinations. Never replace a file during an export.
  const fd = fs.openSync(resolved, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(retired, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directoryFd = fs.openSync(parent, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  return resolved;
}
