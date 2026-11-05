/**
 * restoreConsent — restoring a wallet passes through the same three acknowledgements as creating one.
 *
 * RecoveryStart is the one branch point into both restore methods. A person who has not accepted
 * the current Terms of Service and Privacy Policy on this install goes to ConsentScreen first, which
 * continues to the chosen method once all three are checked; a person whose acceptance is current
 * goes straight on. A missing acceptance, or one of an earlier version of either document, counts
 * as not accepted (see core/legal/legalAcceptance).
 */

export const RESTORE_METHODS = ['CloudRecovery', 'ImportRecoveryPhrase'] as const;
export type RestoreMethod = (typeof RESTORE_METHODS)[number];

export type RestoreEntry =
  | { screen: 'Consent'; params: { next: RestoreMethod } }
  | { screen: RestoreMethod };

export function restoreEntry(method: RestoreMethod, legalAccepted: boolean): RestoreEntry {
  return legalAccepted === true ? { screen: method } : { screen: 'Consent', params: { next: method } };
}

/** The restore method ConsentScreen continues to, or null for the create path (anything else). */
export function restoreNextOf(next: unknown): RestoreMethod | null {
  return (RESTORE_METHODS as readonly unknown[]).includes(next) ? (next as RestoreMethod) : null;
}
