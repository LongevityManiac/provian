import { test, expect } from 'vitest';
import { isolatedExercisePort } from './exercise-port.mjs';

test('mutations require the isolated chain and local simulator identity every time', async () => {
  let chain = '0x7a69', client = 'anvil/v1', instanceId = 'first', sent = 0;
  const port = isolatedExercisePort({ async send(method) {
    if (method === 'eth_chainId') return chain;
    if (method === 'web3_clientVersion') return client;
    if (method === 'anvil_metadata') return { instanceId };
    ++sent; return 'ok';
  } });
  expect(await port.mutate('evm_mine', [])).toBe('ok'); expect(sent).toBe(1);
  chain = '0x2105';
  await expect(port.mutate('eth_sendTransaction', [{}])).rejects.toThrow('isolation_required'); expect(sent).toBe(1);
  chain = '0x7a69'; client = 'production';
  await expect(port.mutate('anvil_impersonateAccount', ['0x0'])).rejects.toThrow('isolation_required'); expect(sent).toBe(1);
  client = 'anvil/v1';
  await expect(port.mutate('eth_sendRawTransaction', ['0x'])).rejects.toThrow('method_refused'); expect(sent).toBe(1);
  instanceId = 'restarted';
  await expect(port.mutate('eth_sendTransaction', [{}])).rejects.toThrow('instance_changed'); expect(sent).toBe(1);
  instanceId = '';
  await expect(port.mutate('evm_mine', [])).rejects.toThrow('instance_required'); expect(sent).toBe(1);
});
