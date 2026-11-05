/**
 * loopback-probe — is something listening on a loopback port yet? (D)
 *
 * The installer writes the model base-URL block (ANTHROPIC_/OPENAI_/XAI_/
 * GOOGLE_GEMINI_BASE_URL → http://127.0.0.1:4320/…) only once the daemon's
 * model shim actually accepts a connection, so installing Provian can never
 * leave a harness pointed at a dead port. A plain TCP connect: no request is
 * sent, nothing is proxied (a raw socket never consults HTTP(S)_PROXY).
 */
import * as net from 'net';

export function probeLoopbackPort(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function waitForLoopbackPort(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; host?: string; probe?: (port: number) => Promise<boolean> } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const probe = opts.probe ?? ((p: number) => probeLoopbackPort(p, opts.host));
  for (;;) {
    if (await probe(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
}
