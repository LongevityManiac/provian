/**
 * Cross-language parity oracle for the Python SDK's device module.
 *
 * Runs the REAL TypeScript functions (never a copy): the relay's canonical JSON
 * (`provian-backend/src/core/hardware/binding.ts` canonicalJson — the same bytes as
 * `ProvianClient.stableStringify` and the device-auth canonicalizer) and the relay's
 * body-HMAC recomputation (node crypto, exactly as `routes/devices.ts` does it).
 *
 * stdin: {"canonical": [value...], "hmac": [{secret, body}]}
 * stdout: the same keys, answered by the TS implementations.
 *
 * Run from provian-backend (tsx lives there):
 *   npx tsx ../provian-python-sdk/tests/parity/ts_vectors.ts < input.json
 */
import crypto from 'crypto';
import { canonicalJson } from '../../../provian-backend/src/core/hardware/binding';

interface Input {
  canonical?: unknown[];
  hmac?: Array<{ secret: string; body: string }>;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw) as Input;
  const out = {
    canonical: (input.canonical ?? []).map((v) => canonicalJson(v)),
    hmac: (input.hmac ?? []).map((h) => crypto.createHmac('sha256', h.secret).update(h.body).digest('hex')),
  };
  process.stdout.write(JSON.stringify(out));
});
