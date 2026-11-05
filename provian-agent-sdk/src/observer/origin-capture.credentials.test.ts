import {privateIdentifierMac} from './origin-privacy';
/**
 * D-487i — credentials embedded in URLs never leave the device.
 *
 * repo/package arguments are recorded RESOLVABLY (in the clear) under the ruled
 * per-class treatment; a URL-shaped value can carry a token (clone URL userinfo,
 * a git+https dependency, a tarball ?token=). Every RED case below asserts that
 * the credential substring appears NOWHERE in the drafts — neither in an
 * origin_identifier nor anywhere in the serialized output — through every seam
 * that builds a repo/package/url origin: catalog rules, schema-driven
 * classification (the model-proxy lane), and the url class. The GREEN cases pin
 * the clean coordinates byte-identical to the pre-D-487i treatment.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  toolInputOriginDrafts, schemaOriginDrafts, urlDrafts, credentialFreeCoordinate,
  resolvableDraft, privateDraft, packageCoordinateOrigin, npmDependencyOrigin, PRIVATE_PKG, PRIVATE_PROJECT, PRIVATE_URL_PATH,
} from './origin-capture';
import { resolveRepoDependencies } from './plugins/GitPlugin';
import { deriveCodingSessionOrigins } from '../scripts/report-pe';
import { normalizeInputOrigins } from '../input-origins';
import { classifyModelTurn } from './plugins/model-proxy/turn-pe';
import type { ModelTurnObservation, RequestToolSchemas } from './plugins/model-proxy/parse';
import { classifySpanRole, type ParsedOtlpSpan } from './plugins/OTelPlugin';

const TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const REPO_RULE = [{ tools: ['nano-agent'], key: 'source', class: 'repo' as const }];
const PKG_RULE = [{ tools: ['nano-agent'], key: 'dep', class: 'package' as const }];

const repo = (v: string) => toolInputOriginDrafts('nano-agent', { source: v }, REPO_RULE);
const pkg = (v: string) => toolInputOriginDrafts('nano-agent', { dep: v }, PKG_RULE);

/** The credential never appears anywhere in what leaves (identifier OR serialized drafts). */
function expectNoSecret(out: unknown, ...secrets: string[]): void {
  const json = JSON.stringify(out);
  for (const s of secrets) expect(json, `leaked ${s}`).not.toContain(s);
}

describe('repo class — userinfo / query / fragment stripped before the resolvable identifier', () => {
  it('RED — https://x-access-token:<token>@github.com/o/r.git → repo:https://github.com/o/r.git', () => {
    const d = repo(`https://x-access-token:${TOKEN}@github.com/o/r.git`);
    expect(d).toEqual([resolvableDraft('repo:https://github.com/o/r.git')]);
    expectNoSecret(d, TOKEN, 'x-access-token');
  });

  it('RED — git+https://u:t@host/x.git, ssh://, git+ssh:// and scp-style user@host:path', () => {
    expect(repo('git+https://u:t0k3nSecret@git.example.com/x.git')).toEqual([resolvableDraft('repo:git+https://git.example.com/x.git')]);
    expect(repo('ssh://deploy:hunter2@git.example.com/o/r.git')).toEqual([resolvableDraft('repo:ssh://git.example.com/o/r.git')]);
    // A bare `git@` (no password) is the ssh convention, not a credential: unchanged.
    expect(repo('git+ssh://git@github.com/o/r.git')).toEqual([resolvableDraft('repo:git+ssh://git@github.com/o/r.git')]);
    expect(repo('git@github.com:o/r.git')).toEqual([resolvableDraft('repo:git@github.com:o/r.git')]);
    expect(repo(`${TOKEN}@github.com:o/r.git`)).toEqual([resolvableDraft('repo:github.com:o/r.git')]);
    expectNoSecret([
      repo('git+https://u:t0k3nSecret@git.example.com/x.git'),
      repo('ssh://deploy:hunter2@git.example.com/o/r.git'),
      repo(`${TOKEN}@github.com:o/r.git`),
    ], 't0k3nSecret', 'hunter2', TOKEN, 'deploy');
  });

  it('RED — a token that survives the strip (inside the path) → private_project digested over the REDACTED value, never the token', () => {
    const d = repo(`https://github.com/${TOKEN}/r.git`);
    expect(d).toHaveLength(1);
    expect(d[0].origin_identifier).toBe(PRIVATE_PROJECT);
    expect(d[0]).toEqual(privateDraft(PRIVATE_PROJECT, 'https://github.com/[redacted]/r.git'));
    expect(d[0].hash).not.toBe(privateDraft(PRIVATE_PROJECT, `https://github.com/${TOKEN}/r.git`).hash);
    expectNoSecret(d, TOKEN);
  });

  it('GREEN — clean coordinates are byte-identical to the ruled treatment', () => {
    expect(repo('provian/wallet')).toEqual([resolvableDraft('repo:provian/wallet')]);
    expect(repo('provian/wallet@main')).toEqual([resolvableDraft('repo:provian/wallet@main')]);
    expect(repo('https://github.com/o/r.git')).toEqual([resolvableDraft('repo:https://github.com/o/r.git')]);
    expect(repo('0123456789ABCDEF0123456789abcdef01234567')).toEqual([resolvableDraft('commit:0123456789abcdef0123456789abcdef01234567')]);
  });
});

