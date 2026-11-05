import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('provian-website/scripts/deploy-site.sh');
const TOKEN = 'fake-purge-token-7c2f9a41';
const OK = '{"success":true,"errors":[]}';
const DENIED = '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}';

const STUBS = {
  // Every call lands in calls.log, which is how the order of the deploy is read back.
  gcloud: `#!/bin/bash
echo "gcloud $*" >> "$STUB_DIR/calls.log"
case "$*" in
  "secrets versions access"*)
    [ -z "$STUB_SECRET_ERROR" ] || { echo "$STUB_SECRET_ERROR" >&2; exit 1; }
    printf '%s' "$STUB_TOKEN"
    ;;
  "run services describe"*) echo provian-site-00001-abc ;;
  "run revisions describe"*) echo sha256:0000 ;;
esac
`,
  // Answers with the next line of responses.txt, repeating the last line once they run out.
  curl: `#!/bin/bash
echo "curl $*" >> "$STUB_DIR/calls.log"
cat >> "$STUB_DIR/curl-stdin.log"
count=$(($(cat "$STUB_DIR/curl-count" 2>/dev/null || echo 0) + 1))
echo "$count" > "$STUB_DIR/curl-count"
line=$(sed -n "\${count}p" "$STUB_DIR/responses.txt")
[ -n "$line" ] || line=$(tail -1 "$STUB_DIR/responses.txt")
printf '%s' "$line"
`,
  op: `#!/bin/bash
echo "op $*" >> "$STUB_DIR/calls.log"
exit 1
`,
  sleep: '#!/bin/bash\nexit 0\n',
};

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function run({ args = [], responses = [OK], secretError = '', token = TOKEN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-site-purge-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'responses.txt'), `${responses.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_DIR: dir,
      STUB_TOKEN: token,
      STUB_SECRET_ERROR: secretError,
    },
  });
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  const curlStdin = fs.existsSync(path.join(dir, 'curl-stdin.log'))
    ? fs.readFileSync(path.join(dir, 'curl-stdin.log'), 'utf8')
    : '';
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, curlStdin };
}

const indexOfCall = (calls, text) => calls.findIndex((call) => call.includes(text));

describe('deploy-site.sh cache purge', () => {
  it('proves it can purge, then builds, deploys and purges everything, in that order', () => {
    const { status, output, calls } = run();

    expect(status).toBe(0);
    expect(output).toContain('Cloudflare cache purged');
    const probe = indexOfCall(calls, '.deploy-purge-check');
    const build = indexOfCall(calls, 'gcloud builds submit');
    const deploy = indexOfCall(calls, 'gcloud run deploy');
    const everything = indexOfCall(calls, 'purge_everything');
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(probe).toBeLessThan(build);
    expect(build).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(everything);
  });

  it('never asks 1Password, which needs a person at the Mac', () => {
    const { calls } = run();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.startsWith('op '))).toEqual([]);
  });

  it('sends the token on stdin, never on a command line or to the output', () => {
    const { output, calls, curlStdin } = run();

    // One exact line for every request, and curl told to read it: curl drops a config line it
    // cannot parse, and ignores its stdin without --config -.
    const curlCalls = calls.filter((call) => call.startsWith('curl'));
    expect(curlCalls.length).toBeGreaterThanOrEqual(2);
    expect(curlCalls.filter((call) => call.includes('--config -'))).toEqual(curlCalls);
    expect(curlStdin.trim().split('\n')).toEqual(
      curlCalls.map(() => `header = "Authorization: Bearer ${TOKEN}"`),
    );
    expect(calls.join('\n')).not.toContain(TOKEN);
    expect(output).not.toContain(TOKEN);
  });

  it('stops before building when the token cannot be read, and shows why', () => {
    const { status, output, calls } = run({ secretError: 'PERMISSION_DENIED: no access to the secret' });

    expect(status).not.toBe(0);
    expect(output).toContain('PERMISSION_DENIED: no access to the secret');
    expect(output).toContain('Nothing was changed');
    expect(indexOfCall(calls, 'gcloud builds submit')).toBe(-1);
    expect(indexOfCall(calls, 'gcloud run deploy')).toBe(-1);
  });

  it('stops before building when the secret is empty', () => {
    const { status, calls } = run({ token: '' });

    expect(status).not.toBe(0);
    expect(indexOfCall(calls, 'gcloud builds submit')).toBe(-1);
  });

  it('stops before building when Cloudflare refuses the token, and shows why', () => {
    const { status, output, calls } = run({ responses: [DENIED] });

    expect(status).not.toBe(0);
    expect(output).toContain('Authentication error');
    expect(indexOfCall(calls, 'gcloud builds submit')).toBe(-1);
  });

  it('stops before building when Cloudflare does not answer with JSON', () => {
    const { status, calls } = run({ responses: ['<html>bad gateway</html>'] });

    expect(status).not.toBe(0);
    expect(indexOfCall(calls, 'gcloud builds submit')).toBe(-1);
  });

  it('retries a failed final purge and succeeds on a later attempt', () => {
    const { status, output, calls } = run({ responses: [OK, DENIED, OK] });

    expect(status).toBe(0);
    expect(output).toContain('Cloudflare cache purged');
    expect(calls.filter((call) => call.includes('purge_everything'))).toHaveLength(2);
  });

  it('exits non-zero when every final purge fails, with the deploy already done', () => {
    const { status, output, calls } = run({ responses: [OK, DENIED] });

    expect(status).not.toBe(0);
    expect(output).toContain('PURGE FAILED after 3 attempts');
    expect(output).not.toContain('Cloudflare cache purged');
    expect(calls.filter((call) => call.includes('purge_everything'))).toHaveLength(3);
    expect(indexOfCall(calls, 'gcloud run deploy')).toBeGreaterThanOrEqual(0);
  });

  it('holds a --review-open deploy to the same check before building', () => {
    const refused = run({ args: ['--review-open'], responses: [DENIED] });

    expect(refused.status).not.toBe(0);
    expect(indexOfCall(refused.calls, 'gcloud builds submit')).toBe(-1);

    const allowed = run({ args: ['--review-open'] });

    expect(allowed.status).toBe(0);
    expect(indexOfCall(allowed.calls, '_REVIEW_OPEN=on')).toBeGreaterThanOrEqual(0);
    expect(indexOfCall(allowed.calls, 'purge_everything')).toBeGreaterThanOrEqual(0);
  });

  it('--purge-only purges everything and builds nothing', () => {
    const { status, calls } = run({ args: ['--purge-only'] });

    expect(status).toBe(0);
    expect(indexOfCall(calls, 'purge_everything')).toBeGreaterThanOrEqual(0);
    expect(indexOfCall(calls, '.deploy-purge-check')).toBe(-1);
    expect(indexOfCall(calls, 'gcloud builds submit')).toBe(-1);
  });

  it('--purge-only exits non-zero when Cloudflare refuses every attempt', () => {
    const { status, output, calls } = run({ args: ['--purge-only'], responses: [DENIED] });

    expect(status).not.toBe(0);
    expect(output).toContain('PURGE FAILED after 3 attempts');
    expect(calls.filter((call) => call.includes('purge_everything'))).toHaveLength(3);
  });

  it('--purge-only fails when the token cannot be read', () => {
    const { status, calls } = run({ args: ['--purge-only'], secretError: 'PERMISSION_DENIED' });

    expect(status).not.toBe(0);
    expect(indexOfCall(calls, 'purge_everything')).toBe(-1);
  });
});
