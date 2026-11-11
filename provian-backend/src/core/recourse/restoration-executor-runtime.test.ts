import { readFileSync } from 'fs';
import { resolve } from 'path';
import { zeroPadValue, toBeHex } from 'ethers';
import template from './restoration-executor-runtime.generated.json';
import { authenticateRestorationExecutor, decodeRestorationExecutorRuntime, type RestorationExecutorRuntimePort } from './restoration-executor-runtime';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const word = (value: string | number) => zeroPadValue(typeof value === 'number' ? toBeHex(value) : value, 32);
type Name = keyof typeof template.immutables;
function runtime(overrides: Partial<Record<Name, string>> = {}): string {
  const values: Record<Name, string> = { kernel: word(a(1)), predecessor: word(a(10)), lastGoodBlock: word(100),
    cryptographicBreak: word(1), pendingBreakAmount: word(0), restorationRoot: h(20), hashAccountCodeHash: template.hashAccountCodeHash,
    hashAccountFactory: word(a(4)), previousAuthorization: word(a(0)), proofVerifier: word(a(3)), ...overrides };
  let output = template.runtime;
  for (const name of Object.keys(template.immutables) as Name[]) for (const slot of template.immutables[name]) {
    const offset = 2 + slot.start * 2; output = output.slice(0, offset) + values[name].slice(2) + output.slice(offset + 64);
  }
  return output;
}
function compiled(name: string): string {
  const artifact = JSON.parse(readFileSync(resolve(__dirname, `../../../../contracts/out/${name}.sol/${name}.json`), 'utf8')) as { deployedBytecode: { object: string } };
  return artifact.deployedBytecode.object;
}
function fixture() {
  const codes = new Map([[a(2), runtime()], [a(3), compiled('ProvianOwnerProofVerifier')], [a(4), compiled('ProvianHashAccountFactory')]]);
  const port: RestorationExecutorRuntimePort = { code: jest.fn(async (account, pin) => {
    if (pin !== h(30)) throw Error('not pinned'); return codes.get(account) ?? '0x';
  }), kernelExecutor: jest.fn(async () => a(2)) };
  return { codes, port };
}
test('compiled runtime and actual proof/factory helpers authenticate with repeated immutable sites', async () => {
  expect(template.runtime).toBe(compiled('ProvianRestorationAuthorization'));
  const { port } = fixture(); await authenticateRestorationExecutor(a(2), a(1), h(30), port);
  expect(port.code).toHaveBeenCalledWith(a(3), h(30)); expect(port.code).toHaveBeenCalledWith(a(4), h(30));
});
test.each(['opcode', 'short', 'inconsistent-immutable'])('%s implementation fails before its getters can be trusted', mode => {
  let code = runtime();
  if (mode === 'opcode') code = `0x00${code.slice(4)}`;
  if (mode === 'short') code = code.slice(0, -2);
  if (mode === 'inconsistent-immutable') { const offset = 2 + template.immutables.kernel[0].start * 2; code = code.slice(0, offset) + word(a(99)).slice(2) + code.slice(offset + 64); }
  expect(() => decodeRestorationExecutorRuntime(code)).toThrow();
});
test.each(['private-verifier', 'factory', 'wrong-kernel', 'wrong-account-code', 'fake-break-mode', 'break-inherits', 'ordinary-factory'])('%s substitution refuses', async mode => {
  const { codes, port } = fixture();
  if (mode === 'private-verifier') codes.set(a(3), '0x60006000f3');
  if (mode === 'factory') codes.set(a(4), '0x60006000f3');
  if (mode === 'wrong-kernel') codes.set(a(2), runtime({ kernel: word(a(99)) }));
  if (mode === 'wrong-account-code') codes.set(a(2), runtime({ hashAccountCodeHash: h(99) }));
  if (mode === 'fake-break-mode') codes.set(a(2), runtime({ cryptographicBreak: word(2) }));
  if (mode === 'break-inherits') codes.set(a(2), runtime({ previousAuthorization: word(a(9)) }));
  if (mode === 'ordinary-factory') codes.set(a(2), runtime({ cryptographicBreak: word(0) }));
  await expect(authenticateRestorationExecutor(a(2), a(1), h(30), port)).rejects.toThrow();
});
test('ordinary inheritance authenticates the prior executor instead of trusting getter-shaped state', async () => {
  const { codes, port } = fixture();
  codes.set(a(2), runtime({ cryptographicBreak: word(0), hashAccountFactory: word(a(0)), previousAuthorization: word(a(12)) }));
  codes.set(a(12), runtime({ kernel: word(a(10)), predecessor: word(a(20)) }));
  port.kernelExecutor = async kernel => kernel === a(1) ? a(2) : a(12);
  await authenticateRestorationExecutor(a(2), a(1), h(30), port);
  codes.set(a(12), '0x60006000f3');
  await expect(authenticateRestorationExecutor(a(2), a(1), h(30), port)).rejects.toThrow(/runtime_mismatch/);
});
