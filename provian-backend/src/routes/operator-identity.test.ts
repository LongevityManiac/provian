/**
 * F55 (S2 2026-09-10) — operator audit identity.
 *
 * RED controls: x-operator-id must NEVER be the primary identity (pre-fix, the
 * three admin routers derived the audit identity from x-operator-id alone, so a
 * caller with the admin secret could stamp any name); the primary comes only
 * from the nginx-set, un-spoofable x-ops-basic-user. A direct-secret caller
 * (no x-ops-basic-user) is unattributable (primary null); its x-operator-id is
 * recorded only as asserted.
 */

import { primaryOperatorId, assertedOperatorId } from './operator-identity';
import type { Request } from 'express';

function req(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request;
}

describe('operator-identity (F55)', () => {
  it('primary comes ONLY from x-ops-basic-user, never x-operator-id', () => {
    expect(primaryOperatorId(req({ 'x-ops-basic-user': 'frank@provian.ai' }))).toBe('frank@provian.ai');
    // RED: x-operator-id must not become the primary identity.
    expect(primaryOperatorId(req({ 'x-operator-id': 'frank@provian.ai' }))).toBeNull();
    // The nginx split: fixed x-operator-id + real htpasswd user — primary is the real user.
    expect(primaryOperatorId(req({ 'x-ops-basic-user': 'alice', 'x-operator-id': 'optimist@provian.ai' }))).toBe('alice');
  });

  it('asserted comes from x-operator-id (recorded, never primary)', () => {
    expect(assertedOperatorId(req({ 'x-operator-id': 'optimist@provian.ai' }))).toBe('optimist@provian.ai');
    expect(assertedOperatorId(req({ 'x-ops-basic-user': 'alice' }))).toBeNull();
  });

  it('a direct-secret caller (no x-ops-basic-user) is unattributable', () => {
    const r = req({ 'x-operator-id': 'i-am-frank' });
    expect(primaryOperatorId(r)).toBeNull();     // unattributable
    expect(assertedOperatorId(r)).toBe('i-am-frank'); // but its claim is recorded
  });

  it('rejects malformed / oversized identities on both readers', () => {
    expect(primaryOperatorId(req({ 'x-ops-basic-user': 'a b' }))).toBeNull(); // space not allowed
    expect(primaryOperatorId(req({ 'x-ops-basic-user': 'x' }))).toBeNull();   // too short (<3)
    expect(assertedOperatorId(req({ 'x-operator-id': 'a'.repeat(200) }))).toBeNull();
  });
});
