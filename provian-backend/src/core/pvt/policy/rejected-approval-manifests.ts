/**
 * Single maintained source of truth for PVT approval manifests that failed an
 * independent review and must never authorize any runtime consumer.
 *
 * Keep this ledger append-only. Generated approval surfaces and runtime gates
 * import it directly; do not copy a partial hash list elsewhere.
 */
export const REJECTED_PVT_APPROVAL_MANIFEST_SHA256 = Object.freeze([
  'sha256:04c0bec8a4a1bda992c5819e8e3bcf2def22e3e9306ce2ea51c9ffb682a0f123',
  'sha256:61c92cefad93a4477e5ff86fa093facee2d72265eae0d8caacc48eaca0903cff',
  'sha256:5d26fd57cbb3051854850f4cb52fed4f2994821616c50857a7ee1f96763f60a1',
  'sha256:9081b80b4d35589dcceaf181f13bc30885df2303db56d7717b507de343ee380b',
  'sha256:f5ee33f065efd2fc0ed028d25cfbdb13f245ab2e6f590f6c0ba5f8a3392f94bd',
  'sha256:84cfbfd180734b83cf5b286b463d02682c6e44c53c9af6cde2b67d85cbd36422',
  'sha256:fddd4d8008c67d673b4eb4e71e686e9e0c65248e6432e1e4bd0ae26a3bc3b4e8',
  'sha256:9dda0e70c92018a070307dd09e9450a4b9ad9a53740f3e382f73637831471cd1',
  'sha256:42494d93d5c07719a39f1b7ecce65af0a9f7f27c3ec673e4d476593f582c4baf',
  'sha256:a33676ef6c7b1bff191af4fd392160c98422df6fc00f7a8f3dc5bdbec9270cf2',
  'sha256:2e2aba9ecd12746b2362b05c6d98a90d8d9cdbd805e37cc063ca36e6bbf6d178',
  'sha256:14204edca0684b8f354f3f32c018bc16009796f17e426fb11ee921c54c824c6c',
  // Post-approval frozen candidate rejected for incorrect WP status wording.
  'sha256:683bc13371126e2f621f7cc3b07bdf0da4bf1c53180d67e32a09e26cc9e59217',
  // Replacement rejected for maintained public split/routing/eligibility drift.
  'sha256:44f8145c3b46107b248b0dd5e54955b742e90b939a7d52e0e07646bb226751bf',
  // Replacement rejected because its frozen handoff understated the focused test count.
  'sha256:24c1e8affb2fda3aa8b67a88a37deed8e076c41223f1e64436ba9db09a1f6ee4',
  // Checkpoint rejected for fail-open device ownership and inconsistent WP2/legacy-authority status.
  'sha256:a6cd8ad75f1df87975861f8f91a68e3278af0b5ab6f71b544a11206a4412c7af',
  // Corrected checkpoint candidate rejected because mobile no-effect proof was source-only.
  'sha256:991022ec75e48e8d845cddcdff4a1b3a338ab0921f0cc55bbf402e3d0ae61629',
] as const);

const REJECTED_HASH_SET: ReadonlySet<string> = new Set(
  REJECTED_PVT_APPROVAL_MANIFEST_SHA256,
);

export function isRejectedPvtApprovalManifestSha256(value: unknown): boolean {
  return typeof value === 'string' && REJECTED_HASH_SET.has(value);
}
