/**
 * Why an install stopped, in words a person can act on.
 *
 * The installer used to answer every failure with "check your internet connection" on a
 * proxy-only box whose connection was fine (the egress guard had refused for want of local
 * DNS), and on purely local faults. The rule now : print the actual reason
 * it stopped, and never a connection message when the connection worked.
 *
 * Output is built from the error's codes and the relay's own `error` text — never a stack — and
 * anything shaped like a connection code or a long hex secret is masked.
 */

import { proxyUrlOf } from './pinned-connection';

export type SetupFailureKind =
  | 'egress_dns'      // no address for the relay (local DNS and, behind a proxy, DNS-over-HTTPS)
  | 'egress_blocked'  // the relay's name resolved to an address the guard refuses
  | 'dns'             // a lookup failed below the guard
  | 'tls'             // reached it, but the certificate was not trusted
  | 'proxy'           // the forward proxy refused or dropped the tunnel
  | 'connect'         // no connection to the relay
  | 'relay_http'      // the relay answered, with an error status
  | 'local';          // this machine stopped before or after the network

export interface SetupFailure {
  kind: SetupFailureKind;
  /** True only when the network path itself failed (so connection advice applies). */
  connection: boolean;
  /** The codes found on the error and its causes, outermost first. */
  codes: string[];
  lines: string[];
}

export interface SetupFailureContext {
  /** The relay host, for messages (e.g. `api.provian.ai`). */
  relayHost: string;
  /** The forward proxy in effect, if any (credentials are never printed). */
  proxy?: string;
  /** The proxy variable in effect for the relay (`https_proxy` wins over `HTTPS_PROXY`). */
  proxyVar?: string;
  /** What the person does to try again (`paste the command again`, `run onboard again`). */
  retry: string;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
]);
const TLS_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED', 'CERT_REJECTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE',
]);

/** Mask connection codes and long hex runs (keys, secrets, registration ids). */
export function maskSecrets(text: string): string {
  return text
    .replace(/PROV-[A-Z0-9]{4}-[A-Z0-9]{4}/gi, 'PROV-****-****')
    .replace(/\b(?:0x)?[0-9a-f]{32,}\b/gi, '[hidden]');
}

function proxyHost(proxy: string | undefined): string | undefined {
  if (!proxy) return undefined;
  return proxyUrlOf(proxy)?.host ?? 'your proxy';
}

/** The error and its causes (incl. AggregateError members), outermost first, bounded. */
function chain(error: unknown): Array<{ code?: string; message: string; name?: string }> {
  const out: Array<{ code?: string; message: string; name?: string }> = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length && out.length < 12) {
    const e = queue.shift();
    if (e === null || e === undefined || seen.has(e)) continue;
    seen.add(e);
    if (typeof e === 'object') {
      const rec = e as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
      out.push({
        ...(typeof rec.code === 'string' ? { code: rec.code } : {}),
        message: typeof rec.message === 'string' ? rec.message : String(e),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
      });
      if (rec.cause !== undefined) queue.push(rec.cause);
      if (Array.isArray(rec.errors)) queue.push(...rec.errors);
    } else {
      out.push({ message: String(e) });
    }
  }
  return out;
}

