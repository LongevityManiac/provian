/**
 * Embedded beneficiary connection tokens fail closed.
 *
 * `rejectEmbeddedBeneficiaryLink` / `EMBEDDED_BENEFICIARY_LINK_REJECTION` guard the
 * mounted `POST /v1/relay/connection-token` route: a token may never carry an
 * embedded `beneficiary_link` (the three-commit-crossing bind the guard exists to
 * refuse). The `consumeConnectionTokenTransactional` half of the original suite
 * was retired with the relay session channel (addendum 3); this half stays
 * because its subject is still live.
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  EMBEDDED_BENEFICIARY_LINK_REJECTION,
  rejectEmbeddedBeneficiaryLink,
} from './connection-token';

describe('embedded beneficiary connection tokens fail closed', () => {
  it('returns a stable migration error for any supplied embedded link', () => {
    expect(rejectEmbeddedBeneficiaryLink(undefined)).toBeNull();
    expect(rejectEmbeddedBeneficiaryLink(null)).toBeNull();
    expect(rejectEmbeddedBeneficiaryLink({ human_wallet_id: 'wallet_human_1' }))
      .toBe(EMBEDDED_BENEFICIARY_LINK_REJECTION);
    expect(rejectEmbeddedBeneficiaryLink('malformed'))
      .toBe(EMBEDDED_BENEFICIARY_LINK_REJECTION);
  });

  it('guards the token-issuance route before token creation (the connect route is gone)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    const issueStart = source.indexOf("app.post('/v1/relay/connection-token'");
    const issueEnd = source.indexOf("app.post('/v1/relay/connect/email-command'", issueStart);
    const issueRoute = source.slice(issueStart, issueEnd);
    expect(issueStart).toBeGreaterThanOrEqual(0);
    expect(issueRoute.indexOf('rejectEmbeddedBeneficiaryLink(beneficiary_link)'))
      .toBeGreaterThanOrEqual(0);
    expect(issueRoute.indexOf('rejectEmbeddedBeneficiaryLink(beneficiary_link)'))
      .toBeLessThan(issueRoute.indexOf('generateConnectionToken()'));
    // addendum 3: the second consumer (POST /v1/relay/agent/connect) no longer exists.
    expect(source).not.toContain("app.post('/v1/relay/agent/connect'");
  });

  it('does not consume a legacy pending marker in the post-registration tail', () => {
    const source = fs.readFileSync(path.join(__dirname, 'agent-wallet.ts'), 'utf8');
    const createStart = source.indexOf("router.post('/create'");
    const createEnd = source.indexOf('// GET /:wallet_id - Get wallet info', createStart);
    const createRoute = source.slice(createStart, createEnd);
    const responseAt = createRoute.indexOf('res.status(201).json(response)');
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createRoute).not.toContain('pending_beneficiary_link');
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(createRoute.slice(responseAt)).not.toContain("collection('agent_sessions')");
    expect(createRoute.slice(responseAt)).not.toContain('bindAgentToHuman(');
  });
});
