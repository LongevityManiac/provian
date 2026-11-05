/**
 * HARDWARE WITNESS (Trust Layer build §2.9) — the one slot every lane carries.
 *
 * A submitting body may attach `hardware_witness`: a report a NON-actor key signed (a TPM, the
 * Secure Enclave, a cloud attestation service, a GPU) whose nonce binds THIS submission
 * (`hardwareBindingNonce(body)`). The relay verifies the report against its SCHEME's pinned public
 * root; only App Attest supplies `hardware_rooted` (4.0×). Other admitted reports are verified facts at the normal lane price. A report that is
 * present but does not verify — wrong nonce, chain not reaching the root, bad signature, signer is
 * the actor's own key — is RECORDED (its metadata-only fields + the reason) and the PE stays in
 * the lane's ordinary class. Never 4.0× on a report the relay could not check (Unknown = Block).
 *
 * METADATA-ONLY (§3): the raw report is never persisted — only its sha256, the signer key's
 * sha256, the root fingerprint, and typed measurement digests / coarse facts.
 */
import type { HardwareScheme } from './roots';

/** The typed, metadata-only fields a verifier extracts (every one optional; hash + type tag only). */
export interface HardwareWitnessFields {
  readonly tee_type?: string;                 // e.g. 'tpm2', 'apple_secure_enclave', 'aws_nitro', 'amd_sev_snp', 'nvidia_hopper'
  readonly tee_version?: string;              // firmware / SVN / TPM firmware version, as a short token
  readonly launch_measurement?: string;       // sha256:/sha384: digest of the launch / image measurement
  readonly pcr_digest?: string;               // TPM: the quoted PCR digest (sha256:)
  readonly pcr_selection?: string;            // TPM: 'sha256:0,1,2,...'
  readonly measurement_digest?: string;       // NVIDIA: sha384 of the measurement record
  readonly report_digest: string;             // sha256 of the raw report bytes (always)
  readonly issuer_root_fingerprint?: string;  // sha256 fingerprint of the pinned root reached
  readonly signer_key_sha256: string;         // sha256(SPKI) of the key that signed the report (always)
  readonly manufacturer?: string;             // from the signer certificate's O= / the scheme
  readonly model?: string;                    // coarse model token (GH100, GCP_AMD_SEV, tpm2)
  readonly serial_sha256?: string;            // sha256 of the device / certificate serial — never raw
  readonly firmware_digest?: string;          // sha256: of firmware/driver measurement when present
  readonly image_digest?: string;             // container image digest (GCP confidential space)
  readonly region?: string;                   // coarse attested region/zone prefix (e.g. 'us-central1')
  readonly attested_time_ms?: number;         // the time the report itself carries
  readonly time_source?: string;              // 'report_timestamp' | 'token_iat'
  readonly secure_boot?: boolean;
  readonly debug_enabled?: boolean;
  readonly nonce_bound: boolean;              // the report's nonce equals the binding nonce
}

export interface HardwareWitnessVerdict {
  readonly admitted: boolean;
  readonly scheme: HardwareScheme | null;
  /** Machine-readable reason (admitted → 'verified'; otherwise the first failing check). */
  readonly reason: string;
  readonly fields: HardwareWitnessFields | null;
}

/** The lane-independent context every verifier receives. */
export interface HardwareVerifyContext {
  /** sha256 over the submission body minus `hardware_witness` — what the report's nonce must equal. */
  readonly bindingNonce: Buffer;
  /** sha256(SPKI DER) of every key the ACTOR controls on this lane (device SE key, …). A report signed by one of these is not a witness. */
  readonly actorKeyFingerprints: ReadonlySet<string>;
  readonly nowMs: number;
  /** Injected fetch for the JWT schemes' key endpoints (defaults to global fetch). */
  readonly fetch?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Apple App Attest: the App ID (`<team id>.<bundle id>`) whose rpIdHash the authenticator data must carry. */
  readonly appleAppId?: string | null;
  /** Apple App Attest ASSERTIONS (per-PE): the attested-key registry for this actor (mobile lane). */
  readonly appleAssertion?: import('./apple-app-attest-assertion').AppleAssertionDeps | null;
  /** TEST SEAM ONLY: replace a scheme's pinned root set (production lanes never set it). */
  readonly rootsOverride?: Partial<Record<HardwareScheme, readonly import('crypto').X509Certificate[]>>;
}

/** The shape a lane accepts on the wire (scheme-specific payload; every value base64 / PEM / JWT text). */
export interface HardwareWitnessInput {
  readonly scheme: HardwareScheme;
  readonly nonce_binding?: 'body_sha256';
  // tpm2_quote
  readonly quote?: string;         // base64 TPMS_ATTEST (the TPM2B_ATTEST contents)
  readonly signature?: string;     // base64 TPMT_SIGNATURE
  readonly ak_public?: string;     // base64 TPMT_PUBLIC (or TPM2B_PUBLIC)
  readonly ak_cert_chain?: readonly string[]; // PEM/base64 DER, leaf first
  // apple_app_attest
  readonly attestation?: string;   // base64 CBOR attestation object
  readonly assertion?: string;     // base64 CBOR assertion (post-attestation) — not yet accepted
  readonly key_id?: string;        // base64 key identifier
  // aws_nitro
  readonly document?: string;      // base64 COSE_Sign1
  // gcp_confidential_space / azure_attestation
  readonly token?: string;         // the JWT
  // nvidia_cc
  readonly report?: string;        // hex (request || response) as nvtrust emits
  readonly cert_chain?: string;    // PEM bundle, leaf first
}
