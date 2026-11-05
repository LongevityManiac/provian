#!/usr/bin/env node
/**
 * copy-assets: post-tsc build helper that copies non-TS artifacts from
 * src/ into the compiled dist/ tree so runtime __dirname-relative reads
 * resolve in both dev checkouts and packaged SDK installs.
 *
 * Currently handles:
 *   src/observer/config/ai-providers.json -> dist/observer/config/ai-providers.json
 *   contracts/deployments/*.json (canonical artifacts) -> dist/deployments/*.json
 *     so contract-addresses.ts resolves the SAME single-source deployment files
 *     in the packaged SDK as it does in the monorepo (no committed mirror).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Repo-root contracts/deployments — the canonical source of truth consumed by
// src/contract-addresses.ts. Copied verbatim (no edits) into dist/deployments.
const DEPLOYMENTS_ROOT = path.resolve(PROJECT_ROOT, '..', 'contracts', 'deployments');

const DEPLOYMENT_ARTIFACTS = [
  'base-pvt9-institutions.json', // institution deployment/PVT9 Base institutions — the live default set
  'base-retired-addresses.json', // loaded solely for the retired guard set
  'arbitrum-live.json',
  'optimism-live.json',
];

const COPY_MAP = [
  [
    path.join(PROJECT_ROOT, 'src', 'observer', 'config', 'ai-providers.json'),
    path.join(PROJECT_ROOT, 'dist', 'observer', 'config', 'ai-providers.json'),
  ],
  ...DEPLOYMENT_ARTIFACTS.map((file) => [
    path.join(DEPLOYMENTS_ROOT, file),
    path.join(PROJECT_ROOT, 'dist', 'deployments', file),
  ]),
];

for (const [src, dst] of COPY_MAP) {
  if (!fs.existsSync(src)) {
    process.stderr.write(`copy-assets: source missing: ${src}\n`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
