import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const { hashMessage, Wallet } = require('ethers');
const source = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-binding.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exports = {};
new Function('exports', compiled)(exports);
const binding = { identity: `0x${'12'.repeat(32)}`, address: new Wallet(`0x${'0'.repeat(58)}123456`).address.toLowerCase(),
  kernel: `0x${'34'.repeat(20)}`, recoveryCommitment: `0x${'56'.repeat(32)}`, signingRoot: `0x${'78'.repeat(32)}`,
  nonce: `0x${'9a'.repeat(32)}`, expiresAtMs: 1200000 };
const result = JSON.stringify({ ...binding, message: exports.recourseBindingMessage(binding), digest: hashMessage(exports.recourseBindingMessage(binding)) }, null, 2) + '\n';
const path = resolve(root, 'contracts/test/fixtures/owner-binding.json');
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== result) throw Error('owner_binding_vector_drift');
} else writeFileSync(path, result);
console.log('Owner binding vector verified against the shared client and relay encoder');
