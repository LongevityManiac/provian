import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toUtf8Bytes } from 'ethers';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = process.argv[2] && process.argv[2] !== '--check' ? resolve(process.argv[2]) : resolve(root, 'contracts/out');
const read = name => JSON.parse(readFileSync(resolve(source, `${name}.sol/${name}.json`), 'utf8'));
const artifact = read('ProvianRestorationAuthorization'), base = read('RecourseOwnerAuthorization');
const names = new Map();
function visit(value) {
  if (Array.isArray(value)) { for (const item of value) visit(item); return; }
  if (!value || typeof value !== 'object') return;
  if (value.nodeType === 'VariableDeclaration' && value.mutability === 'immutable') names.set(String(value.id), value.name);
  for (const item of Object.values(value)) visit(item);
}
if (!artifact.ast || !base.ast) throw Error('executor_template_build_requires_forge_ast');
visit(artifact.ast); visit(base.ast);
for (const [file, metadata] of Object.entries(artifact.metadata.sources)) {
  if (keccak256(toUtf8Bytes(readFileSync(resolve(root, 'contracts', file), 'utf8'))) !== metadata.keccak256) throw Error('executor_template_source_drift');
}
const immutables = {};
for (const [id, slots] of Object.entries(artifact.deployedBytecode.immutableReferences)) {
  const name = names.get(id);
  if (!name || immutables[name]) throw Error('executor_template_immutable_unknown');
  immutables[name] = slots;
}
const expected = ['kernel','restorationRoot','predecessor','lastGoodBlock','cryptographicBreak','pendingBreakAmount',
  'hashAccountCodeHash','hashAccountFactory','previousAuthorization','proofVerifier'].sort();
if (JSON.stringify(Object.keys(immutables).sort()) !== JSON.stringify(expected)) throw Error('executor_template_layout_changed');
const helper = name => {
  const a = read(name);
  if (Object.keys(a.deployedBytecode.immutableReferences ?? {}).length || Object.keys(a.deployedBytecode.linkReferences ?? {}).length) throw Error('executor_template_helper_not_static');
  return keccak256(a.deployedBytecode.object);
};
const output = JSON.stringify({ runtime: artifact.deployedBytecode.object, immutables,
  proofVerifierHash: helper('ProvianOwnerProofVerifier'), hashAccountCodeHash: helper('ProvianHashAccount'),
  hashAccountFactoryHash: helper('ProvianHashAccountFactory') }, null, 2) + '\n';
const target = resolve(root, 'provian-backend/src/core/recourse/restoration-executor-runtime.generated.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw Error('executor_template_generated_drift');
} else writeFileSync(target, output);
console.log('executor runtime template: exact implementation, ten immutable bindings, three helper hashes');
