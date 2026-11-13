import * as Device from 'expo-device';
import config from './config';
import type { CloudFileTransport, CloudKind } from '../../../src/core/meter/cloudFiles';
import { createExpoMeterFiles } from '../../../src/core/meter/meterFiles';
import { PE_ARCHIVE_KDF_INFO, PE_BACKUP_INDEX_SCHEMA, PE_BACKUP_MANIFEST_SCHEMA } from '../../../src/core/meter/peCloudBackup';
export type { CloudFileTransport, CloudKind };

function requireIsolation(): void {
  if (!__DEV__ || Device.isDevice || config.relay !== 'http://127.0.0.1:18551'
    || !/^0x[0-9a-f]{64}$/.test(config.instanceId) || !/^[a-z0-9-]+$/.test(config.userId)) throw Error('isolated_native_build_required');
}
function nameChecked(name: string): void {
  if (!/^pe_[a-z0-9_-]{1,90}$/.test(name)) throw Error('isolated_pe_backup_name_refused');
}
function ciphertextChecked(text: string): void {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('isolated_pe_ciphertext_required');
  const box = parsed as Record<string, unknown>;
  const object = box.v === 1 && box.alg === 'AES-256-GCM' && Object.keys(box).every(k => ['v', 'alg', 'nonce', 'data'].includes(k));
  const kdf = box.kdf;
  const manifest = [PE_BACKUP_INDEX_SCHEMA, PE_BACKUP_MANIFEST_SCHEMA].includes(String(box.schema))
    && Object.keys(box).every(k => ['schema', 'kdf', 'nonce', 'data'].includes(k))
    && kdf !== null && typeof kdf === 'object' && !Array.isArray(kdf)
    && Object.keys(kdf).every(k => ['salt', 'info'].includes(k))
    && 'salt' in kdf && typeof kdf.salt === 'string' && /^[0-9a-f]{2,128}$/.test(kdf.salt)
    && 'info' in kdf && kdf.info === PE_ARCHIVE_KDF_INFO;
  if (!(object || manifest) || typeof box.nonce !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(box.nonce)
    || typeof box.data !== 'string' || !/^[A-Za-z0-9+/]{22,}={0,2}$/.test(box.data)) throw Error('isolated_pe_ciphertext_required');
}
export function createPlatformCloudFiles(): CloudFileTransport {
  requireIsolation();
  // Different public test members must not try to decrypt each other's backups.
  // Earlier fixture directories remain untouched.
  const files = createExpoMeterFiles(`isolated_recourse_cloud_${config.instanceId.slice(2)}_${config.userId}`);
  return {
    kind: 'memory',
    async available() { requireIsolation(); return true; },
    async prepare() { requireIsolation(); return (await files.list('')).length > 0; },
    async write(name, text) {
      requireIsolation(); nameChecked(name); ciphertextChecked(text);
      await files.writeAtomic(name, text);
      if (await files.read(name) !== text) throw Error('isolated_pe_write_unconfirmed');
    },
    async read(name) { requireIsolation(); nameChecked(name); return files.read(name); },
    async list() { requireIsolation(); return (await files.list('')).filter(name => /^pe_[a-z0-9_-]{1,90}$/.test(name)); },
  };
}
export function cloudPlaceLabel(_kind?: CloudKind): string { requireIsolation(); return 'local simulator files'; }
