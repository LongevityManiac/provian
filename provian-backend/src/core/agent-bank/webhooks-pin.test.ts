/**
 * F22 — the webhook DNS pin was dead code: the resolved IP was handed to the
 * global `fetch` as the `agent` option, but Node's fetch is undici and IGNORES
 * `agent` (it takes `dispatcher`), so the custom lookup NEVER ran and the socket
 * re-resolved via the OS resolver at connect time (a live DNS-rebinding TOCTOU
 * behind a comment claiming it was pinned). The fix switches delivery to
 * `https.request`, which DOES honour an https.Agent's `lookup`.
 *
 * This is the RED control for the exact defect: it proves that `https.request`
 * consults the agent lookup (so the connection goes to the pre-validated,
 * PINNED address) while the old `fetch(..., { agent })` shape does NOT — i.e. a
 * resolver that flips public→private between validate and connect can only be
 * defeated by the mechanism the fix now uses.
 */
import { describe, it, expect } from '@jest/globals';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import type { LookupFunction } from 'net';

// TEST-NET-3 (203.0.113.0/24) — routable-looking but guaranteed unreachable, so
// the connection attempt fails fast after the lookup has already fired.
const PINNED_IP = '203.0.113.5';

function makeAgentWithSpyLookup(): { agent: HttpsAgent; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFunction = (hostname, _options, callback) => {
    calls.push(String(hostname));
    // Hand back ONLY the pinned address — never a re-resolution.
    callback(null, PINNED_IP, 4);
  };
  return { agent: new HttpsAgent({ lookup }), calls };
}

describe('webhook DNS pin mechanism (F22)', () => {
  it('https.request CONSULTS the agent lookup — the connection is pinned', async () => {
    const { agent, calls } = makeAgentWithSpyLookup();
    await new Promise<void>((resolve) => {
      const req = httpsRequest('https://rebind.attacker.example/hook', { method: 'POST', agent, timeout: 400 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.on('error', () => resolve());
      req.end('{}');
    });
    agent.destroy();
    // The lookup fired with the target hostname → the pin is actually applied.
    expect(calls).toContain('rebind.attacker.example');
  }, 10000);

  it('RED: the OLD shape — passing the agent to global fetch — NEVER consults the lookup', async () => {
    const { agent, calls } = makeAgentWithSpyLookup();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    try {
      await fetch('https://rebind.attacker.example/hook', {
        method: 'POST',
        signal: controller.signal,
        // The exact (dead) option the vulnerable code passed. undici ignores it.
        ...( { agent } as Record<string, unknown> ),
      } as RequestInit);
    } catch {
      // Connection/abort error is expected; we only care whether the lookup ran.
    } finally {
      clearTimeout(timer);
      agent.destroy();
    }
    // undici never called the agent's lookup → the old "pin" was dead code.
    expect(calls).toHaveLength(0);
  }, 10000);
});
