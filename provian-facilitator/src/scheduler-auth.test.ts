import { describe, expect, it } from 'vitest';
import { SCHEDULER_SERVICE_ACCOUNT, schedulerTokenCheck, type IdTokenVerifier } from './scheduler-auth.js';

const AUD = 'https://provian-x402-facilitator-185909722463.us-central1.run.app';

/** A stand-in for Google's signature + audience check: knows one good token per claim set. */
function fakeVerifier(tokens: Record<string, { email?: string; email_verified?: boolean }>): IdTokenVerifier & { seenAudiences: string[][] } {
  const seen: string[][] = [];
  const f = (async (token: string, audiences: readonly string[]) => {
    seen.push([...audiences]);
    const claims = tokens[token];
    if (!claims) throw new Error('invalid token signature');
    return claims;
  }) as IdTokenVerifier & { seenAudiences: string[][] };
  f.seenAudiences = seen;
  return f;
}

describe('schedulerTokenCheck', () => {
  it('no audience configured → null (only the shared secret is accepted)', () => {
    expect(schedulerTokenCheck(undefined, fakeVerifier({}))).toBeNull();
    expect(schedulerTokenCheck(' , ', fakeVerifier({}))).toBeNull();
  });

  it('accepts only the scheduler service account with a verified email, against this service\'s audiences', async () => {
    const v = fakeVerifier({
      good: { email: SCHEDULER_SERVICE_ACCOUNT, email_verified: true },
      other: { email: 'someone-else@provian-ai.iam.gserviceaccount.com', email_verified: true },
      unverified: { email: SCHEDULER_SERVICE_ACCOUNT, email_verified: false },
      noemail: {},
    });
    const check = schedulerTokenCheck(`${AUD}, https://facilitator.provian.ai`, v)!;
    expect(await check('good')).toBe(true);
    // RED controls: each violating token is refused.
    expect(await check('other')).toBe(false);
    expect(await check('unverified')).toBe(false);
    expect(await check('noemail')).toBe(false);
    expect(await check('forged')).toBe(false); // signature / audience failure → the verifier throws
    expect(v.seenAudiences[0]).toEqual([AUD, 'https://facilitator.provian.ai']);
  });
});
