import { expect, test } from 'vitest';
import { isolatedCopyPort } from './copy-port.mjs';
const hash = '0x' + '11'.repeat(32), other = '0x' + '22'.repeat(32);
test.each(['https://base-rpc.publicnode.com', 'http://localhost:18547', 'http://127.0.0.1:18547/relay',
  'http://user@127.0.0.1:18547', 'http://127.0.0.1:18547/?url=https://base.org'])('non-exact local transport refuses %s', url => {
  expect(() => isolatedCopyPort({ url, instanceId: hash, forkHash: hash })).toThrow();
});
test('every mutation rechecks instance and fork even on the matching Base chain ID', async () => {
  const methods = []; let instance = hash, fork = hash;
  const port = isolatedCopyPort({ url: 'http://127.0.0.1:18547', instanceId: hash, forkHash: hash, fetcher: async (_url, input) => {
    const { method } = JSON.parse(input.body); methods.push(method); expect(input.redirect).toBe('error');
    return { ok: true, json: async () => ({ result: method === 'anvil_metadata'
      ? { instanceId: instance, chainId: 8453, forkedNetwork: { chainId: 8453, forkBlockHash: fork } }
      : method === 'eth_chainId' ? '0x2105' : hash }) };
  } });
  await port.request('eth_sendTransaction', [{}]); expect(methods).toEqual(['anvil_metadata', 'eth_chainId', 'eth_sendTransaction']);
  instance = other; await expect(port.request('eth_sendTransaction', [{}])).rejects.toThrow(/instance_changed/);
  instance = hash; fork = other; await expect(port.request('eth_sendRawTransaction', ['0x'])).rejects.toThrow(/instance_changed/);
  expect(methods.filter(method => method.startsWith('eth_send'))).toHaveLength(1);
  await expect(port.request('anvil_setCode', [])).rejects.toThrow(/method_refused/);
});
test('only an explicit rate-limit response is marked retryable and no RPC details leak', async () => {
  let message = 'upstream 429 rate limit https://private.invalid/key';
  const port = isolatedCopyPort({ url: 'http://127.0.0.1:18547', instanceId: hash, forkHash: hash,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32000, message } }) }) });
  await expect(port.request('eth_call', [])).rejects.toMatchObject({ message: 'copy_port_rate_limit',
    copyDiagnostic: { method: 'eth_call', httpStatus: 200, rpcCode: -32000 } });
  message = 'execution reverted'; await expect(port.request('eth_call', [])).rejects.toThrow('copy_port_rpc_refused');
});
