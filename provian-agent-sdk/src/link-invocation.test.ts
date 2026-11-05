/**
 * link_spend mints only from an actual spend: the paired tool CALL must
 * be the Link CLI's own spend-request invocation (or its MCP tool), run as one
 * simple command, naming the same id. Every GREEN pairing below has RED siblings
 * that differ only in the property the gate keys on.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenizeSimpleCommand,
  linkInvocationFromArgv,
  linkSpendInvocationFromToolCall,
  pairLinkSpend,
  linkSpendBindingTag,
  LINK_SPEND_BINDING_RE,
} from './link-invocation';
import { recognizeLinkSpendInText } from './link-witness';

const ID = 'lsrq_1AbCdEfGhIjKlMnOpQrStUv';
const OTHER = 'lsrq_9ZyXwVuTsRqPoNmLkJiHgFe';
const RECORD = JSON.stringify({ id: ID, object: 'spend_request', status: 'succeeded', amount: 3500, currency: 'usd', merchant_name: 'Stripe Press' });

const bash = (command: string) => linkSpendInvocationFromToolCall('Bash', { command });

describe('tokenizeSimpleCommand — one simple command or nothing', () => {
  it('splits words and honors quotes', () => {
    expect(tokenizeSimpleCommand(`link-cli spend-request retrieve ${ID} --format json`))
      .toEqual(['link-cli', 'spend-request', 'retrieve', ID, '--format', 'json']);
    expect(tokenizeSimpleCommand(`link-cli spend-request create --context 'a (b); c | d > e' --merchant-name "Stripe Press"`))
      .toEqual(['link-cli', 'spend-request', 'create', '--context', 'a (b); c | d > e', '--merchant-name', 'Stripe Press']);
  });

  it('RED — any composition, redirection, substitution or comment → null', () => {
    for (const cmd of [
      `echo x | link-cli spend-request retrieve ${ID}`,
      `link-cli spend-request retrieve ${ID} | cat`,
      `link-cli spend-request retrieve ${ID}; echo done`,
      `echo ${ID} && link-cli spend-request retrieve ${ID}`,
      `link-cli spend-request retrieve ${ID} || true`,
      `link-cli spend-request retrieve ${ID} > out.json`,
      `link-cli spend-request retrieve ${ID} < in`,
      `link-cli spend-request retrieve $(cat id)`,
      `link-cli spend-request retrieve \`cat id\``,
      `link-cli spend-request retrieve "$ID"`,
      `link-cli spend-request retrieve ${ID} &`,
      `link-cli spend-request retrieve ${ID}\necho '${RECORD}'`,
      `(link-cli spend-request retrieve ${ID})`,
      `link-cli spend-request retrieve ${ID} # c`,
      `link-cli spend-request retrieve 'unterminated`,
      `link-cli spend-request retrieve ${ID} \\`,
    ]) {
      expect(tokenizeSimpleCommand(cmd), cmd).toBeNull();
    }
  });
});

describe('linkInvocationFromArgv / Bash tool calls', () => {
  it('recognizes the Link CLI and its package runners', () => {
    const want = { via: 'link_cli', verb: 'retrieve', expectedId: ID };
    expect(bash(`link-cli spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`link-cli --format json spend-request retrieve ${ID} --interval 2 --max-attempts 300`)).toEqual(want);
    expect(bash(`/usr/local/bin/link-cli spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`NO_UPDATE_NOTIFIER=1 npx -y @stripe/link-cli@0.20.0 spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`pnpm dlx @stripe/link-cli spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`bunx @stripe/link-cli spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`npm exec --yes -- @stripe/link-cli spend-request retrieve ${ID}`)).toEqual(want);
    expect(bash(`link-cli spend-request create --merchant-name "X" --amount 500 --request-approval`))
      .toEqual({ via: 'link_cli', verb: 'create', expectedId: null });
    expect(bash(`link-cli spend-request request-approval ${ID}`)).toEqual({ via: 'link_cli', verb: 'request_approval', expectedId: ID });
    expect(bash(`link-cli mpp pay https://m.example/x --spend-request-id ${ID}`)).toEqual({ via: 'link_cli', verb: 'mpp_pay', expectedId: ID });
    expect(bash(`link-cli mpp pay https://m.example/x --context 'c'`)).toEqual({ via: 'link_cli', verb: 'mpp_pay', expectedId: null });
  });

  it('exactly one trailing `2>&1` is allowed (stderr → stdout cannot inject output); any other redirection still refuses', () => {
    expect(bash(`link-cli spend-request retrieve ${ID} --format json 2>&1`)).toEqual({ via: 'link_cli', verb: 'retrieve', expectedId: ID });
    expect(linkSpendInvocationFromToolCall('shell', { command: ['bash', '-lc', `link-cli spend-request retrieve ${ID} 2>&1`] }))
      .toEqual({ via: 'link_cli', verb: 'retrieve', expectedId: ID });
    for (const cmd of [
      `link-cli spend-request retrieve ${ID} 2>&1 2>&1`,
      `link-cli spend-request retrieve ${ID} 2>/dev/null`,
      `link-cli spend-request retrieve ${ID} 1>&2`,
      `link-cli spend-request retrieve ${ID} >&2`,
      `link-cli spend-request retrieve ${ID} 2>&1 | cat`,
      `link-cli spend-request retrieve ${ID} 2>&1; echo '${RECORD}'`,
      `link-cli spend-request 2>&1 retrieve ${ID}`,
      `link-cli spend-request retrieve ${ID} 2>&1 > out.json`,
      `echo '${RECORD}' 2>&1`,
    ]) {
      expect(bash(cmd), cmd).toBeNull();
    }
  });

  it('RED — not the Link CLI spend-request surface → null', () => {
    for (const cmd of [
      `echo '${RECORD}'`,
      `cat /tmp/spend.json`,
      `printf '%s' '${RECORD}'`,
      `node -e "console.log(1)"`,
      `link-cli auth status`,
      `link-cli spend-request list`,
      `link-cli spend-request retrieve`,             // no id
      `link-cli spend-request retrieve not_an_id`,
      `npx @evil/link-cli spend-request retrieve ${ID}`,
      `link-cli-fake spend-request retrieve ${ID}`,
      `link-cli mpp pay https://m.example --spend-request-id bogus`,
    ]) {
      expect(bash(cmd), cmd).toBeNull();
    }
  });

  it('argv arrays: ["bash","-lc",script] runs the script; a direct argv is taken as-is', () => {
    expect(linkSpendInvocationFromToolCall('shell', { command: ['bash', '-lc', `link-cli spend-request retrieve ${ID}`] }))
      .toEqual({ via: 'link_cli', verb: 'retrieve', expectedId: ID });
    expect(linkSpendInvocationFromToolCall('shell', { command: ['link-cli', 'spend-request', 'retrieve', ID] }))
      .toEqual({ via: 'link_cli', verb: 'retrieve', expectedId: ID });
    // RED: the script composes → null.
    expect(linkSpendInvocationFromToolCall('shell', { command: ['bash', '-lc', `echo '${RECORD}'; link-cli spend-request retrieve ${ID}`] })).toBeNull();
    expect(linkSpendInvocationFromToolCall('shell', { command: ['echo', RECORD] })).toBeNull();
  });

  it('RED — non-shell tools never bind, whatever their arguments say', () => {
    expect(linkSpendInvocationFromToolCall('Read', { file_path: `/tmp/${ID}.json`, command: `link-cli spend-request retrieve ${ID}` })).toBeNull();
    expect(linkSpendInvocationFromToolCall('WebFetch', { url: `https://x/${ID}`, command: `link-cli spend-request retrieve ${ID}` })).toBeNull();
    expect(linkSpendInvocationFromToolCall('Write', { content: RECORD })).toBeNull();
  });

  it('argv helper refuses an empty argv', () => {
    expect(linkInvocationFromArgv([])).toBeNull();
  });
});

describe('Link MCP tool calls', () => {
  it('binds the spend-request MCP tools by (normalized) name, id from the args', () => {
    expect(linkSpendInvocationFromToolCall('mcp__link__spend-request_retrieve', { id: ID }))
      .toEqual({ via: 'link_mcp', verb: 'retrieve', expectedId: ID });
    expect(linkSpendInvocationFromToolCall('mcp__link__spend_request_create', { amount: 500 }))
      .toEqual({ via: 'link_mcp', verb: 'create', expectedId: null });
    expect(linkSpendInvocationFromToolCall('spend-request.request-approval', JSON.stringify({ id: ID })))
      .toEqual({ via: 'link_mcp', verb: 'request_approval', expectedId: ID });
  });
  it('RED — a retrieve with no/garbled id, or an unrelated MCP tool → null', () => {
    expect(linkSpendInvocationFromToolCall('mcp__link__spend_request_retrieve', {})).toBeNull();
    expect(linkSpendInvocationFromToolCall('mcp__link__spend_request_retrieve', { id: 'x' })).toBeNull();
    expect(linkSpendInvocationFromToolCall('mcp__files__read_file', { path: `/tmp/${ID}` })).toBeNull();
    expect(linkSpendInvocationFromToolCall('mcp__link__spend_request_list', {})).toBeNull();
  });
});

describe('pairLinkSpend — the gate', () => {
  const candidate = recognizeLinkSpendInText(RECORD)!;
  it('fixture sanity: the record is a recognizable succeeded candidate', () => {
    expect(candidate).toMatchObject({ link_spend_id: ID, status: 'succeeded' });
  });
  it('GREEN — a retrieve of the same id pairs; a create pairs with its fresh id', () => {
    expect(pairLinkSpend(bash(`link-cli spend-request retrieve ${ID}`), candidate)).toBe(candidate);
    expect(pairLinkSpend(bash(`link-cli spend-request create --amount 1`), candidate)).toBe(candidate);
  });
  it('RED — no invocation, an echo, or a DIFFERENT id → null', () => {
    expect(pairLinkSpend(undefined, candidate)).toBeNull();
    expect(pairLinkSpend(bash(`echo '${RECORD}'`), candidate)).toBeNull();
    expect(pairLinkSpend(bash(`link-cli spend-request retrieve ${OTHER}`), candidate)).toBeNull();
    expect(pairLinkSpend(bash(`link-cli spend-request retrieve ${ID}`), null)).toBeNull();
  });
  it('binding tags match the relay-mirrored shape', () => {
    const inv = bash(`link-cli spend-request retrieve ${ID}`)!;
    expect(linkSpendBindingTag(inv)).toBe('link_cli:retrieve');
    expect(LINK_SPEND_BINDING_RE.test(linkSpendBindingTag(inv))).toBe(true);
    expect(LINK_SPEND_BINDING_RE.test('transcript')).toBe(false);
  });
});
