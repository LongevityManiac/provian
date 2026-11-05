import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

it.each(['BASE_RPC_URL_SECONDARY', 'BASE_TRACE_RPC_URL_SECONDARY'])('refuses a plaintext %s before shell sourcing or cloud calls', name => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-secret-guard-'));
  try {
    fs.copyFileSync(path.resolve(__dirname, '../../../deploy-env.sh'), path.join(dir, 'deploy-env.sh'));
    fs.mkdirSync(path.join(dir, 'bin'));
    // Only the local fixture stamp prerequisite succeeds; no real tool is invoked.
    fs.writeFileSync(path.join(dir, 'bin/npx'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'bin/gcloud'), '#!/bin/sh\ntouch "$CLOUD_CALLED"\nexit 99\n', { mode: 0o700 });
    const marker = 'fixture_credential_must_not_be_printed';
    fs.writeFileSync(path.join(dir, '.env.deploy'), `${name}="https://lb.drpc.org/ogrpc?network=base&dkey=${marker}"\n`);
    const cloudCalled = path.join(dir, 'cloud-called');
    const result = spawnSync('/bin/bash', [path.join(dir, 'deploy-env.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, CLOUD_CALLED: cloudCalled },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('.env.deploy contains plaintext values for Secret Manager managed vars');
    expect(result.stdout).toContain(name);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(fs.existsSync(cloudCalled)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
