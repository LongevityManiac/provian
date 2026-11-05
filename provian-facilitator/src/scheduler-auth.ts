/**
 * Cloud Scheduler OIDC for the facilitator's /internal/* routes — the relay's rule (F43): a
 * scheduled job authenticates with a Google-signed OIDC token, never with a shared secret baked
 * into its headers (readable by anyone with `cloudscheduler.jobs.get`).
 *
 * A token passes only when Google's signature verifies, its audience is one of this service's
 * URLs, and its email is the scheduler service account (verified email). Anything else is false.
 */

import { OAuth2Client } from 'google-auth-library';

export const SCHEDULER_SERVICE_ACCOUNT = 'provian-scheduler@provian-ai.iam.gserviceaccount.com';

/** The claims the check reads, from whatever verified the token's signature. */
export interface VerifiedClaims {
  readonly email?: string;
  readonly email_verified?: boolean;
}

/** Verifies a token's signature + audience and returns its claims; throws when it does not verify. */
export type IdTokenVerifier = (token: string, audiences: readonly string[]) => Promise<VerifiedClaims | undefined>;

export const googleIdTokenVerifier = (): IdTokenVerifier => {
  const client = new OAuth2Client();
  return async (token, audiences) => (await client.verifyIdToken({ idToken: token, audience: [...audiences] })).getPayload();
};

/**
 * Null when no audience is configured (only the shared secret is accepted then). Audiences come
 * from FACILITATOR_OIDC_AUDIENCES: the service's run.app URL (what Cloud Scheduler signs for),
 * comma-separated if there are several.
 */
export function schedulerTokenCheck(
  audiencesEnv: string | undefined,
  verifier: IdTokenVerifier = googleIdTokenVerifier(),
): ((token: string) => Promise<boolean>) | null {
  const audiences = (audiencesEnv ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (audiences.length === 0) return null;
  return async (token) => {
    try {
      const claims = await verifier(token, audiences);
      return claims?.email === SCHEDULER_SERVICE_ACCOUNT && claims.email_verified === true;
    } catch {
      return false;
    }
  };
}