describe('package class — tarball / git dependency credentials', () => {
  it('RED — tarball ?token= → pkg: without the query', () => {
    const d = pkg('https://registry.example.com/x/-/x-1.0.0.tgz?token=s3cr3tT0k');
    expect(d).toEqual([resolvableDraft('pkg:https://registry.example.com/x/-/x-1.0.0.tgz')]);
    expectNoSecret(d, 's3cr3tT0k', 'token=');
  });

  it('RED — name@git+https://user:token@host/x.git#ref spec → the prefix and the git ref kept, the credential gone', () => {
    const d = pkg(`lib@git+https://me:${TOKEN}@github.com/o/lib.git#v1.2.3`);
    expect(d).toEqual([resolvableDraft('pkg:lib@git+https://github.com/o/lib.git#v1.2.3')]);
    expectNoSecret(d, TOKEN, 'me:');
  });

  it('RED — an unparseable URL carrying userinfo → private_pkg digested over the STRIPPED value', () => {
    const raw = 'https://me:pa ss@bad host/x.tgz';
    const d = pkg(raw);
    expect(d).toEqual([privateDraft(PRIVATE_PKG, 'pkg:https://bad host/x.tgz')]);
    expectNoSecret(d, 'pa ss');
  });

  it('GREEN — scp-style package value keeps its `git@` and its `pkg:` prefix byte-identical (strip BEFORE prefix)', () => {
    expect(pkg('git@github.com:o/r.git')).toEqual([resolvableDraft('pkg:git@github.com:o/r.git')]);
  });

  it('RED — scp-style token user: pkg-prefixed, only the token user dropped', () => {
    const d = pkg('tok3nUser@github.com:o/r');
    expect(d).toEqual([resolvableDraft('pkg:github.com:o/r')]);
    expectNoSecret(d, 'tok3nUser');
  });

  it('GREEN — ordinary package coordinates are unchanged', () => {
    expect(pkg('npm:@scope/lib@1.2.3')).toEqual([resolvableDraft('pkg:npm:@scope/lib@1.2.3')]);
    expect(pkg('lib@npm:other@1.0.0')).toEqual([resolvableDraft('pkg:lib@npm:other@1.0.0')]);
    expect(pkg('@scope/lib@1.2.3')).toEqual([resolvableDraft('pkg:@scope/lib@1.2.3')]);
    expect(pkg('pypi:requests==2.31.0')).toEqual([resolvableDraft('pkg:pypi:requests==2.31.0')]);
  });

  it('credentialFreeCoordinate refuses token-shaped strings outright', () => {
    expect(credentialFreeCoordinate(`npm:lib@1.0.0-${TOKEN}`)).toBeNull();
    expect(credentialFreeCoordinate('npm:lib@1.0.0')).toBe('npm:lib@1.0.0');
  });
});

