#!/usr/bin/env node
/** Rebuild the current source, then bind both independent Base reads to pinned runtime bytes. Read-only. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'provian-backend/package.json'));
const { keccak256, toUtf8Bytes, JsonRpcProvider, Interface } = require('ethers');

export function assertPinScope(pins, config) {
  const names = pins.contracts?.map(pin => pin.name).sort();
  if (pins.chain_id !== config.network.chain_id || JSON.stringify(names) !== JSON.stringify(['ProvianPVT9', 'ProvianPVT9EligibilityVerifier'])) throw Error('runtime_pin_scope_invalid');
  if (pins.contracts.some(pin => !/^0x[0-9a-f]{40}$/i.test(pin.address) || !/^0x[0-9a-f]{64}$/.test(pin.codehash))
    || new Set(pins.contracts.map(pin => pin.address.toLowerCase())).size !== 2
    || pins.contracts.find(pin => pin.name === 'ProvianPVT9').address.toLowerCase() !== config.assets.pvt9.address.toLowerCase()) throw Error('runtime_pin_scope_invalid');
}

export function assertRuntime(code, artifact, pin) {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw Error('runtime_missing_or_malformed');
  if (keccak256(code) !== pin.codehash) throw Error('runtime_codehash_mismatch');
  const actual = Buffer.from(code.slice(2), 'hex');
  const expected = Buffer.from(artifact.deployedBytecode.object.replace(/^0x/, ''), 'hex');
  if (actual.length !== expected.length) throw Error('runtime_length_mismatch');
  // Only compiler-declared constructor slots differ. Their actual values remain bound by the full codehash.
  for (const spans of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of spans) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || start + length > actual.length) throw Error('runtime_immutable_range_invalid');
      actual.fill(0, start, start + length); expected.fill(0, start, start + length);
    }
  }
  if (!actual.equals(expected)) throw Error('runtime_source_mismatch');
}

export function assertArtifactSources(artifact, readSource) {
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const sources = Object.entries(metadata.sources ?? {});
  if (!sources.length) throw Error('runtime_source_population_empty');
  for (const [name, source] of sources) {
    if (keccak256(toUtf8Bytes(readSource(name))) !== source.keccak256) throw Error('runtime_artifact_source_stale');
  }
  return sources.length;
}

async function main() {
  const pins = JSON.parse(readFileSync(resolve(root, 'config/pvt9-runtime-codehashes.json'), 'utf8'));
  const config = JSON.parse(readFileSync(resolve(root, 'config/pvt9-base.json'), 'utf8'));
  assertPinScope(pins, config);
  const urls = [process.env.BASE_RPC_URL, process.env.BASE_RPC_URL_SECONDARY];
  const ids = [process.env.BASE_RPC_OPERATOR_ID, process.env.BASE_RPC_SECONDARY_OPERATOR_ID];
  if (urls.some(v => !v) || ids.some(v => !v) || ids[0] === ids[1] || urls[0] === urls[1]) throw Error('runtime_independent_rpc_configuration_required');
  execFileSync('forge', ['build', '--root', resolve(root, 'contracts'), '--force', '--skip', 'test', '--skip', 'script'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const providers = urls.map(url => new JsonRpcProvider(url, undefined, { batchMaxCount: 1 }));
  try {
    const chains = await Promise.all(providers.map(p => p.send('eth_chainId', [])));
    if (chains.some(c => Number(BigInt(c)) !== pins.chain_id)) throw Error('runtime_chain_mismatch');
    const tips = await Promise.all(providers.map(p => p.send('eth_blockNumber', [])));
    const block = Math.min(...tips.map(t => Number(BigInt(t)))) - 11;
    if (!Number.isSafeInteger(block) || block < 0) throw Error('runtime_head_invalid');
    const blocks = await Promise.all(providers.map(p => p.send('eth_getBlockByNumber', ['0x' + block.toString(16), false])));
    if (!blocks[0]?.hash || blocks[0].hash !== blocks[1]?.hash) throw Error('runtime_canonical_block_disagreement');
    const tag = { blockHash: blocks[0].hash, requireCanonical: true };
    const abi = new Interface(config.assets.pvt9.abi);
    const activeVerifiers = await Promise.all(providers.map(async provider => {
      const call = async (name, args = []) => abi.decodeFunctionResult(name, await provider.send('eth_call', [{ to: config.assets.pvt9.address, data: abi.encodeFunctionData(name, args) }, tag]));
      const [epoch] = await call('lastOpenedEpoch');
      const [policy] = await call('getEpochPolicy', [epoch]);
      return policy.eligibilityVerifier.verifier.toLowerCase();
    }));
    const verifierPin = pins.contracts.find(pin => pin.name === 'ProvianPVT9EligibilityVerifier');
    if (activeVerifiers.some(address => address !== verifierPin.address.toLowerCase())) throw Error('runtime_active_verifier_mismatch');
    const results = [];
    for (const pin of pins.contracts) {
      const artifact = JSON.parse(readFileSync(resolve(root, `contracts/out/${pin.name}.sol/${pin.name}.json`), 'utf8'));
      const sources = assertArtifactSources(artifact, name => readFileSync(resolve(root, 'contracts', name), 'utf8'));
      const codes = await Promise.all(providers.map(p => p.send('eth_getCode', [pin.address, tag])));
      if (codes[0] !== codes[1]) throw Error('runtime_provider_code_disagreement');
      for (const code of codes) assertRuntime(code, artifact, pin);
      results.push({ name: pin.name, address: pin.address, codehash: pin.codehash, source_files: sources, bytes: (codes[0].length - 2) / 2 });
    }
    console.log(JSON.stringify({ ok: true, block, block_hash: blocks[0].hash, operators: ids, contracts: results }, null, 2));
  } finally { for (const provider of providers) provider.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('PVT9 runtime binding failed; no chain write was attempted.'); process.exitCode = 1; });
}
