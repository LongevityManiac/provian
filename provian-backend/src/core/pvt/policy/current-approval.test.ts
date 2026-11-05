import fs from 'fs';
import path from 'path';
import type { Firestore } from 'firebase-admin/firestore';

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  decodeOpenSshEd25519PublicKey,
  type SshApprovalSignature,
  type SshApprovalVerifierConfig,
} from './approval-signature';
import {
  PVT_APPROVAL_MANIFEST_BYTES_COLLECTION,
  approvalManifestSha256,
  resolveApprovalManifestBytesByHash,
  verifyPvtManifestApprovalByHash,
} from './current-approval';
import {
  PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
} from './pvt9-approval-manifest.generated';

const fixtureDir = path.join(__dirname, '__fixtures__', 'approval');
const manifest = (name: 'a' | 'b') =>
  fs.readFileSync(path.join(fixtureDir, `manifest-${name}.json`));
const publicKey = fs.readFileSync(path.join(fixtureDir, 'fixture-key.pub'), 'utf8').trim();
const publicKeySha256 = decodeOpenSshEd25519PublicKey(publicKey).sha256;
const config: SshApprovalVerifierConfig = {
  signerIdentity: 'frank',
  namespace: 'provian-pvt-policy',
  openSshPublicKey: publicKey,
  publicKeySha256,
};
const signature = (name: 'a' | 'b'): SshApprovalSignature => ({
  scheme: 'sshsig-ed25519',
  signer_identity: 'frank',
  namespace: 'provian-pvt-policy',
  public_key_sha256: publicKeySha256,
  armored_signature: fs.readFileSync(
    path.join(fixtureDir, `manifest-${name}.json.sig`),
    'utf8',
  ),
});

async function register(
  fake: ReturnType<typeof createFakeFirestore>,
  name: 'a' | 'b',
): Promise<string> {
  const bytes = manifest(name);
  const hash = approvalManifestSha256(bytes);
  await fake.collection(PVT_APPROVAL_MANIFEST_BYTES_COLLECTION)
    .doc(hash.slice('sha256:'.length))
    .set({
      schema_version: 'pvt-approval-manifest-bytes/v1',
      approval_manifest_sha256: hash,
      manifest_utf8_base64: bytes.toString('base64'),
      registered_at_ms: 1,
      registered_by: 'fixture',
    });
  return hash;
}

describe('approval manifest bytes resolved by event hash', () => {
  it('verifies each genuine manifest independently and rejects A-signature/B-hash substitution', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const hashA = await register(fake, 'a');
    const hashB = await register(fake, 'b');
    const resolver = (hash: string) => resolveApprovalManifestBytesByHash(db, hash);

    await expect(verifyPvtManifestApprovalByHash(hashA, signature('a'), resolver, config))
      .resolves.toBe(true);
    await expect(verifyPvtManifestApprovalByHash(hashB, signature('b'), resolver, config))
      .resolves.toBe(true);
    await expect(verifyPvtManifestApprovalByHash(hashB, signature('a'), resolver, config))
      .resolves.toBe(false);
    await expect(verifyPvtManifestApprovalByHash(hashA, signature('b'), resolver, config))
      .resolves.toBe(false);
  });

  it('rejects unknown hashes, malformed registry bytes, and the non-signable current manifest', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const resolver = (hash: string) => resolveApprovalManifestBytesByHash(db, hash);
    await expect(verifyPvtManifestApprovalByHash(
      `sha256:${'f'.repeat(64)}`,
      signature('a'),
      resolver,
      config,
    )).resolves.toBe(false);
    await expect(verifyPvtManifestApprovalByHash(
      PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
      signature('a'),
      resolver,
      config,
    )).resolves.toBe(false);

    const hashA = approvalManifestSha256(manifest('a'));
    await fake.collection(PVT_APPROVAL_MANIFEST_BYTES_COLLECTION)
      .doc(hashA.slice('sha256:'.length))
      .set({
        schema_version: 'pvt-approval-manifest-bytes/v1',
        approval_manifest_sha256: hashA,
        manifest_utf8_base64: Buffer.from('different bytes').toString('base64'),
        registered_at_ms: 1,
        registered_by: 'fixture',
      });
    await expect(resolver(hashA)).resolves.toBeNull();
  });
});