describe('url class — userinfo removed before the path digest', () => {
  it('RED — https://user:pass@host/path hashes the SAME digest as the userinfo-free URL', () => {
    const withCreds = urlDrafts(`https://bot:${TOKEN}@api.example.com/v1/items`);
    const clean = urlDrafts('https://api.example.com/v1/items');
    expect(withCreds).toEqual(clean);
    expect(withCreds[1].origin_identifier).toBe(PRIVATE_URL_PATH);
    expectNoSecret(withCreds, TOKEN, 'bot');
  });
});

describe('every seam that builds these origins is covered', () => {
  it('schema-driven classification (repo_url / package params) strips credentials', () => {
    const d = schemaOriginDrafts({
      repository: `https://oauth2:${TOKEN}@gitlab.example.com/g/p.git`,
      package: 'https://npm.example.com/p.tgz?auth=abc123Secret',
      endpoint_url: `https://svc:${TOKEN}@svc.example.com/a/b`,
    });
    expect(d.map((x) => x.origin_identifier)).toEqual([
      'repo:https://gitlab.example.com/g/p.git',
      'pkg:https://npm.example.com/p.tgz',
      'domain:svc.example.com',
      PRIVATE_URL_PATH,
    ]);
    expectNoSecret(d, TOKEN, 'abc123Secret', 'oauth2', 'svc:');
  });

  it('the model-proxy lane (schema origins on a witnessed turn) never carries the credential', () => {
    const toolSchemas: RequestToolSchemas = new Map([['clone', new Map([['repository', { type: 'string' }]])]]);
    const obs: ModelTurnObservation = {
      provider: 'anthropic', protocol: 'anthropic_messages', model: 'x', responseId: 'r1', streamed: false, recognized: true,
      toolCalls: [{ id: 'toolu_1', name: 'clone', input: { repository: `https://x-access-token:${TOKEN}@github.com/o/r.git` } }],
      tokens: { input: 1, output: 1, total: 2 },
    };
    const res = classifyModelTurn(obs, { witness: null, toolSchemas, windowStart: 1, windowEnd: 2, durationMs: 1 });
    // Non-vacuous: the turn DID carry the repo origin — just without the credential.
    expect(JSON.stringify(res)).toContain('repo:https://github.com/o/r.git');
    expectNoSecret(res, TOKEN, 'x-access-token');
  });

  it('OTel API hosts drop userinfo, including the unparseable-URL fallback and server.address', () => {
    const httpSpan = (attributes: Record<string, unknown>): ParsedOtlpSpan => ({
      traceId: 't', spanId: 's', parentSpanId: '', name: 'GET', startTimeUnixMs: 1, endTimeUnixMs: 2,
      status: 'ok', spanKind: 3, attributes, resourceAttributes: {}, scopeName: null,
    } as ParsedOtlpSpan);
    expect(classifySpanRole(httpSpan({ 'http.request.method': 'GET', 'url.full': `https://u:${TOKEN}@bad host.example/x` })).apiHost)
      .toBe('bad host.example');
    expect(classifySpanRole(httpSpan({ 'http.request.method': 'GET', 'server.address': `u:${TOKEN}@api.example.com` })).apiHost)
      .toBe('api.example.com');
  });
});

