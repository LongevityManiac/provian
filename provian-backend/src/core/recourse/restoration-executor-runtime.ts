import { keccak256 } from 'ethers';
import template from './restoration-executor-runtime.generated.json';

export interface RestorationExecutorRuntimePort {
  code(account: string, pin: string): Promise<string>;
  kernelExecutor(kernel: string, pin: string): Promise<string>;
}
type ImmutableName = keyof typeof template.immutables;
const zero = `0x${'0'.repeat(40)}`;
function account(word: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) throw Error('recourse_executor_immutable_invalid');
  return `0x${word.slice(26)}`;
}
/** Every executable byte must match the reviewed implementation. Immutable
 * values are extracted from compiler AST-labelled positions, checked equal at
 * every repeated site, and then checked as dependencies rather than ignored. */
export function decodeRestorationExecutorRuntime(runtime: string): Readonly<Record<ImmutableName, string>> {
  if (!/^0x[0-9a-f]+$/.test(runtime) || runtime.length !== template.runtime.length) throw Error('recourse_executor_runtime_mismatch');
  let masked = runtime;
  const values = {} as Record<ImmutableName, string>;
  for (const name of Object.keys(template.immutables) as ImmutableName[]) {
    for (const { start, length } of template.immutables[name]) {
      const offset = 2 + start * 2, word = `0x${runtime.slice(offset, offset + 64)}`;
      if (length !== 32 || template.runtime.slice(offset, offset + 64) !== '0'.repeat(64)
        || values[name] !== undefined && values[name] !== word) throw Error('recourse_executor_immutable_inconsistent');
      values[name] = word; masked = masked.slice(0, offset) + '0'.repeat(64) + masked.slice(offset + 64);
    }
  }
  if (masked !== template.runtime) throw Error('recourse_executor_runtime_mismatch');
  return values;
}
/** A kernel can accept an external executor, so getter equality is insufficient.
 * Authenticate code, its private proof-verifier address, account/factory rules,
 * and every inherited authorization dependency at one canonical block hash. */
export async function authenticateRestorationExecutor(executor: string, kernel: string, pin: string,
  port: RestorationExecutorRuntimePort): Promise<void> {
  if (executor === zero || !/^0x[0-9a-f]{64}$/.test(pin)) throw Error('recourse_executor_dependency_invalid');
  const seen = new Set<string>();
  while (executor !== zero) {
    if (!/^0x[0-9a-f]{40}$/.test(executor) || !/^0x[0-9a-f]{40}$/.test(kernel) || kernel === zero
      || seen.has(executor)) throw Error('recourse_executor_dependency_invalid');
    seen.add(executor);
    if ((await port.kernelExecutor(kernel, pin)).toLowerCase() !== executor) throw Error('recourse_executor_binding_invalid');
    const words = decodeRestorationExecutorRuntime((await port.code(executor, pin)).toLowerCase());
    const proof = account(words.proofVerifier), factory = account(words.hashAccountFactory);
    const afterBreak = BigInt(words.cryptographicBreak);
    if (account(words.kernel) !== kernel || proof === zero || afterBreak > 1n
      || words.hashAccountCodeHash !== template.hashAccountCodeHash || BigInt(words.lastGoodBlock) === 0n
      || /^0x0+$/.test(words.restorationRoot) || account(words.predecessor) === zero
      || afterBreak === 1n && (account(words.previousAuthorization) !== zero || BigInt(words.pendingBreakAmount) !== 0n)
      || (afterBreak === 1n ? factory === zero : factory !== zero)) throw Error('recourse_executor_binding_invalid');
    if (keccak256(await port.code(proof, pin)) !== template.proofVerifierHash) throw Error('recourse_executor_proof_runtime_mismatch');
    if (factory !== zero && keccak256(await port.code(factory, pin)) !== template.hashAccountFactoryHash) throw Error('recourse_executor_factory_runtime_mismatch');
    kernel = account(words.predecessor); executor = account(words.previousAuthorization);
  }
}
