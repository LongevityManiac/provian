import {setOriginPrivacySecret} from './src/observer/origin-privacy';
import { vi, beforeEach } from 'vitest';
// Unit HTTP implementations are injected doubles. Give their synthetic hostnames a
// public fixture answer; guard tests still inject private/failed DNS explicitly.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
setOriginPrivacySecret('pds_existing_test_fixture_credential');
/**
 * PE meter safety net for the suite: a device-mode client with no injected `peStore` writes to
 * the default filesystem store. Point that default at a throwaway directory so no test can ever
 * append to the developer's real `~/.provian/pe-store`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

if (!process.env.PROVIAN_PE_STORE_DIR) {
  process.env.PROVIAN_PE_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-pe-store-test-'));
}

// Every signer test has a durable throwaway journal, never the operator wallet journal.
beforeEach(() => { process.env.PROVIAN_NONCE_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-nonce-test-')); });