// ---------------------------------------------------------------------------
// Manifest dependency coordinates (GitPlugin + report-pe): package.json ranges
// ---------------------------------------------------------------------------
describe('D-487i — package.json dependency ranges never carry a credential off the device', () => {
  const PRIV_RANGE = `git+https://x-access-token:${TOKEN}@github.com/o/r.git`;
  const CLEAN_SSH = 'git+ssh://git@github.com/o/clean.git';
  const sha = (v: string) => `sha256:${createHash('sha256').update(v, 'utf8').digest('hex')}`;

  function tempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd487i-deps-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'r', dependencies: { priv: PRIV_RANGE, clean: CLEAN_SSH, lodash: '^4.17.21' },
    }));
    return dir;
  }

  it('RED — GitPlugin/report-pe composition: the credentialed range → npm:priv@git+https://github.com/o/r.git resolvable, no digest over the token; clean git+ssh unchanged', () => {
    const dir = tempRepo();
    const origins = resolveRepoDependencies(dir).map((d) => npmDependencyOrigin(d.name, d.range, null));
    const ids = origins.map((o) => o.origin_identifier);
    expect(ids).toEqual([
      'npm:priv@git+https://github.com/o/r.git',
      `npm:clean@${CLEAN_SSH}`,
      'npm:lodash@^4.17.21',
    ]);
    expect(origins[0].hash).toBe(sha('npm:priv@git+https://github.com/o/r.git'));
    expect(origins.map((o) => o.hash)).not.toContain(sha(`npm:priv@${PRIV_RANGE}`));
    expectNoSecret(origins, TOKEN, 'x-access-token');
  });

  it('RED — report-pe deriveCodingSessionOrigins (real git repo) carries no credential and no digest over it', () => {
    const dir = tempRepo();
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const head = git('rev-parse', 'HEAD');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const origins = deriveCodingSessionOrigins(head, { deviceKey: 'k', deviceSecret: 's', relayUrl: 'http://x' });
      const ids = origins.map((o) => o.origin_identifier);
      expect(ids).toContain('npm:priv@git+https://github.com/o/r.git');
      expect(ids).toContain(`npm:clean@${CLEAN_SSH}`);
      expect(origins.map((o) => o.hash)).not.toContain(sha(`npm:priv@${PRIV_RANGE}`));
      expectNoSecret(origins, TOKEN, 'x-access-token');
    } finally {
      process.chdir(cwd);
    }
  });

  it('npm ranges: scp `git@` kept, a token scp user dropped, the npm:<name>@ prefix intact', () => {
    expect(npmDependencyOrigin('a', 'git@github.com:o/r.git', null).origin_identifier).toBe('npm:a@git@github.com:o/r.git');
    const t = npmDependencyOrigin('b', 'tok3nUser@github.com:o/r', null);
    expect(t.origin_identifier).toBe('npm:b@github.com:o/r');
    expectNoSecret(t, 'tok3nUser');
    expect(npmDependencyOrigin('c', null, null).origin_identifier).toBe('npm:c');
  });

  it('an unstrippable range → private_pkg over the STRIPPED value', () => {
    const o = packageCoordinateOrigin('npm:x@', `https://host.example/${TOKEN}/x.tgz`, null);
    expect(o.origin_identifier).toBe(PRIVATE_PKG);
    expect(o.hash).toBe('sha256:'+privateIdentifierMac(PRIVATE_PKG,'npm:x@https://host.example/[redacted]/x.tgz'));
  });
});

describe('D-487i — the normalizer backstop agrees with the builders', () => {
  const sha = (v: string) => `sha256:${createHash('sha256').update(v, 'utf8').digest('hex')}`;
  it('RED — an unstripped npm: coordinate → private_pkg, digested over the STRIPPED value (never the token)', () => {
    const raw = `npm:priv@git+https://x-access-token:${TOKEN}@github.com/o/r.git`;
    const [o] = normalizeInputOrigins([{ hash: sha(raw), origin_identifier: raw, witnessed: false }])!;
    expect(o.origin_identifier).toBe('private_pkg');
    expect(o.hash).toBe(sha('npm:priv@git+https://github.com/o/r.git'));
    expect(o.hash).not.toBe(sha(raw));
  });
  it('GREEN — a clean git+ssh://git@ coordinate is NOT misclassified private (same as the builder)', () => {
    const clean = { hash: sha('npm:c@git+ssh://git@github.com/o/r.git'), origin_identifier: 'npm:c@git+ssh://git@github.com/o/r.git', witnessed: false };
    expect(normalizeInputOrigins([clean])).toEqual([clean]);
    expect(npmDependencyOrigin('c', 'git+ssh://git@github.com/o/r.git', null).origin_identifier).toBe(clean.origin_identifier);
  });
});
