#!/usr/bin/env tsx
/** Prepare exact membership-rule bytes or verify an SSH-agent signature into a
 * publishable record. This tool never reads a private key or sends a transaction. */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { recourseMembershipSigningBytes, recourseMembershipRuleHash, parseRecourseMembershipRule,
  verifyRecourseMembershipRule } from '../src/core/recourse/membership-rule';
import { decodeOpenSshEd25519PublicKey, type SshApprovalSignature } from '../src/core/pvt/policy/approval-signature';
import { APPROVED_MONETARY_ACTIVATION_SIGNATURE } from '../src/core/pvt/policy/approved-monetary-activation-approval';
import { PROTOCOL_POINTER_PIN } from '../src/core/protocol/pointer-pin.generated';

const [mode, source, output, signaturePath] = process.argv.slice(2);
if (!['prepare', 'verify'].includes(mode) || !source || !output || (mode === 'verify' && !signaturePath)) {
  throw new Error('usage: recourse-membership-rule.ts prepare|verify rule.json output [signature]');
}
if (!PROTOCOL_POINTER_PIN.address) throw new Error('protocol_pointer_not_deployed');
const rule = parseRecourseMembershipRule(JSON.parse(readFileSync(resolve(source), 'utf8')));
if (rule.pointer !== PROTOCOL_POINTER_PIN.address.toLowerCase()) throw new Error('recourse_rule_pointer_mismatch');
const bytes = recourseMembershipSigningBytes(rule);
if (mode === 'prepare') {
  writeFileSync(resolve(output), bytes);
} else {
  const openSshPublicKey = readFileSync(resolve(homedir(), '.ssh/provian-pvt-policy.pub'), 'utf8').trim();
  const publicKeySha256 = decodeOpenSshEd25519PublicKey(openSshPublicKey).sha256;
  if (publicKeySha256 !== APPROVED_MONETARY_ACTIVATION_SIGNATURE.public_key_sha256) throw new Error('recourse_rule_public_key_mismatch');
  const signature: SshApprovalSignature = { scheme: 'sshsig-ed25519', signer_identity: 'frank', namespace: 'provian-pvt-policy',
    public_key_sha256: publicKeySha256, armored_signature: readFileSync(resolve(signaturePath), 'utf8') };
  const record = verifyRecourseMembershipRule({ rule, ruleHash: recourseMembershipRuleHash(rule), signature },
    PROTOCOL_POINTER_PIN.address, { signerIdentity: 'frank', namespace: 'provian-pvt-policy', openSshPublicKey, publicKeySha256 });
  writeFileSync(resolve(output), `${JSON.stringify(record, null, 2)}\n`);
}
console.log(JSON.stringify({ ruleHash: recourseMembershipRuleHash(rule), mode }));
