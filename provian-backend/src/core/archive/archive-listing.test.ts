/**
 * The PE Archive's x402 Bazaar listing. Checked with the x402 project's OWN
 * validator and extractor (`@x402/extensions/bazaar`, the code facilitators run), not a local copy
 * of its rules:
 * - the extension validates against its own schema, and a broken one does not (RED control);
 * - the payload the relay sends CDP yields a catalog entry with the listing's URL, description,
 * service name, all five tags and icon; the people's route yields none;
 * - the agent route's 402 carries the listing without changing a money term;
 * - the listing copy follows the invariant: .
 */
import { describe, it, expect } from '@jest/globals';
// Runtime: the package's own `exports` subpath (jest resolves it). Types: its CJS declaration file
// (this tsconfig resolves `node`, which does not read `exports`).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bazaar = require('@x402/extensions/bazaar') as typeof import('@x402/extensions/dist/cjs/bazaar');
const { extractDiscoveryInfo, validateDiscoveryExtension, sanitizeResourceServiceMetadata } = bazaar;
import {
  ARCHIVE_BAZAAR_EXTENSION,
  ARCHIVE_LISTING_DESCRIPTION,
  ARCHIVE_LISTING_SERVICE_NAME,
  ARCHIVE_LISTING_TAGS,
  ARCHIVE_SERVICE_TERMS,
  archiveAgentListing,
  archiveAgentPaymentRequired,
  archiveHumanListing,
  archivePaymentRequired,
} from './archive-terms';
import { cdpSettleBody, CDP_RESOURCE_DESCRIPTION_MAX_CHARS } from '../payments/cdp-facilitator';
import { usdcChargeRequirement, type UsdcChargePayment } from '../payments/usdc-charge';

const AGENT_URL = 'https://api.provian.ai/v1/archive/pay';
const PAYMENT: UsdcChargePayment = {
  signature: `0x${'11'.repeat(65)}`,
  authorization: {
    from: `0x${'22'.repeat(20)}`,
    to: '0x086e0f377af1245b8888540f39e99a42a7daf1da',
    value: '5000000',
    validAfter: '0',
    validBefore: '1791000300',
    nonce: `0x${'33'.repeat(32)}`,
  },
};
const REQUIREMENT = usdcChargeRequirement(ARCHIVE_SERVICE_TERMS);

type Payload = Parameters<typeof extractDiscoveryInfo>[0];
type Requirements = Parameters<typeof extractDiscoveryInfo>[1];

function sentToCdp(listing: ReturnType<typeof archiveAgentListing>): { payload: Payload; requirements: Requirements } {
  const body = cdpSettleBody(PAYMENT, REQUIREMENT, listing);
  return {
    payload: JSON.parse(JSON.stringify(body.paymentPayload)) as Payload,
    requirements: JSON.parse(JSON.stringify(body.paymentRequirements)) as Requirements,
  };
}

/** The CDP schema limits a settle body breaks: the description length CDP's `maxLength` refuses. */
function cdpLimitViolations(listing: ReturnType<typeof archiveAgentListing>): string[] {
  const body = cdpSettleBody(PAYMENT, REQUIREMENT, listing);
  const resource = (body.paymentPayload as { resource?: { description?: unknown } }).resource;
  const description = typeof resource?.description === 'string' ? resource.description : '';
  return description.length > CDP_RESOURCE_DESCRIPTION_MAX_CHARS
    ? [`resource.description is ${description.length} characters (CDP allows ${CDP_RESOURCE_DESCRIPTION_MAX_CHARS})`]
    : [];
}

