/**
 * PE METER — find this machine's own PE store from outside the daemon (CLI verbs, `pes`, a
 * presenter building a pe_fact).
 *
 * The store lives at `<root>/<device dir>` (root: `PROVIAN_PE_STORE_DIR`, else `~/.provian/pe-store`).
 * The device id comes from the caller (the credentials' PROVIAN_DEVICE_ID); without one, the
 * store is resolved only when the root holds exactly ONE device's store — never a guess between two.
 */

import * as fs from 'fs';
import * as path from 'path';
import { defaultPeStoreRoot, FsPeStore } from './pe-store';

/** Directory names the store writes for a registered device (`dev_<hex>`). */
const DEVICE_DIR = /^dev_[A-Za-z0-9]{1,128}$/;

export type LocalPeStoreResolution =
  | { readonly ok: true; readonly store: FsPeStore }
  | { readonly ok: false; readonly reason: 'no_store' | 'ambiguous'; readonly detail: string };

export function resolveLocalPeStore(options: {
  readonly deviceId?: string | null;
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
} = {}): LocalPeStoreResolution {
  const env = options.env ?? process.env;
  const root = options.root ?? defaultPeStoreRoot(env);
  const deviceId = options.deviceId ?? (env.PROVIAN_DEVICE_ID?.trim() || null);
  if (deviceId) return { ok: true, store: new FsPeStore(deviceId, root) };
  let entries: string[];
  try {
    entries = fs.readdirSync(root).filter((name) => DEVICE_DIR.test(name)
      && fs.existsSync(path.join(root, name, 'pes.jsonl')));
  } catch {
    entries = [];
  }
  if (entries.length === 1) return { ok: true, store: new FsPeStore(entries[0], root) };
  if (entries.length === 0) {
    return { ok: false, reason: 'no_store', detail: `no PE store under ${root} (PEs are kept by the observer daemon on the machine that recorded them)` };
  }
  return { ok: false, reason: 'ambiguous', detail: `${entries.length} device stores under ${root}; set PROVIAN_DEVICE_ID to choose one` };
}
