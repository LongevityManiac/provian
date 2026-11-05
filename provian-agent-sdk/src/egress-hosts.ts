/**
 * Every host a Provian install and its daemon contact (2026-10-20, measured with a connection
 * trace on a fake-IP box). A platform that approves hosts one by one (Sentinel, Network
 * Controls) needs ONE standing allow covering all of them, so the install names every one.
 *
 * MIRRORED in provian-backend/src/core/agent-bootstrap-script.ts (`EGRESS_ALLOW_HOSTS`), which
 * the shell script prints before any Node runs; `egress-hosts.mirror.test.ts` keeps them equal.
 */
export interface EgressHostUse { readonly host: string; readonly use: string }

/** The fixed hosts, after the relay itself. */
export const EGRESS_ALLOW_HOSTS: readonly EgressHostUse[] = [
  { host: 'nodejs.org', use: "Provian's own Node runtime: at setup unless this machine already has it, and again if an update needs a newer one" },
  { host: '1.1.1.1', use: "address lookups (DNS over HTTPS), only when this machine's own DNS can't give a real address" },
  { host: '8.8.8.8', use: 'the same lookups, when 1.1.1.1 does not answer' },
  { host: 'mainnet.base.org', use: 'on-chain and Commons acts on Base (PROVIAN_BASE_RPC_URL names another)' },
  { host: 'api.mainnet-beta.solana.com', use: 'Solana x402 payments, only if you make them' },
];

export function egressAllowHosts(relayHost: string): EgressHostUse[] {
  return [{ host: relayHost, use: 'setup, the daemon, every record, and updates' }, ...EGRESS_ALLOW_HOSTS];
}

/** The lines asking for one standing allow covering every host. */
export function egressAllowLines(relayHost: string, indent: string): string[] {
  return [
    `${indent}If your platform approves network requests host by host, ask your human once for ONE standing`,
    `${indent}allow covering every host Provian contacts:`,
    ...egressAllowHosts(relayHost).map(h => `${indent}  ${h.host} — ${h.use}`),
    `${indent}Nothing else is contacted, apart from the model provider your own program already uses and sites you choose to pay.`,
  ];
}
