/**
 * legalAcceptance: which versions of the Terms of Service and Privacy Policy this install accepted.
 *
 * Each in-app legal document carries a `version`, a hash of its content generated from
 * docs/legal/*.md. Accepting records the current version of both. Acceptance is current only when
 * both recorded versions equal the documents the app ships now; a missing, blank or different
 * version (including an acceptance recorded before versions were kept) is not current, and the
 * person is asked to review and accept again. Versions are not secrets, so they persist with the
 * rest of the wallet store in AsyncStorage.
 */
import { TERMS_DOCUMENT } from '../../screens/Legal/termsContent.generated';
import { PRIVACY_DOCUMENT } from '../../screens/Legal/privacyContent.generated';

export interface LegalVersions {
    terms: string;
    privacy: string;
}

export interface LegalAcceptanceRecord {
    termsAcceptedVersion?: string | null;
    privacyAcceptedVersion?: string | null;
}

export const CURRENT_LEGAL_VERSIONS: LegalVersions = {
    terms: TERMS_DOCUMENT.version,
    privacy: PRIVACY_DOCUMENT.version,
};

/** The record an acceptance of the given versions writes. */
export function acceptedLegalVersions(current: LegalVersions = CURRENT_LEGAL_VERSIONS): Required<LegalAcceptanceRecord> {
    return { termsAcceptedVersion: current.terms, privacyAcceptedVersion: current.privacy };
}

const known = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** True only when both accepted versions are recorded and equal the current documents. */
export function legalAcceptanceCurrent(
    record: LegalAcceptanceRecord | null | undefined,
    current: LegalVersions = CURRENT_LEGAL_VERSIONS,
): boolean {
    if (!record || !known(current.terms) || !known(current.privacy)) return false;
    return known(record.termsAcceptedVersion)
        && known(record.privacyAcceptedVersion)
        && record.termsAcceptedVersion === current.terms
        && record.privacyAcceptedVersion === current.privacy;
}

/** Whether to ask this install to review and accept the current documents. */
export function legalReviewRequired(
    record: LegalAcceptanceRecord | null | undefined,
    current: LegalVersions = CURRENT_LEGAL_VERSIONS,
): boolean {
    return !legalAcceptanceCurrent(record, current);
}