export function describeSetupFailure(error: unknown, ctx: SetupFailureContext): SetupFailure {
  const links = chain(error);
  const codes = links.map(l => l.code).filter((c): c is string => typeof c === 'string');
  const has = (set: Set<string>) => codes.find(c => set.has(c));
  const msgHas = (needle: string) => links.find(l => l.message.includes(needle));
  const host = ctx.relayHost;
  const via = proxyHost(ctx.proxy);
  const detail = (code: string | undefined, message: string) =>
    `  Reason: ${code ? `${code} — ` : ''}${maskSecrets(message)}`;
  const top = links[0] ?? { message: String(error) };

  const egress = codes.find(c => c.startsWith('EGRESS_'));
  if (egress === 'EGRESS_DNS_FAILED') {
    // The guard's reason says which lookups ran (egressResolver), so the advice matches what
    // happened: DNS-over-HTTPS is only named when it was actually tried.
    const reason = links.find(l => l.code === egress)?.message ?? top.message;
    const triedDoh = /DNS-over-HTTPS lookup/.test(reason) && !/no DNS-over-HTTPS lookup was tried/.test(reason);
    const gateway = /gateway stand-in/.test(reason);
    const excludedBy = /\b(no_proxy|NO_PROXY) sends this host direct/.exec(reason)?.[1];
    const excluded = excludedBy !== undefined;
    const badProxyVar = /proxy setting \((\w+)\) is not an http:\/\/ or https:\/\/ proxy/.exec(reason)?.[1];
    const badProxy = badProxyVar !== undefined;
    const lines = [`  Provian setup stopped: this machine could not get a real address for ${host} that Provian can check.`];
    if (badProxy) {
      lines.push(`  ${gateway ? "Its DNS answered only with a network gateway's stand-in address (in 198.18.0.0/15)" : 'Its DNS gave no answer'}, and the proxy setting (${badProxyVar}) is not an http:// or https:// proxy, so it could not be used.`);
    } else if (gateway) {
      lines.push("  Its DNS answered only with a network gateway's stand-in address (in 198.18.0.0/15), and the DNS-over-HTTPS lookup (1.1.1.1, 8.8.8.8) got no answer.");
    } else if (triedDoh) {
      lines.push(`  Its own DNS gave no answer, and the DNS-over-HTTPS lookup through your proxy${via ? ` (${via})` : ''} got no answer either.`);
    } else if (excluded) {
      lines.push(`  Its DNS gave no answer, and a proxy is set but ${excludedBy} sends ${host} direct, so the proxy is not used for it.`);
    } else {
      lines.push('  Its DNS gave no answer, and no forward proxy is set (HTTPS_PROXY) to reach it another way.');
    }
    lines.push(detail(egress, reason));
    lines.push(triedDoh
      ? `  Ask your human to allow 1.1.1.1 and 8.8.8.8 alongside ${host}, then ${ctx.retry}.`
      : badProxy
        ? `  Set ${badProxyVar} to the proxy as http://host:port, then ${ctx.retry}.`
        : excluded
        ? `  Take ${host} out of ${excludedBy} (or fix this machine's DNS), then ${ctx.retry}.`
        : `  Fix this machine's DNS, or if it reaches the internet only through a proxy, set HTTPS_PROXY to it; then ${ctx.retry}.`);
    return { kind: 'egress_dns', connection: true, codes, lines };
  }
  if (egress === 'EGRESS_SSRF_BLOCKED') {
    return {
      kind: 'egress_blocked', connection: true, codes,
      lines: [
        `  Provian setup stopped: ${host} resolved to a private or reserved address, which Provian never connects to.`,
        detail(egress, links.find(l => l.code === egress)?.message ?? top.message),
        `  This machine's DNS is answering with a substitute address. Fix its DNS (or set HTTPS_PROXY to the real proxy), then ${ctx.retry}.`,
      ],
    };
  }

  const tls = has(TLS_CODES);
  if (tls) {
    return {
      kind: 'tls', connection: true, codes,
      lines: [
        `  Provian setup stopped: this machine reached ${host}, but did not trust the certificate it was shown.`,
        detail(tls, links.find(l => l.code === tls)?.message ?? top.message),
        '  A network that inspects HTTPS shows its own certificate. Point NODE_EXTRA_CA_CERTS at that',
        `  certificate's file (the one curl trusts), then ${ctx.retry}.`,
      ],
    };
  }

  // An unusable proxy value (socks5://, …) is refused before anything is contacted.
  const badProxyValue = msgHas('egress proxy protocol refused');
  if (badProxyValue) {
    const name = ctx.proxyVar ?? 'HTTPS_PROXY';
    return {
      kind: 'proxy', connection: false, codes,
      lines: [
        `  Provian setup stopped: the proxy setting (${name}) is not an http:// or https:// proxy, so nothing was sent.`,
        detail(badProxyValue.code, badProxyValue.message),
        `  Set ${name} to the proxy as http://host:port, then ${ctx.retry}.`,
      ],
    };
  }

  const proxyFault = msgHas('egress proxy');
  if (proxyFault) {
    return {
      kind: 'proxy', connection: true, codes,
      lines: [
        `  Provian setup stopped: the proxy${via ? ` at ${via}` : ''} refused or dropped the connection to ${host}.`,
        detail(proxyFault.code, proxyFault.message),
        `  Ask your human to allow ${host} through the proxy, then ${ctx.retry}.`,
      ],
    };
  }

  const dns = has(DNS_CODES);
  if (dns) {
    return {
      kind: 'dns', connection: true, codes,
      lines: [
        `  Provian setup stopped: this machine could not look up ${via ?? host}.`,
        detail(dns, links.find(l => l.code === dns)?.message ?? top.message),
        `  Check this machine's DNS${via ? ' and proxy setting' : ''}, then ${ctx.retry}.`,
      ],
    };
  }

  const connect = has(CONNECT_CODES);
  if (connect) {
    return {
      kind: 'connect', connection: true, codes,
      lines: [
        `  Provian setup stopped: this machine could not connect to ${via ? `${host} through ${via}` : host}.`,
        detail(connect, links.find(l => l.code === connect)?.message ?? top.message),
        `  Check this machine's connection, then ${ctx.retry}.`,
      ],
    };
  }

  const http = codes.map(c => /^HTTP_(\d{3})$/.exec(c)).find(Boolean);
  if (http) {
    const status = Number(http[1]);
    const relayMessage = maskSecrets(links.find(l => l.code === http[0])?.message ?? top.message);
    const advice = status === 429
      ? `  Wait a minute, then ${ctx.retry}.`
      : status >= 500
        ? `  The problem is on Provian's side. Wait a few minutes, then ${ctx.retry}.`
        : `  If ${ctx.retry} gives the same answer, generate a fresh code in the Provian app under "Connect an agent".`;
    return {
      kind: 'relay_http', connection: false, codes,
      lines: [
        `  Provian setup stopped: ${host} answered HTTP ${status}: ${relayMessage}`,
        advice,
      ],
    };
  }

  // A network failure with no recognised code still names itself as one.
  const fetchFailed = links.find(l => l.message === 'fetch failed' || /Failed to reach relay/.test(l.message));
  if (fetchFailed) {
    const inner = links[links.length - 1];
    return {
      kind: 'connect', connection: true, codes,
      lines: [
        `  Provian setup stopped: this machine could not reach ${host}${via ? ` through ${via}` : ''}.`,
        detail(inner.code, inner.message),
        `  Check this machine's connection, then ${ctx.retry}.`,
      ],
    };
  }

  return {
    kind: 'local', connection: false, codes,
    lines: [
      '  Provian setup stopped on this machine (before or after talking to the relay — not a connection problem).',
      detail(top.code, top.message),
      `  ${ctx.retry.charAt(0).toUpperCase()}${ctx.retry.slice(1)}; if it stops again the same way, send this message to your human.`,
    ],
  };
}

/** The forward proxy Node would use for `relayUrl` (HTTPS_PROXY etc.), or undefined. */
export function proxyForRelay(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // The relay is https, and an https request uses only https_proxy / HTTPS_PROXY (pinnedConnector).
  return env.https_proxy || env.HTTPS_PROXY || undefined;
}

/** The name of the proxy variable in effect for an https relay, as Provian reads it. */
export function proxyVarForRelay(env: NodeJS.ProcessEnv = process.env): string {
  return env.https_proxy ? 'https_proxy' : 'HTTPS_PROXY';
}
