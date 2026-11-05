/**
 * Finding 21 — the MCP registry listing must not tell an agent that create_wallet
 * "works without" credentials. On the remote endpoint create_wallet is DISABLED,
 * and locally it requires PROVIAN_KEYSTORE_PASSPHRASE, so lumping it in with the
 * genuine no-auth reads was misleading.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const listing = JSON.parse(
  readFileSync(resolve(__dirname, '../../server.json'), 'utf8'),
) as {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string; subfolder?: string };
  icons: Array<{ src: string; mimeType: string; sizes: string[] }>;
  remotes: Array<{ type: string; url: string; headers: Array<{ name: string; description: string }> }>;
  packages?: unknown[];
};

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string; mcpName: string };

/**
 * The official MCP Registry entry (launch listings, 2026-10-07): Provian's own namespace (the HTTP
 * domain proof served at provian.ai/.well-known/mcp-registry-auth authorizes `ai.provian/*`), the
 * registry's own limits (description 1–100 characters; validated by the production registry with
 * `mcp-publisher validate` on 2026-10-07), the hosted endpoint, and the public repo.
 */
describe('server.json (official MCP Registry)', () => {
  it("is listed under Provian's own name for the hosted /mcp, naming the public repo", () => {
    expect(listing.name).toBe('ai.provian/mcp');
    expect(pkg.mcpName).toBe(listing.name);
    expect(listing.title).toBe('Provian');
    expect(listing.remotes[0]).toMatchObject({ type: 'streamable-http', url: 'https://api.provian.ai/mcp' });
    expect(listing.repository).toEqual({
      url: 'https://github.com/LongevityManiac/provian', source: 'github', subfolder: 'provian-mcp',
    });
    expect(listing.icons[0].src).toMatch(/^https:\/\/provian\.ai\//);
  });

  it('keeps the registry limits and the published package version', () => {
    expect(listing.description.length).toBeGreaterThan(0);
    expect(listing.description.length).toBeLessThanOrEqual(100);
    expect(listing.description.startsWith('Self-custodial agent wallet')).toBe(true);
    expect(listing.version).toBe(pkg.version);
    // RED control: the same limit check refuses an over-long description.
    expect(`${listing.description} and a hundred more characters of marketing that the registry refuses`.length).toBeGreaterThan(100);
  });
});

describe('server.json remote auth note (finding 21)', () => {
  it('the remote Authorization note no longer claims create_wallet works without credentials', () => {
    const authHeader = listing.remotes[0].headers.find((h) => h.name === 'Authorization');
    expect(authHeader).toBeDefined();
    const desc = authHeader!.description;
    // RED baseline: "Bootstrap tools (create_wallet, get_agent_record,
    // get_pvt_estimate) work without it."
    expect(desc).not.toMatch(/create_wallet[^.]*work(s)? without/i);
    // The public reads are still correctly called out as needing nothing.
    expect(desc).toContain('get_agent_record');
    expect(desc).toContain('get_pvt_estimate');
    // ...and create_wallet is now flagged as disabled on the remote.
    expect(desc).toMatch(/create_wallet is DISABLED/i);
  });
});

/**
 * Launch channels : every listing points only to Provian's onboarding paths. For
 * an agent that can run a shell that is the installer line or the SDK; the MCP listing is the hosted
 * server, for an agent that cannot. So the registry entry carries the hosted remote and no local
 * package (the npm package still publishes; the listing does not advertise it).
 */
export function isHostedOnlyListing(l: { remotes?: unknown[]; packages?: unknown[] }): boolean {
  return Array.isArray(l.remotes) && l.remotes.length > 0 && (l.packages === undefined || l.packages.length === 0);
}

describe('server.json lists only the hosted MCP server', () => {
  it('has the hosted remote and no local package', () => {
    expect(isHostedOnlyListing(listing)).toBe(true);
    expect(listing.remotes).toHaveLength(1);
  });

  it('RED control: a listing that also advertises the local npm package fails', () => {
    expect(isHostedOnlyListing({ ...listing, packages: [{ registryType: 'npm', identifier: '@provian/mcp' }] })).toBe(false);
    expect(isHostedOnlyListing({ ...listing, remotes: [] })).toBe(false);
  });
});
