import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'config/protocol-pointer.json'), 'utf8'));
if (config.chainId !== 8453 || (config.address !== null && !/^0x[0-9a-fA-F]{40}$/.test(config.address))
  || (config.runtimeHash !== null && !/^0x[0-9a-f]{64}$/.test(config.runtimeHash))
  || (config.address === null) !== (config.runtimeHash === null)) throw Error('protocol_pointer_pin_invalid');
if (process.argv.includes('--require-deployed') && !config.address) throw Error('protocol_pointer_not_deployed');
const pin = `// Generated from config/protocol-pointer.json; never a current-contract address fallback.\n`
  + `export const PROTOCOL_POINTER_PIN: Readonly<{ chainId: 8453; address: string | null; runtimeHash: string | null }> = Object.freeze(${JSON.stringify(config)});\n`;
const resolver = readFileSync(resolve(root, 'provian-agent-sdk/src/protocol-pointer.ts'), 'utf8');
const ownerOperation = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-owner-operation.ts'), 'utf8');
const ownerChain = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-owner-chain.ts'), 'utf8')
  .replace("'./protocol-pointer'", "'../protocol/pointer'").replace("'./recourse-owner-operation'", "'./owner-operation'");
const binding = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-binding.ts'), 'utf8');
const bindingChain = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-binding-chain.ts'), 'utf8')
  .replace("'./recourse-binding'", "'./binding'").replace("'./recourse-owner-chain'", "'./owner-chain'");
const transactionGuard = readFileSync(resolve(root, 'provian-agent-sdk/src/protocol-transaction.ts'), 'utf8')
  .replace("'./protocol-pointer'", "'./pointer'").replace("'./recourse-owner-chain'", "'../recourse/owner-chain'")
  .replace("'./hash-account-data'", "'../recourse/hash-account-data'");
const poolChain = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-pool-chain.ts'), 'utf8').replace("'./recourse-owner-chain'", "'./owner-chain'").replace("'./recourse-pool-abi'", "'./pool-abi'").replace("'./protocol-pointer'", "'../protocol/pointer'");
const poolAbi = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-pool-abi.ts'), 'utf8');
const recoveryModules = ['private-access-data', 'private-access', 'break-entitlement', 'break-recovery', 'break-recovery-receipt', 'finalized-receipt', 'hash-account', 'hash-account-data', 'hash-account-chain', 'hash-account-deployment', 'break-deployment-data', 'break-deployment-proof', 'break-restoration-data', 'break-registration-data', 'free-break-recovery'];
const appRecoveryModules = recoveryModules.map(name => [`src/core/recourse/${name}.ts`,
  readFileSync(resolve(root, `provian-agent-sdk/src/${name}.ts`), 'utf8')
    .replaceAll("'./recourse-owner-chain'", "'./owner-chain'")
    .replaceAll("'./recourse-owner-operation'", "'./owner-operation'")
    .replaceAll("'./recourse-hash-authorization'", "'./hash-authorization'")]);
