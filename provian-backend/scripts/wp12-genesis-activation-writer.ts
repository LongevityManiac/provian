#!/usr/bin/env tsx
/**
 * activation — the Genesis runtime activation document writer.
 *
 * WHAT IT DOES
 * --dry-run (DEFAULT) assemble and print the COMPLETE UNSIGNED document plus
 * the named gate verdict. Touches no key, no network, no
 * Firestore.
 * --op-item <ref> read the policy setter approval signing key from the 1Password
 * CLI, sign the EXACT approval-manifest bytes, and
 * re-run the gate on the signed document.
 *
 * IT NEVER WRITES. There is exactly ONE production writer,
 * `wp12-genesis-activate.ts`. Two paths that can both create the activation
 * document is two places for the pre-flight to drift, so this one determines and
 * pre-flights only.
 *
 * WHY THE PRE-FLIGHT IS MANDATORY. A document that the persist gate refuses is
 * indistinguishable in Firestore from one it accepts; it simply sits there and
 * every qualifying act is silently retained instead of granted. Writing an
 * unverifiable activation document is the failure mode, not the fallback. So the
 * writer runs the REAL gate first and refuses to write anything it would refuse.
 *
 * KEY HANDLING — the private key never reaches argv, a log line, the receipt, or
 * any committed file. `--op-item` takes a REFERENCE (`op://vault/item/field`),
 * not a key. The key is read from `op` on stdout into a buffer, written to a
 * 0600 file under an owner-only temp directory purely because `ssh-keygen -Y
 * sign` requires a file, then overwritten and unlinked in a `finally`. Nothing
 * derived from it is printed except the resulting public signature.
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  shouldPersistGenesisQualification,
} from '../src/core/pvt/genesis-award-state-machine';
import {
  buildGenesisActivationDocument,
  describeGenesisActivationRefusal,
  explainGenesisActivationRefusal,
} from '../src/core/pvt/genesis-activation-document';
import {
  approvalVerifierConfigFromEnv,
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
} from '../src/core/pvt/policy/approval-signature';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64 } from '../src/core/pvt/policy/pvt9-approval-manifest.generated';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../src/core/pvt/policy/proposed-genesis-policy';
import { APPROVED_GENESIS_ACTIVATION } from '../src/core/pvt/policy/approved-genesis-activation-approval';
import type { GenesisCampaignActivation } from '../src/core/pvt/policy/genesis-policy-engine';

export const APPROVAL_SSHSIG_NAMESPACE = 'provian-pvt-policy' as const;

interface Args {
  readonly opItem: string | null;
  readonly frankApprovalAuditId: string;
  readonly operatorActivationAuditId: string;
  readonly canonicalPvtManifestId: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  return {
    opItem: value('--op-item'),
    frankApprovalAuditId: value('--frank-audit-id') ?? 'wp12-genesis-activation-frank',
    operatorActivationAuditId: value('--operator-audit-id') ?? 'wp12-genesis-activation-operator',
    // The ONE id the approved Genesis record authorizes. A different id is a
    // scope mismatch and the pre-flight refuses it.
    canonicalPvtManifestId: value('--canonical-manifest-id')
      ?? APPROVED_GENESIS_ACTIVATION.approved.canonical_pvt_manifest_id,
  };
}

/** The exact bytes every approval signature is taken over. */
export function approvalManifestBytes(): Buffer {
  return Buffer.from(PROPOSED_PVT9_APPROVAL_MANIFEST_UTF8_BASE64, 'base64');
}

/**
 * Sign the approval-manifest bytes with a key read from the 1Password CLI.
 *
 * The key lives in a buffer and in one 0600 file inside a 0700 temp directory,
 * and both are destroyed in the `finally` regardless of outcome. No branch of
 * this function prints, returns, or stores key material.
 */
