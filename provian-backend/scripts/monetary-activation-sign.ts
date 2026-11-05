#!/usr/bin/env tsx
/**
 * ARM THE STANDARD LANE — the exact bytes to sign, and the exact document to write.
 *
 * The record-time monetary policy is what decides whether an ordinary standard-lane act
 * (send / receive / swap / x402_payment / agent_token_transfer …) mints or is sealed
 * `record_only`. `loadRuntimeMonetaryPolicy` requires a signed activation document at
 * Firestore `pvt_policy_activations/monetary`; absent or invalid, it fails closed to
 * `inactiveRecordOnlyPolicy()` and every standard action mints nothing.
 *
 * As of that document DOES NOT EXIST (verified live: HTTP 404, against a 200 control
 * on the sibling `genesis` document). This script produces the two artifacts needed to
 * change that, and nothing else.
 *
 * IT SIGNS NOTHING, HOLDS NO KEY, WRITES NO FILE, WRITES NO FIRESTORE DOCUMENT, AND SENDS
 * NO TRANSACTION. It prints. The signing step is `ssh-keygen -Y sign`, run by the operator against
 * his own key. Writing the document is a separate, reviewed, `--commit`-style step that is
 * deliberately NOT in this file.
 *
 * ── READ THIS BEFORE RUNNING IT ──────────────────────────────────────
 * THE RAIL IS CLOSED, AND THAT IS THE ACTUAL BLOCKER — not a missing signature.
 * `isValidMonetaryPolicyActivation` makes exactly one approval check,
 * `verifyCurrentPvtManifestApproval`, which refuses unconditionally while
 * `PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED` is `false` which it is, because the
 * Gate 1 manifest bytes themselves carry `signing_permitted: false` and
 * `approval_status: "gate_1_plain_english_policy_approved_non_signable"`.
 *
 * Measured rather than read : the SAME signature, key and env config that make
 * `isApprovedGenesisActivation` return TRUE make `verifyCurrentPvtManifestApproval` return
 * FALSE. So no monetary activation document can validate in this tree, however well-formed
 * and however genuinely signed.
 *
 * The tree says this is deliberate, in two places neither of which is this file:
 * - approved-genesis-activation-approval.ts:19 — "verifyCurrentPvtManifestApproval keeps its
 * signing_permitted: false refusal for every existing caller, including the monetary-policy
 * rail at runtime-monetary-policy.ts:118, which never imports this module and therefore
 * cannot reach it."
 * - the genesis-settlement manifest bytes — "It does not open the record-time monetary policy
 * rail (verifyCurrentPvtManifestApproval), which reads the Gate 1 constant and stays refused."
 *
 * OPENING IT IS FRANK'S DECISION, and this script does not make it. Two in-tree precedents
 * open a narrowly-scoped route WITHOUT moving FROZEN_MANIFEST_SHA256 (704c1a2d…):
 * `approved-genesis-activation-approval.ts` (a separate approval module binding the frozen
 * hash unmoved) and `genesis-settlement-approval-manifest.ts` (a signable successor manifest
 * scoped to one artifact). Until one of those exists for this rail, step 3 below REFUSES.
 *
 * ── THERE IS NOTHING NEW TO SIGN ─────────────────────────────────────────────
 * The signature is taken over the GATE 1 MANIFEST BYTES, not over any per-document payload.
 * the operator has already produced exactly such a signature — it is the one in
 * `pvt_policy_activations/genesis` today. A fresh `ssh-keygen -Y sign` run yields a
 * byte-different but equally valid SSHSIG over the same bytes and changes nothing about
 * whether the document validates. Steps 1-2 are kept so the sequence is complete and so the
 * artifact is reproducible from scratch; `--reuse-genesis-signature` short-circuits them.
 *
 * ── THE SEQUENCE ─────────────────────────────────────────────────────────────
 * 0. FRANK: open the rail (see above). Nothing below can substitute for this.
 *
 * 1. One time — write the public key and point ssh at the 1Password agent. Enable the agent
 * once in 1Password -> Settings -> Developer -> "Use the SSH agent" * printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAf9JCgexoRd6ZMoF1oJOIS25hmoqPriUTxlz3rVZ6e' \
 * > ~/.ssh/provian-pvt-policy.pub
 * export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
 *
 * 2. Print the exact bytes to sign:
 * npx tsx provian-backend/scripts/monetary-activation-sign.ts --print-payload \
 * > /tmp/monetary.payload
 *
 * 3. Sign them. `-f` is the PUBLIC key: ssh-keygen finds the private half in the agent, so
 * 1Password signs and the key never touches disk. This script never sees it.
 * ssh-keygen -Y sign -f ~/.ssh/provian-pvt-policy.pub -n provian-pvt-policy \
 * /tmp/monetary.payload
 *
 * 4. Print the finished document, self-checked against the runtime's own validator:
 * export FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY="$(cat ~/.ssh/provian-pvt-policy.pub)"
 * export FRANK_PVT_APPROVAL_SSH_KEY_SHA256=sha256:200b11f0842bdf578eeb2ebb4859c9fcd3ba870159e53d6747ffaff893462974
 * npx tsx provian-backend/scripts/monetary-activation-sign.ts \
 * --effective-from 2026-08-03T00:00:00Z --signature /tmp/monetary.payload.sig
 *
 * 5. Write it — SEPARATE, REVIEWED COMMIT. Not scripted here: this is a production Firestore
 * write on the money path and belongs with its own RED control, on the model of
 * `wp12-genesis-activate.ts --commit`.
 *
 * 6. Deploy. The / trap: the document is inert until `provian-api` runs code that
 * reads it. Confirm the revision carries `runtime-monetary-policy.ts` before assuming.
 *
 * `--effective-from` is a FLOOR on record time: `loadRuntimeMonetaryPolicy` returns the inactive
 * record-only policy for any PE recorded before it. Arming can therefore never reprice work that
 * was already recorded.
 *
 * 's two operator traps still apply. (a) If `SSH_AUTH_SOCK` points at a socket that does not
 * exist, ssh-keygen silently falls back to a private-key path holding only a `.pub` and reports a
 * confusing error. (b) `op read` returns ed25519 private keys as PKCS#8, which OpenSSH cannot
 * parse — use the `?ssh-format=openssh` modifier if you bypass the agent.
 */