const addressBinding = readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-address-binding.ts'), 'utf8');
const outputs = new Map([
  ['src/core/recourse/membership-client.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-membership-client.ts'), 'utf8')
    .replaceAll("'./recourse-owner-chain'", "'./owner-chain'").replaceAll("'./protocol-pointer'", "'../protocol/pointer'")
    .replaceAll("'./recourse-pool-chain'", "'./pool-chain'").replaceAll("'./recourse-pool-abi'", "'./pool-abi'")
    .replaceAll("'./recourse-membership-authorization'", "'./membership-authorization'")],
  ['provian-backend/src/core/recourse/hash-authorization.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-hash-authorization.ts'), 'utf8')
    .replace("import { hkdf } from '@noble/hashes/hkdf';\nimport { sha256 } from '@noble/hashes/sha256';\nimport { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';",
      "import { hkdf, sha256, bytesToHex, hexToBytes, utf8ToBytes } from './hash-primitives';")],
  ['provian-backend/src/core/recourse/hash-account.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/hash-account.ts'), 'utf8').replace("'./recourse-hash-authorization'", "'./hash-authorization'")],
  ['provian-backend/src/core/recourse/issuance-ticket.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-issuance-ticket.ts'), 'utf8')
    .replace("'./recourse-membership-authorization'", "'./membership-authorization'")],
  ...['src/core/recourse/member-binding.ts', 'provian-backend/src/core/recourse/member-binding.ts'].map(path =>
    [path, readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-member-binding.ts'), 'utf8')
      .replace("'./recourse-binding'", "'./binding'").replace("'./recourse-membership-authorization'", "'./membership-authorization'")]),
  ...['src/core/recourse/membership-authorization.ts', 'provian-backend/src/core/recourse/membership-authorization.ts'].map(path =>
    [path, readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-membership-authorization.ts'), 'utf8')]),
  ['src/core/recourse/address-binding.ts', addressBinding],
  ['provian-backend/src/core/recourse/address-binding.ts', addressBinding],
  ['src/core/recourse/address-credential.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-address-credential.ts'), 'utf8').replace("'./recourse-address-binding'", "'./address-binding'")],
  ...appRecoveryModules,
  ['provian-backend/src/core/recourse/private-access-data.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/private-access-data.ts'), 'utf8')],
  ['provian-backend/src/core/recourse/break-entitlement.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/break-entitlement.ts'), 'utf8')],
  ['provian-backend/src/core/recourse/break-registration-data.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/break-registration-data.ts'), 'utf8')],
  ['provian-backend/src/core/recourse/hash-account-data.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/hash-account-data.ts'), 'utf8')],
  ['provian-backend/src/core/recourse/break-restoration-data.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/break-restoration-data.ts'), 'utf8').replace("'./recourse-owner-operation'", "'./owner-operation'")],
  ['provian-backend/src/core/recourse/break-deployment-data.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/break-deployment-data.ts'), 'utf8')],
  ['src/core/recourse/restoration-exit.ts', readFileSync(resolve(root, 'provian-agent-sdk/src/recourse-restoration-exit.ts'), 'utf8').replace("'./recourse-owner-chain'", "'./owner-chain'").replace("'./recourse-pool-abi'", "'./pool-abi'")],
  ['src/core/recourse/pool-chain.ts', poolChain],
  ['provian-backend/src/core/recourse/pool-chain.ts', poolChain],
  ['src/core/recourse/pool-abi.ts', poolAbi],
  ['provian-backend/src/core/recourse/pool-abi.ts', poolAbi],
  ['provian-mcp/src/core/protocol-pointer.ts', resolver],
  ['provian-mcp/src/core/protocol-pointer-pin.generated.ts', pin],
  ...['guarded-fetch', 'egress-guard', 'pinned-connection', 'pinned-agent'].map(name => [`provian-mcp/src/core/${name}.ts`, readFileSync(resolve(root, `provian-agent-sdk/src/${name}.ts`), 'utf8')]),
  ['src/core/protocol/transaction.ts', transactionGuard],
  ['src/core/recourse/binding-chain.ts', bindingChain],
  ['src/core/recourse/binding.ts', binding],
  ['provian-backend/src/core/recourse/binding.ts', binding],
  ['src/core/recourse/owner-chain.ts', ownerChain],
  ['src/core/recourse/owner-operation.ts', ownerOperation],
  ['provian-backend/src/core/recourse/owner-operation.ts', ownerOperation],
  ['provian-agent-sdk/src/protocol-pointer-pin.generated.ts', pin],
  ['src/core/protocol/pointer-pin.generated.ts', pin],
  ['provian-backend/src/core/protocol/pointer-pin.generated.ts', pin],
  ['src/core/protocol/pointer.ts', resolver],
  ['provian-backend/src/core/protocol/pointer.ts', resolver],
]);
for (const [path, content] of outputs) {
  const target = resolve(root, path);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) throw Error(`protocol_pointer_mirror_drift:${path}`);
  } else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); }
}
console.log(`Protocol pointer: ${outputs.size} mirrors ${process.argv.includes('--check') ? 'verified' : 'written'}`);