export function signWithOpKey(
  opReference: string,
  messageBytes: Buffer,
): SshApprovalSignature {
  let signedIn = true;
  try {
    execFileSync('op', ['whoami'], { stdio: 'pipe' });
  } catch {
    signedIn = false;
  }
  if (!signedIn) {
    throw new Error(
      'op_cli_not_signed_in: run `eval $(op signin)` in this shell first. The '
      + 'writer never accepts key material on the command line.',
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvt9-approval-'), { });
  fs.chmodSync(dir, 0o700);
  const keyPath = path.join(dir, 'k');
  const messagePath = path.join(dir, 'm');
  try {
    const key = execFileSync('op', ['read', opReference], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    if (key.length === 0) throw new Error('op_read_returned_empty');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    key.fill(0);
    fs.writeFileSync(messagePath, messageBytes, { mode: 0o600 });
    execFileSync('ssh-keygen', [
      '-Y', 'sign', '-q',
      '-f', keyPath,
      '-n', APPROVAL_SSHSIG_NAMESPACE,
      messagePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const armored = fs.readFileSync(`${messagePath}.sig`, 'utf8');

    // The PUBLIC key is derived from the same file (public, safe to read) so the
    // signature's key commitment is self-consistent rather than hand-supplied.
    const pub = execFileSync('ssh-keygen', ['-y', '-f', keyPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8').trim();
    return {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: APPROVAL_SSHSIG_NAMESPACE,
      public_key_sha256: decodeOpenSshEd25519PublicKey(pub).sha256,
      armored_signature: armored,
    };
  } finally {
    for (const file of [keyPath, messagePath, `${messagePath}.sig`]) {
      try {
        const size = fs.statSync(file).size;
        fs.writeFileSync(file, Buffer.alloc(size, 0));
        fs.unlinkSync(file);
      } catch { /* already gone */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

/** Canonical JSON for printing. Never includes key material — a signature is public. */
function printDocument(label: string, doc: GenesisCampaignActivation): void {
  console.log(`\n--- ${label} (${Object.keys(doc).length} keys) ---`);
  console.log(JSON.stringify(doc, null, 2));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const window = PROPOSED_GENESIS_CAMPAIGN_POLICY.window;

  // UNKNOWN = BLOCK. `start_ms`/`end_ms` are `number | null` by design — null until a window is
  // separately approved — and this tool had assumed them non-null. Surfaced the moment `scripts/`
  // entered typecheck; before that the compiler never looked at this file. With an unset window
  // it printed `Invalid Date` and then passed `null` into `shouldPersistGenesisQualification` as
  // a timestamp, so the real gate would have been consulted about a document whose window does
  // not exist. Refuse instead: an unapproved window is not a zero window.
  if (window.start_ms === null || window.end_ms === null) {
    console.error('REFUSING: the approved Genesis window is not set '
      + `(start_ms=${window.start_ms}, end_ms=${window.end_ms}). `
      + 'There is nothing to sign and no timestamp to evaluate against.');
    return 1;
  }

  console.log('=== activation Genesis runtime activation document writer ===');
  console.log(`collection/doc : ${GENESIS_ACTIVATION_COLLECTION}/${GENESIS_ACTIVATION_DOCUMENT}`);
  console.log(`approved window: ${new Date(window.start_ms).toISOString()}`
    + ` → ${new Date(window.end_ms).toISOString()}`);
  console.log(`verifier key configured (env): ${approvalVerifierConfigFromEnv() !== null}`);
  console.log(`mode           : ${args.opItem === null ? 'DRY RUN (no key)' : 'SIGN'} (never writes)`);

  const unsigned = buildGenesisActivationDocument({
    frankApprovalAuditId: args.frankApprovalAuditId,
    operatorActivationAuditId: args.operatorActivationAuditId,
    canonicalPvtManifestId: args.canonicalPvtManifestId,
    approvalSignature: null,
  });
  printDocument('UNSIGNED DOCUMENT', unsigned);
  const manifestBytes = approvalManifestBytes();
  console.log(`\napproval-manifest bytes to sign: ${manifestBytes.length}`
    + ` (sha256:${crypto.createHash('sha256').update(manifestBytes).digest('hex')})`);
  console.log(`sshsig namespace: ${APPROVAL_SSHSIG_NAMESPACE}, signer identity: frank`);

  const unsignedVerdict = explainGenesisActivationRefusal(unsigned);
  console.log(`\nUNSIGNED verdict: ${unsignedVerdict.verdict}`);
  console.log(`  ${describeGenesisActivationRefusal(unsignedVerdict)}`);

  if (args.opItem === null) {
    console.log('\nDRY RUN complete. No key was read, nothing was signed, nothing was written.');
    return 0;
  }

  const signed: GenesisCampaignActivation = {
    ...unsigned,
    approval_signature: signWithOpKey(args.opItem, manifestBytes),
  };
  printDocument('SIGNED DOCUMENT', signed);

  const verdict = explainGenesisActivationRefusal(signed);
  console.log(`\nPRE-FLIGHT verdict: ${verdict.verdict}`);
  console.log(`  ${describeGenesisActivationRefusal(verdict)}`);

  if (verdict.verdict !== 'admits') {
    console.error('\nREFUSING TO WRITE. The persist gate would refuse this document, so writing '
      + 'it would leave Genesis silently inert while appearing armed.');
    return 1;
  }
  // Second, independent confirmation through the REAL call-site predicate, not
  // just the explainer, so a bug in the explainer cannot authorize a write.
  const admits = shouldPersistGenesisQualification(
    'genesis_human_signup', window.start_ms, signed,
  );
  console.log(`shouldPersistGenesisQualification (real gate): ${admits}`);
  if (!admits) {
    console.error('\nREFUSING TO WRITE: explainer and gate disagree. Fail closed.');
    return 1;
  }
  // THIS TOOL DOES NOT WRITE. There is exactly ONE production writer —
  // `wp12-genesis-activate.ts` — because two paths that can both create the
  // activation document is two places for the pre-flight to drift. This one
  // determines and pre-flights; that one signs, verifies live, and commits.
  console.log('\nADMITTED. This tool never writes — run the single writer:');
  console.log(' npx tsx scripts/wp12-genesis-activate.ts --op-item <ref> --commit');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
