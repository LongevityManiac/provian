#!/usr/bin/env tsx
/**
 * M4 — the ONE staged command that produces the REAL signature over the
 * successor Genesis settlement approval manifest.
 *
 * M3 built and committed that manifest as BYTES ONLY, because `op whoami`
 * blocks on interactive 1Password approval and no run may stall on it. This
 * script is the operator entry point that completes it: the operator runs it, approves
 * in 1Password, and it emits a verified SSHSIG over the exact committed bytes.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * **It does not emit the epoch-zero settlement policy event.** Signing bytes
 * and opening the settlement rail are two different acts, and only the second
 * is hard to take back. This script performs the first and stops. Everything
 * it writes is a local file that can be deleted.
 *
 * It sends no transaction, writes nothing to Firestore, mints nothing, settles
 * nothing, and changes no gate. `FROZEN_MANIFEST_SHA256` (704c1a2d) and the
 * Gate 1 artifact are untouched and unread by this path.
 *
 * ── KEY HANDLING ─────────────────────────────────────────────────────────
 * Same reviewed pattern as `wp12-genesis-activate.ts` `--op-item` takes a
 * 1Password REFERENCE, never a key. The key is read into a buffer, written to a
 * 0600 file inside a 0700 temp dir only because `ssh-keygen -Y sign` requires a
 * file, then zero-filled and unlinked in a `finally` on every path. It never
 * reaches argv, a log line, the output file, or the repository.
 *
 * NO EPHEMERAL KEY, AND THE REASON IS THE IDENTITY BINDING, NOT THE SIGNATURE
 * CHECK. This script has no key-generation path, but that alone proves nothing:
 * verifying a signature against its own public key is circular and succeeds for
 * ANY key. So the signing key's SHA-256 must match `--expect-key-sha256` or
 * `FRANK_PVT_APPROVAL_SSH_KEY_SHA256` (the value the relay verifies against),
 * and one of them is REQUIRED. `--allow-unbound-key` exists only to exercise
 * the tool; it prints a loud banner and stamps `signing_identity_bound: false`
 * into the artifact.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 * tsx provian-backend/scripts/m4-sign-settlement-manifest.ts \
 * --op-item 'op://<vault>/<item>/<field>' \
 * --out ~/provian-settlement-approval.signature.json
 *
 * --key-file <path> offline alternative for a key already on disk
 * --expect-key-sha256 sha256:<hex> the key this MUST be signed by (defaults
 * to FRANK_PVT_APPROVAL_SSH_KEY_SHA256; one is required)
 * --allow-unbound-key tool exercise only — signs without binding identity
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
  genesisSettlementApprovalManifestBytes,
} from '../src/core/pvt/policy/genesis-settlement-approval-manifest';
import {
  decodeOpenSshEd25519PublicKey,
  verifySshApprovalSignature,
} from '../src/core/pvt/policy/approval-signature';
import { decideSigningIdentityBinding } from '../src/core/pvt/policy/signing-identity-binding';

const NAMESPACE = 'provian-pvt-policy' as const;
const SIGNER_IDENTITY = 'frank' as const;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fail(message: string): never {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(1);
}

function isSignableKeyFile(keyPath: string): boolean {
  try {
    execFileSync('ssh-keygen', ['-y', '-f', keyPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

interface SignResult {
  armoredSignature: string;
  publicKeyLine: string;
  publicKeySha256: string;
}

function sign(messageBytes: Buffer): SignResult {
  const opItem = arg('--op-item');
  const keyFile = arg('--key-file');
  if (opItem === null && keyFile === null) {
    fail('supply --op-item op://<vault>/<item>/<field> (or --key-file <path>). '
      + 'This script has no key-generation path and will not sign with an ephemeral key.');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-settlement-sign-'));
  fs.chmodSync(dir, 0o700);
  const keyPath = path.join(dir, 'k');
  const messagePath = path.join(dir, 'm');
  try {
    if (opItem !== null) {
      try {
        execFileSync('op', ['whoami'], { stdio: 'pipe' });
      } catch {
        fail('op_cli_not_signed_in: run `eval $(op signin)` in this shell first, '
          + 'then re-run this command.');
      }
      // 1Password returns an SSHKEY field as PKCS#8 by default and
      // `ssh-keygen -Y sign` rejects PKCS#8 outright, so the `?ssh-format=openssh`
      // modifier is tried FIRST and the bare reference is the fallback.
      const candidates = opItem.includes('?')
        ? [opItem]
        : [`${opItem}?ssh-format=openssh`, opItem];
      const problems: string[] = [];
      let loaded = false;
      for (const reference of candidates) {
        let key: Buffer;
        try {
          key = execFileSync('op', ['read', reference], {
            stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
          });
        } catch {
          problems.push(`op read failed for ${reference}`);
          continue;
        }
        if (key.length === 0) { problems.push(`empty value at ${reference}`); continue; }
        fs.writeFileSync(keyPath, key, { mode: 0o600 });
        key.fill(0);
        if (isSignableKeyFile(keyPath)) { loaded = true; break; }
        problems.push(`${reference} is not an OpenSSH private key (ssh-keygen rejected it)`);
      }
      if (!loaded) fail(`could not load a signable private key. Tried: ${problems.join('; ')}`);
    } else {
      fs.copyFileSync(keyFile as string, keyPath);
      fs.chmodSync(keyPath, 0o600);
      if (!isSignableKeyFile(keyPath)) {
        fail('--key-file is not an OpenSSH private key (ssh-keygen rejected it). '
          + 'PKCS#8 cannot sign; convert with `ssh-keygen -p -f <key>`.');
      }
    }

    fs.writeFileSync(messagePath, messageBytes, { mode: 0o600 });
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', keyPath, '-n', NAMESPACE, messagePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const publicKeyLine = execFileSync('ssh-keygen', ['-y', '-f', keyPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8').trim();
    return {
      armoredSignature: fs.readFileSync(`${messagePath}.sig`, 'utf8'),
      publicKeyLine,
      publicKeySha256: decodeOpenSshEd25519PublicKey(publicKeyLine).sha256,
    };
  } finally {
    for (const f of [keyPath, messagePath, `${messagePath}.sig`]) {
      try {
        fs.writeFileSync(f, Buffer.alloc(fs.statSync(f).size, 0));
        fs.unlinkSync(f);
      } catch { /* already gone */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function main(): void {
  const out = arg('--out') ?? path.join(os.homedir(), 'provian-settlement-approval.signature.json');

  // 1. The bytes, from the module the READER consults — never re-read off disk
  //    by a path this script chose, so the signature cannot be over something
  //    other than what production would verify.
  const bytes = genesisSettlementApprovalManifestBytes();
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

  // 2. Fail closed if the bytes are not the pinned artifact.
  if (digest !== GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256) {
    fail(`manifest digest mismatch.\n  computed: ${digest}\n  pinned  : `
      + `${GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256}\n`
      + 'Refusing to sign bytes production will not accept.');
  }

  console.log('');
  console.log('Signing the Genesis settlement approval manifest');
  console.log(`  bytes      : ${bytes.length}`);
  console.log(`  digest     : ${digest}`);
  console.log(`  namespace  : ${NAMESPACE}`);
  console.log('  1Password will now prompt you to approve this read. Approve it.');
  console.log('');

  const signed = sign(bytes);

  // 3. BIND THE SIGNING IDENTITY *BEFORE* verifying.
  //
  //    Verifying a signature against ITS OWN public key is circular: it proves
  //    the bytes were signed by whoever signed them, which is true of any key,
  //    including a throwaway. The verification below is exactly that shape, so
  //    on its own it would let this script produce a "SIGNED and VERIFIED"
  //    artifact from an ephemeral key — which is the one thing it must not do.
  //
  //    The expected key comes from `--expect-key-sha256`, or from
  //    `FRANK_PVT_APPROVAL_SSH_KEY_SHA256` (the value the RELAY verifies
  //    against), and one of them is REQUIRED. `--allow-unbound-key` exists only
  //    so the tool itself can be exercised with a throwaway; it prints a loud
  //    banner and stamps the artifact so the output can never be mistaken for a
  //    production signature.
  const decision = decideSigningIdentityBinding({
    expectedFromFlag: arg('--expect-key-sha256'),
    expectedFromEnv: process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
    actualKeySha256: signed.publicKeySha256,
    allowUnbound: process.argv.includes('--allow-unbound-key'),
  });
  if (decision.verdict === 'refused_no_expected_key') {
    fail('no expected signing key. Pass --expect-key-sha256 sha256:<hex>, or set '
      + 'FRANK_PVT_APPROVAL_SSH_KEY_SHA256 in this shell (it is the value the relay '
      + 'verifies against, and it is public). Without it this script cannot tell your '
      + 'production key from a throwaway, and it will not pretend otherwise.');
  }
  if (decision.verdict === 'refused_key_mismatch') {
    fail(`SIGNING KEY MISMATCH — this is not the approval key.\n  expected: ${decision.expected}\n`
      + `  actual  : ${signed.publicKeySha256}`);
  }
  const expected = decision.expected;
  if (!decision.bound) {
    console.error('');
    console.error('  ############################################################');
    console.error('  # --allow-unbound-key: the signing identity was NOT bound. #');
    console.error('  # This output is a TOOL EXERCISE, not an approval.         #');
    console.error('  ############################################################');
    console.error('');
  }

  // 4. VERIFY the signature itself. Circular by construction (see above), so it
  //    catches a corrupt or truncated signature, never a wrong signer — the
  //    identity binding above is what does that.
  const verified = verifySshApprovalSignature(bytes, {
    scheme: 'sshsig-ed25519',
    signer_identity: SIGNER_IDENTITY,
    namespace: NAMESPACE,
    public_key_sha256: signed.publicKeySha256,
    armored_signature: signed.armoredSignature,
  }, {
    signerIdentity: SIGNER_IDENTITY,
    namespace: NAMESPACE,
    openSshPublicKey: signed.publicKeyLine,
    publicKeySha256: signed.publicKeySha256,
  });
  if (!verified) fail('the produced signature did NOT verify against its own public key.');

  fs.writeFileSync(out, `${JSON.stringify({
    schema_version: 'genesis-settlement-approval-signature/v1',
    // Stamped so a tool-exercise artifact can never be mistaken for an approval.
    signing_identity_bound: decision.bound,
    approval_manifest_sha256: digest,
    scheme: 'sshsig-ed25519',
    signer_identity: SIGNER_IDENTITY,
    namespace: NAMESPACE,
    public_key: signed.publicKeyLine,
    public_key_sha256: signed.publicKeySha256,
    armored_signature: signed.armoredSignature,
  }, null, 2)}\n`, { mode: 0o600 });

  console.log('SIGNED and VERIFIED.');
  console.log(`  output          : ${out}   (0600)`);
  console.log(`  signing key                        : ${signed.publicKeySha256}`);
  console.log(`  relay expects   : ${process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256 ?? '(not set in this shell)'}`);
  console.log('');
  console.log('  Verify it yourself, offline, with no trust in this script:');
  console.log(`    node -e "const b=require('fs').readFileSync('${out}','utf8');const j=JSON.parse(b);`
    + `require('fs').writeFileSync('/tmp/m4.sig',j.armored_signature);`
    + `require('fs').writeFileSync('/tmp/m4.pub',j.public_key+' frank');console.log(j.approval_manifest_sha256)"`);
  console.log(' printf \'%s frank\\n\' "$(jq -r.public_key ' + out + ')" > /tmp/m4.allowed');
  console.log('    tsx provian-backend/scripts/m4-sign-settlement-manifest.ts --verify ' + out);
  console.log('');
  console.log('  NOTHING WAS OPENED. This produced a signature over bytes. The epoch-zero');
  console.log('  settlement policy event still does not exist, so production still refuses');
  console.log('  settlement. Emitting that event is a separate, deliberate act.');
  console.log('');
}

