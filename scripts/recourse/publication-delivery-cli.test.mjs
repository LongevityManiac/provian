import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const runner = new URL('../../provian-backend/node_modules/.bin/tsx', import.meta.url).pathname;
const cli = new URL('./publication-delivery-cli.mjs', import.meta.url).pathname;
const env = { ...process.env, GOOGLE_CLOUD_PROJECT: '', FIRESTORE_DATABASE_ID: '', BASE_RPC_URL: 'invalid', BASE_RPC_URL_SECONDARY: 'invalid' };
test('CLI help reads no provider, database or private key; execution-only flags refuse before input access', () => {
  const help = spawnSync(runner, [cli, '--help'], { env, encoding: 'utf8' });
  expect(help.status).toBe(0); expect(help.stdout).toContain('Default is read-only recovery/inspection');
  for (const flag of ['--watch', '--cancel-gas']) {
    const result = spawnSync(runner, [cli, '/missing-input', flag], { env, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr.trim()).toBe('publication_delivery_cli_execution_required');
  }
  const extra = spawnSync(runner, [cli, '/missing-input', '--execute', '--unknown'], { env, encoding: 'utf8' });
  expect(extra.status).toBe(1); expect(extra.stderr.trim()).toBe('publication_delivery_cli_usage');
}, 20000);
test('explicit database selection is required even for inspection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'provian-publication-cli-test-'));
  try {
    const input = join(directory, 'inputs.json'); writeFileSync(input, JSON.stringify({ callGas: '2000000' }));
    for (const flags of [[], ['--execute']]) {
      const result = spawnSync(runner, [cli, input, ...flags], { env, encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr.trim()).toBe('publication_delivery_cli_database_selection');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20000);
