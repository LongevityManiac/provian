/**
 * review 2 — ONE harness tool-name vocabulary, carried byte-identical by the
 * relay (`mcp/core`, imported by the self-report reduction and the hosted MCP
 * tools) and the stdio MCP package. (removed the SDK copy with the local
 * witness endpoint that read it.)
 *
 * A self-reported tool name is sealed verbatim only when it is a harness tool
 * name; any other name seals as `h:` + the first 12 hex of sha256(name). If the
 * copies drifted, the hosted and stdio MCP would seal the same name two ways.
 *
 * RED controls (in-suite): a planted one-byte divergence is detected; a
 * sentence-shaped name never survives as text.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { HARNESS_APP_NAMES, HARNESS_TOOL_NAMES, sealedSourceApp, sealedToolName } from '../../mcp/core/harness-tool-vocabulary';

// provian-backend/src/core/provenance/ → repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const COPIES = [
  'provian-backend/src/mcp/core/harness-tool-vocabulary.ts',
  'provian-mcp/src/core/harness-tool-vocabulary.ts',
].map((rel) => path.join(REPO_ROOT, rel));

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('harness tool-name vocabulary — one list, two byte-identical copies', () => {
  it('every copy exists and is byte-identical', () => {
    const bufs = COPIES.map((f) => {
      expect(fs.existsSync(f)).toBe(true); // no silent skip
      return fs.readFileSync(f);
    });
    expect(bufs).toHaveLength(2); // evaluated-population guard
    expect(new Set(bufs.map(sha)).size).toBe(1);
    // RED control: a planted divergence is caught by the same comparison.
    const planted = Buffer.concat([bufs[1], Buffer.from('\n// drift\n')]);
    expect(new Set([sha(bufs[0]), sha(planted)]).size).toBe(2);
  });

  it('seals harness names verbatim, anything else as h:<12 hex>, and never lets prose through', () => {
    expect(HARNESS_TOOL_NAMES.length).toBeGreaterThan(20);
    for (const n of ['Read', 'Bash', 'WebFetch', 'read_file', 'run_terminal_command', 'exec', 'apply_patch']) {
      expect(HARNESS_TOOL_NAMES).toContain(n);
      expect(sealedToolName(n)).toBe(n);
    }
    const prose = 'refactored billing module for Acme Corp';
    const hashed = sealedToolName(prose);
    expect(hashed).toBe('h:' + crypto.createHash('sha256').update(prose, 'utf8').digest('hex').slice(0, 12));
    // RED control: the old token-shaping would have kept the words.
    expect(hashed).not.toMatch(/Acme|billing|refactored/);
    expect(sealedToolName('refactored_billing_module_for_Acme_Corp')).toMatch(/^h:[0-9a-f]{12}$/);
    expect(sealedToolName(hashed)).toBe(hashed); // an already-hashed token is stable
    expect(sealedToolName('')).toBeNull();
    expect(sealedToolName(42)).toBeNull();
  });

  it('seals a source_app from the app vocabulary verbatim, anything else as h:<12 hex> (review 3)', () => {
    expect(HARNESS_APP_NAMES.length).toBeGreaterThan(10);
    for (const n of ['grok', 'claude-code', 'openclaw', 'codex', 'chatgpt', 'local_process']) {
      expect(HARNESS_APP_NAMES).toContain(n);
      expect(sealedSourceApp(n)).toBe(n);
    }
    expect(sealedSourceApp('Grok')).toBe('grok'); // lowercase slug of a vocabulary name
    const prose = 'refactored billing for acme';
    const hashed = sealedSourceApp(prose);
    expect(hashed).toBe('h:' + crypto.createHash('sha256').update('refactored_billing_for_acme', 'utf8').digest('hex').slice(0, 12));
    // RED control: the old slugging kept the words.
    expect(hashed).not.toMatch(/billing|acme|refactored/);
    expect(sealedSourceApp('refactored_billing_for_acme')).toBe(hashed);
    expect(sealedSourceApp(hashed)).toBe(hashed);
    expect(sealedSourceApp('')).toBe('local_process');
    expect(sealedSourceApp(undefined)).toBe('local_process');
  });
});