import { readFileSync } from 'fs';

import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED,
  PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64,
} from '../src/core/pvt/policy/pvt9-approval-manifest.generated';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from '../src/core/pvt/policy/proposed-monetary-policy';
import {
  MONETARY_POLICY_ACTIVATION_COLLECTION,
  MONETARY_POLICY_ACTIVATION_DOCUMENT,
  hashProposedMonetaryPolicyTemplate,
  isValidMonetaryPolicyActivation,
} from '../src/core/pvt/policy/runtime-monetary-policy';
import {
  approvalVerifierConfigFromEnv,
  decodeOpenSshEd25519PublicKey,
} from '../src/core/pvt/policy/approval-signature';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function fail(code: string, message: string): never {
  console.error(`REFUSED: ${code}\n  ${message}`);
  process.exit(1);
}

// ── Step 2: the exact bytes to sign ──────────────────────────────────────────
//
// Emitted to stdout with NO trailing newline and no formatting, because
// `verifySshApprovalSignature` hashes these bytes exactly. Anything appended changes the
// digest and the signature will not verify.
if (has('--print-payload')) {
  process.stdout.write(Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64'));
  process.exit(0);
}

// ── The rail gate. Checked BEFORE anything pasteable is printed ───────────────
//
// This is the lesson made structural: a tool must never emit a record that cannot
// possibly verify. If the rail is closed, say so by name and stop.
if (!PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED
  || String(PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS)
    !== 'approvable_after_independent_review') {
  fail('monetary_rail_closed',
    'PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED is '
    + `${PROPOSED_PVT9_APPROVAL_MANIFEST_SIGNING_PERMITTED} and approval_status is `
    + `"${PROPOSED_PVT9_APPROVAL_MANIFEST_APPROVAL_STATUS}".\n`
    + '  verifyCurrentPvtManifestApproval() therefore refuses unconditionally, and\n'
    + '  isValidMonetaryPolicyActivation() can never return true — no matter how well-formed\n'
    + '  the document is or how genuinely it was signed.\n'
    + '  This is step 0 in this file\'s header, and it is a DECISION, not a command.\n'
    + '  Precedents that open a narrow route without moving 704c1a2d…:\n'
    + '    src/core/pvt/policy/approved-genesis-activation-approval.ts\n'
    + '    src/core/pvt/policy/genesis-settlement-approval-manifest.ts');
}

const config = approvalVerifierConfigFromEnv();
if (config === null) {
  fail('verifier_config_absent',
    'FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY and FRANK_PVT_APPROVAL_SSH_KEY_SHA256 must both be set,\n'
    + '  so the printed record is bound to the identity the RELAY trusts. Without them this\n'
    + '  tool would print something that could never verify in production.');
}

const effectiveFrom = arg('--effective-from');
if (effectiveFrom === null) {
  fail('effective_from_required',
    '--effective-from <ISO-8601 UTC> is required. It FLOORS record time: any PE recorded\n'
    + '  before it stays record_only forever, so arming cannot reprice recorded work.');
}
const effectiveAtMs = Date.parse(effectiveFrom);
if (!Number.isSafeInteger(effectiveAtMs)) {
  fail('effective_from_unparseable', `could not parse "${effectiveFrom}" as an instant`);
}

const sigPath = arg('--signature');
if (sigPath === null) {
  fail('signature_required',
    '--signature <path to the ssh-keygen -Y sign output> is required (step 3).');
}
const armored = readFileSync(sigPath, 'utf8');
if (!armored.includes('BEGIN SSH SIGNATURE')) {
  fail('signature_not_sshsig', `${sigPath} does not look like an ssh-keygen -Y sign output`);
}

function embeddedPublicKeySha256(armoredSignature: string): string {
  const body = armoredSignature
    .replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Buffer.from(body, 'base64');
  // SSHSIG || uint32 version || string publickey
  let offset = 'SSHSIG'.length + 4;
  const length = bytes.readUInt32BE(offset);
  offset += 4;
  const blob = bytes.subarray(offset, offset + length);
  const algorithmLength = blob.readUInt32BE(0);
  const algorithm = blob.subarray(4, 4 + algorithmLength).toString('ascii');
  if (algorithm !== 'ssh-ed25519') throw new Error(`embedded key is ${algorithm}, not ed25519`);
  return decodeOpenSshEd25519PublicKey(
    `ssh-ed25519 ${blob.toString('base64')}`,
  ).sha256;
}

let publicKeySha256: string;
try {
  publicKeySha256 = embeddedPublicKeySha256(armored);
} catch (err) {
  fail('signature_undecodable', `could not recover the signing key from ${sigPath}: ${String(err)}`);
}

if (publicKeySha256 !== config.publicKeySha256) {
  fail('signature_key_mismatch',
    `the signature was produced by ${publicKeySha256}\n`
    + `  but the relay trusts   ${config.publicKeySha256}\n`
    + '  Both values printed deliberately: a mismatch here is the single most common way an\n'
    + '  arming record gets pasted and then silently refused in production.');
}

const document = {
  schema_version: 'pvt-monetary-policy-activation/v1',
  approval_status: 'approved_by_frank',
  approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
  approval_signature: {
    scheme: 'sshsig-ed25519',
    signer_identity: config.signerIdentity,
    namespace: config.namespace,
    public_key_sha256: publicKeySha256,
    armored_signature: armored,
  },
  policy_version: PROPOSED_MONETARY_POLICY_TEMPLATE.proposedPolicyVersion,
  policy_template_sha256: hashProposedMonetaryPolicyTemplate(),
  effective_at_ms: effectiveAtMs,
  effective_until_ms: null,
  activation_scope: 'record_and_settlement',
  automation_generated: false,
  activated_at_ms: effectiveAtMs,
  activated_by: 'frank',
};

// ── END-TO-END SELF-CHECK against the runtime's own validator ─────────────────
//
// Not decorative. The record is checked by the exact predicate production calls, so this
// tool cannot print a document that the relay would reject.
if (!isValidMonetaryPolicyActivation(document, config)) {
  fail('self_check_failed',
    'the assembled document does not satisfy isValidMonetaryPolicyActivation — the very\n'
    + '  predicate loadRuntimeMonetaryPolicy uses. Printing it would be printing a record that\n'
    + '  fails closed in production. Nothing pasteable emitted.');
}

console.log(`# VERIFIED against isValidMonetaryPolicyActivation — write to`);
console.log(`# ${MONETARY_POLICY_ACTIVATION_COLLECTION}/${MONETARY_POLICY_ACTIVATION_DOCUMENT}`);
console.log(`# effective ${new Date(effectiveAtMs).toISOString()} (${effectiveAtMs})`);
console.log(JSON.stringify(document, null, 2));
