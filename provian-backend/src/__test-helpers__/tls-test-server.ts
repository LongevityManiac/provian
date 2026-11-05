/**
 * Test-only TLS plumbing : a throwaway self-signed certificate minted by the
 * `openssl` CLI at test time (no key material is committed), plus an https.Agent
 * that reaches a local 127.0.0.1 server while the code under test still runs its
 * full SSRF validation against a PUBLIC address. Never imported by production code.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent as HttpsAgent } from 'https';
import { pinnedLookup } from '../core/net/pinned-lookup';

export interface TestCert {
  readonly key: string;
  readonly cert: string;
}

/** A 1-day self-signed P-256 certificate whose SANs are `hostnames`. */
export function makeSelfSignedCert(hostnames: string[]): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'provian-tls-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', `/CN=${hostnames[0]}`,
      '-addext', `subjectAltName=${hostnames.map((h) => `DNS:${h}`).join(',')}`,
    ], { stdio: 'pipe' });
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An https.Agent that trusts `cert` and dials 127.0.0.1 whatever the hostname — the
 * test stand-in for the production pinned agent (which dials the validated IP).
 */
export function loopbackAgent(cert: TestCert): HttpsAgent {
  return new HttpsAgent({ lookup: pinnedLookup('127.0.0.1'), ca: cert.cert });
}
