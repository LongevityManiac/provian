/**
 * Android Key Attestation verifier - public surface.
 *
 * The pure core (`verifyAndroidKeyAttestation`) promotes an Android KeyStore
 * registration to a Google-attested PE attestation tier only when the emitted
 * X.509 attestation chain verifies end to end. See docs/ATTESTATION_ROADMAP.md.
 */
export * from './types';
export { buildTrustAnchorSet, spkiFingerprint } from './roots';
export type { TrustAnchorSet } from './roots';
export { verifyCertChain } from './chain';
export { parseKeyDescription } from './extension';
export { checkRevocation, normalizeSerial } from './revocation';
export { verifyAndroidKeyAttestation } from './verify';
export type { VerifyAndroidKeyAttestationInput } from './verify';
export {
  verifyAndroidRegistrationChain,
  loadRevocationSource,
  productionAnchors,
} from './adapter';
export type {
  RegistrationChainInput,
  RevocationCache,
  FetchLike,
} from './adapter';
export { GOOGLE_HW_ATTESTATION_ROOTS } from './google-roots';