/** Re-verify a previously produced signature file. Reads no key. */
function verifyOnly(file: string): void {
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    approval_manifest_sha256: string;
    public_key: string;
    public_key_sha256: string;
    armored_signature: string;
  };
  const bytes = genesisSettlementApprovalManifestBytes();
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const digestOk = digest === record.approval_manifest_sha256
    && digest === GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256;
  const sigOk = verifySshApprovalSignature(bytes, {
    scheme: 'sshsig-ed25519',
    signer_identity: SIGNER_IDENTITY,
    namespace: NAMESPACE,
    public_key_sha256: record.public_key_sha256,
    armored_signature: record.armored_signature,
  }, {
    signerIdentity: SIGNER_IDENTITY,
    namespace: NAMESPACE,
    openSshPublicKey: record.public_key,
    publicKeySha256: record.public_key_sha256,
  });
  // The signature check above is circular (own key as its own verifier), so it
  // proves integrity, not identity. Identity is this comparison, and its
  // absence is reported rather than hidden.
  const idDecision = decideSigningIdentityBinding({
    expectedFromFlag: arg('--expect-key-sha256'),
    expectedFromEnv: process.env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
    actualKeySha256: record.public_key_sha256,
    allowUnbound: false,
  });
  const identityOk = idDecision.verdict === 'refused_no_expected_key' ? null : idDecision.bound;

  console.log('');
  console.log(`  digest matches the pinned manifest : ${digestOk}`);
  console.log(`  signature is intact over those bytes: ${sigOk}   (integrity, NOT identity)`);
  console.log(`  signing key                        : ${record.public_key_sha256}`);
  console.log(`  signing key is the EXPECTED one    : ${identityOk === null ? 'UNKNOWN — no expected key supplied' : identityOk}`);
  console.log('');
  if (!digestOk || !sigOk || identityOk === false || identityOk === null) process.exit(1);
}

// Only auto-run when invoked as a script, so the pure decision above is
// importable by its test without signing anything.
if (require.main === module) {
  const verifyTarget = arg('--verify');
  if (verifyTarget !== null) verifyOnly(verifyTarget);
  else main();
}
