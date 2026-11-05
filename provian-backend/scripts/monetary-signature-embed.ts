#!/usr/bin/env tsx
/**
 * Embed a freshly produced SSHSIG into APPROVED_MONETARY_ACTIVATION_SIGNATURE — the
 * mechanical half of a monetary template re-pin (and any later one).
 *
 * It REFUSES unless all of these hold, so a wrong or stale signature can never be pasted:
 * 1. `ssh-keygen -Y check-novalidate` accepts the.sig over the handoff signing bytes
 * in namespace `provian-pvt-policy` with the public key file given (default
 * ~/.ssh/provian-pvt-policy.pub);
 * 2. the handoff bytes are byte-identical to `monetaryApprovalSigningBytes()` of THIS tree
 * (so the signature is over the live digest, not a stale file);
 * 3. the public key's blob digests to the `public_key_sha256` the record already declares
 * (`sha256:200b11f0…`) — the same trust the relay is configured with (never
 * verify against a key the signature brought along).
 * Then it rewrites ONLY the `armored_signature: [...]` array in
 * approved-monetary-activation-approval.ts. Nothing else moves; it holds no key.
 *
 * Usage: npx tsx scripts/monetary-signature-embed.ts <path/to/signing-bytes.txt.sig> [pubkey.pub]
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  APPROVED_MONETARY_ACTIVATION_SIGNATURE,
  monetaryApprovalSigningBytes,
  monetaryApprovalSigningDigest,
} from '../src/core/pvt/policy/approved-monetary-activation-approval';

const sigPath = process.argv[2];
const pubPath = process.argv[3] ?? path.join(os.homedir(), '.ssh', 'provian-pvt-policy.pub');
if (!sigPath) {
  console.error('usage: monetary-signature-embed.ts <signing-bytes.txt.sig> [pubkey.pub]');
  process.exit(2);
}
const bytesPath = sigPath.replace(/\.sig$/, '');
const targetPath = path.resolve(__dirname, '../src/core/pvt/policy/approved-monetary-activation-approval.ts');

// (2) the handoff bytes ARE this tree's scope bytes.
const handoff = fs.readFileSync(bytesPath);
if (!handoff.equals(monetaryApprovalSigningBytes())) {
  console.error(`REFUSED: ${bytesPath} is not byte-identical to monetaryApprovalSigningBytes() (${monetaryApprovalSigningDigest()}). Regenerate the handoff from this tree first.`);
  process.exit(1);
}
// (3) the public key is the one the record (and the relay) trusts.
const pubLine = fs.readFileSync(pubPath, 'utf8').trim();
const blob = Buffer.from(pubLine.split(/\s+/)[1], 'base64');
const blobSha = `sha256:${crypto.createHash('sha256').update(blob).digest('hex')}`;
if (blobSha !== APPROVED_MONETARY_ACTIVATION_SIGNATURE.public_key_sha256) {
  console.error(`REFUSED: ${pubPath} digests to ${blobSha}, record declares ${APPROVED_MONETARY_ACTIVATION_SIGNATURE.public_key_sha256}.`);
  process.exit(1);
}
// (1) the signature verifies over those bytes, in the right namespace, with that key.
try {
  const out = execFileSync('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'provian-pvt-policy', '-f', pubPath, '-s', sigPath], {
    input: handoff, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(out.trim());
} catch (e) {
  console.error(`REFUSED: ssh-keygen did not accept the signature: ${(e as { stderr?: string }).stderr ?? (e as Error).message}`);
  process.exit(1);
}
const armored = fs.readFileSync(sigPath, 'utf8');
const lines = armored.replace(/\n$/, '').split('\n');
if (lines[0] !== '-----BEGIN SSH SIGNATURE-----' || lines[lines.length - 1] !== '-----END SSH SIGNATURE-----') {
  console.error('REFUSED: not an armored SSH signature');
  process.exit(1);
}
const rendered = [...lines, ''].map((l) => `    '${l}',`).join('\n');
const src = fs.readFileSync(targetPath, 'utf8');
const re = /  armored_signature: \[\n[\s\S]*?\n  \]\.join\('\\n'\),/;
if (!re.test(src)) {
  console.error('REFUSED: could not find the armored_signature block to replace');
  process.exit(1);
}
fs.writeFileSync(targetPath, src.replace(re, `  armored_signature: [\n${rendered}\n  ].join('\\n'),`));
console.log(`embedded ${sigPath} into ${path.relative(process.cwd(), targetPath)} (signing digest ${monetaryApprovalSigningDigest()})`);
