#!/usr/bin/env tsx
/** Embed only an independently verified signature over this tree's exact scope.
 * The private approval key remains in the SSH agent. */
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { verifySshApprovalSignature } from '../src/core/pvt/policy/approval-signature';
import { APPROVED_MONETARY_ACTIVATION_SIGNATURE, monetaryApprovalSigningBytes } from '../src/core/pvt/policy/approved-monetary-activation-approval';
import { APPROVED_GENESIS_ACTIVATION_SIGNATURE, genesisApprovalSigningBytes } from '../src/core/pvt/policy/approved-genesis-activation-approval';

const [scope, signaturePath, ...extra] = process.argv.slice(2);
if ((scope !== 'monetary' && scope !== 'genesis') || !signaturePath?.endsWith('.sig') || extra.length) throw Error('usage: policy-signature-embed.ts monetary|genesis EXACT_BYTES.sig');
const bytes = scope === 'monetary' ? monetaryApprovalSigningBytes() : genesisApprovalSigningBytes();
const prior = scope === 'monetary' ? APPROVED_MONETARY_ACTIVATION_SIGNATURE : APPROVED_GENESIS_ACTIVATION_SIGNATURE;
if (!readFileSync(signaturePath.slice(0, -4)).equals(bytes)) throw Error('policy_signature_source_changed');
const signature = { ...prior, armored_signature: readFileSync(signaturePath, 'utf8') };
const verifier = { signerIdentity: prior.signer_identity, namespace: prior.namespace, publicKeySha256: prior.public_key_sha256,
  openSshPublicKey: readFileSync(resolve(homedir(), '.ssh/provian-pvt-policy.pub'), 'utf8') };
if (!verifySshApprovalSignature(bytes, signature, verifier)
  || verifySshApprovalSignature(Buffer.concat([bytes, Buffer.from('altered')]), signature, verifier)) throw Error('policy_signature_unverified');
const target = resolve(__dirname, `../src/core/pvt/policy/approved-${scope}-activation-approval.ts`);
const source = readFileSync(target, 'utf8');
const pattern = /("armored_signature"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
if ([...source.matchAll(pattern)].length !== 1) throw Error('policy_signature_embedding_ambiguous');
writeFileSync(target, source.replace(pattern, (_match, prefix: string) => prefix + JSON.stringify(signature.armored_signature)));
console.log(`${scope} signature verified and embedded; production activation unchanged.`);
