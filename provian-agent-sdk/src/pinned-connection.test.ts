import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { pinnedConnector } from './pinned-connection';
import { validateEgressTarget } from './egress-guard';

// The synthetic proxy's loopback listener stands in for the operator's proxy host; its name is
// resolved through the connector's own resolver seam (never the target guard).
const fixtureResolver = async (hostname: string) => (hostname === 'proxy.fixture' ? ['127.0.0.1'] : []);
afterEach(() => vi.unstubAllEnvs());

describe('pinned forward proxy', () => {
  it('CONNECT uses the approved target IP, and the proxy socket uses its own approved lookup', async () => {
    const tunnels: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => { tunnels.push(request.url!); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as import('node:net').AddressInfo).port;
    vi.stubEnv('HTTPS_PROXY', `http://proxy.fixture:${port}`); vi.stubEnv('https_proxy', '');
    // Empty lowercase settings should not mask a populated uppercase setting.
    vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', '');
    try {
      const connector = await pinnedConnector(new URL('https://seller.example/'), ['93.184.216.34'], fixtureResolver);
      await expect(new Promise((resolve, reject) => connector({ hostname: 'seller.example', protocol: 'https:', port: '443' }, (error, socket) => error ? reject(error) : resolve(socket)))).rejects.toThrow('tunnel refused');
      expect(tunnels).toEqual(['93.184.216.34:443']);
      // RED control: the old hostname CONNECT would let a proxy re-resolve the destination.
      expect(tunnels).not.toContain('seller.example:443');
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });

  it("a local-network proxy is the operator's own hop and is accepted; failed proxy DNS is still refused; the TARGET guard still refuses private hosts", async () => {
    vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', ''); vi.stubEnv('https_proxy', '');
    // RED control (2026-10-17): the target guard used to run on the proxy too, refusing every
    // RFC 1918 / loopback proxy — i.e. the corporate egress proxy itself.
    for (const proxy of ['http://127.0.0.1:8080', 'http://10.0.0.1:3128', 'http://[::1]:3128']) {
      vi.stubEnv('HTTPS_PROXY', proxy);
      await expect(pinnedConnector(new URL('https://seller.example/'), ['93.184.216.34'])).resolves.toBeTypeOf('function');
    }
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.internal:3128');
    await expect(pinnedConnector(new URL('https://seller.example/'), ['93.184.216.34'], async () => ['10.1.2.3'])).resolves.toBeTypeOf('function');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    await expect(pinnedConnector(new URL('https://seller.example/'), ['93.184.216.34'], async () => [])).rejects.toThrow('proxy refused');
    vi.stubEnv('HTTPS_PROXY', 'socks5://proxy.example:1080');
    await expect(pinnedConnector(new URL('https://seller.example/'), ['93.184.216.34'], fixtureResolver)).rejects.toThrow('protocol refused');
    expect((await validateEgressTarget('https://127.0.0.1/')).ok).toBe(false);
  });
});