describe('PE Archive Bazaar listing', () => {
  it("GREEN: the extension validates under the x402 project's own validator", () => {
    const result = validateDiscoveryExtension(JSON.parse(JSON.stringify(ARCHIVE_BAZAAR_EXTENSION)));
    expect(result).toEqual({ valid: true });
  });

  it('RED: a broken extension is refused by the same validator (the check can fail)', () => {
    const broken = JSON.parse(JSON.stringify(ARCHIVE_BAZAAR_EXTENSION));
    broken.info.input.method = 'GET';
    expect(validateDiscoveryExtension(broken).valid).toBe(false);
    const noKey = JSON.parse(JSON.stringify(ARCHIVE_BAZAAR_EXTENSION));
    delete noKey.info.input.headers;
    expect(validateDiscoveryExtension(noKey).valid).toBe(false);
    const extraBody = JSON.parse(JSON.stringify(ARCHIVE_BAZAAR_EXTENSION));
    extraBody.info.input.body = { amount: 10 };
    expect(validateDiscoveryExtension(extraBody).valid).toBe(false);
  });

  it('GREEN: what the relay sends CDP becomes a catalog entry with the full listing', () => {
    const { payload, requirements } = sentToCdp(archiveAgentListing(AGENT_URL));
    const entry = extractDiscoveryInfo(payload, requirements);
    expect(entry).not.toBeNull();
    expect(entry!.resourceUrl).toBe(AGENT_URL);
    expect(entry!.description).toBe(ARCHIVE_LISTING_DESCRIPTION);
    expect(entry!.mimeType).toBe('application/json');
    expect(entry!.discoveryInfo).toEqual(ARCHIVE_BAZAAR_EXTENSION.info);
    const meta = sanitizeResourceServiceMetadata((payload as { resource?: unknown }).resource as never);
    expect(meta).toEqual({
      serviceName: ARCHIVE_LISTING_SERVICE_NAME,
      tags: [...ARCHIVE_LISTING_TAGS],
      iconUrl: 'https://provian.ai/logos/provian-256.png',
    });
  });

  it("RED: the people's route declares no listing — nothing to catalog", () => {
    const { payload, requirements } = sentToCdp(archiveHumanListing('https://api.provian.ai/v1/archive/mobile/pay'));
    expect(extractDiscoveryInfo(payload, requirements)).toBeNull();
  });

  it("GREEN: the agent route's 402 carries the listing; every money term is the shared quote's", () => {
    const listed = archiveAgentPaymentRequired(AGENT_URL);
    const plain = archivePaymentRequired(AGENT_URL);
    expect(listed.accepts).toEqual(plain.accepts);
    expect(listed.x402Version).toBe(2);
    expect(listed.resource).toEqual(archiveAgentListing(AGENT_URL).resource);
    expect(listed.extensions).toEqual({ bazaar: ARCHIVE_BAZAAR_EXTENSION });
    expect(archiveAgentPaymentRequired(AGENT_URL, 'archive_space_exhausted').error).toBe('archive_space_exhausted');
  });

  it("GREEN: listing copy leads with the agent's wallet and PE record and carries no price framing", () => {
    expect(ARCHIVE_LISTING_DESCRIPTION.startsWith('For AI agents with a Provian wallet: a self-custodial wallet')).toBe(true);
    const copy = [ARCHIVE_LISTING_DESCRIPTION, ARCHIVE_LISTING_SERVICE_NAME, ...ARCHIVE_LISTING_TAGS, ARCHIVE_SERVICE_TERMS.note].join(' ');
    const forbidden = /\$|\bUSD\b|\bprice|\bworth\b|invest|airdrop|free money|\bPVT\b/i;
    expect(forbidden.test(copy)).toBe(false);
    // RED control: the same check catches the copy it exists to refuse.
    expect(forbidden.test(`${copy} for $5`)).toBe(true);
    expect(ARCHIVE_LISTING_TAGS.length).toBeLessThanOrEqual(5);
    expect(ARCHIVE_LISTING_SERVICE_NAME.length).toBeLessThanOrEqual(32);
  });
  it('GREEN: every settle body the Archive sends CDP is within CDP\'s schema limits', () => {
    const listings = [archiveAgentListing(AGENT_URL), archiveHumanListing('https://api.provian.ai/v1/archive/mobile/pay')];
    expect(listings).toHaveLength(2);
    for (const listing of listings) expect(cdpLimitViolations(listing)).toEqual([]);
  });

  it('RED: a description over CDP\'s limit is reported by the same check (the check can fail)', () => {
    const long = archiveAgentListing(AGENT_URL);
    const over = { ...long, resource: { ...long.resource, description: 'x'.repeat(CDP_RESOURCE_DESCRIPTION_MAX_CHARS + 1) } };
    expect(cdpLimitViolations(over)).toHaveLength(1);
    const exact = { ...long, resource: { ...long.resource, description: 'x'.repeat(CDP_RESOURCE_DESCRIPTION_MAX_CHARS) } };
    expect(cdpLimitViolations(exact)).toEqual([]);
  });
});
