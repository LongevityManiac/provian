/**
 * Provian Commons - Artifacts
 *
 * The construction surface where agents build tools other agents use.
 * Artifacts are reusable components (tools, protocols, schemas, research,
 * services, templates) published to the Commons. Visibility is earned
 * through invocations, human attestations, and PVT staking.
 */

import { v4 as uuidv4 } from 'uuid';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type ArtifactType,
  type CommonsArtifact,
  type CommonsArtifactAttestation,
  type CommonsArtifactInvocation,
  type CreateArtifactRequest,
  type UpdateArtifactRequest,
  type AttestArtifactRequest,
  type InvokeArtifactRequest,
} from './types';

const L = COMMONS_SAFETY_LIMITS;

const VALID_ARTIFACT_TYPES: ReadonlySet<ArtifactType> = new Set([
  'tool', 'protocol', 'schema', 'research', 'service', 'template',
]);

const VALID_SORT_OPTIONS = new Set(['rising', 'popular', 'new']);

// ─── Visibility Score ──────────────────────────────────────────────────────

function computeVisibilityScore(artifact: {
  invocation_count: number;
  human_attestation_count: number;
  stake_pvt: number;
}): number {
  return (artifact.invocation_count * 0.1)
    + (artifact.human_attestation_count * 50)
    + (artifact.stake_pvt * 2);
}

// ─── Create Artifact ───────────────────────────────────────────────────────

export async function createArtifact(
  deps: CommonsDeps,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: CreateArtifactRequest,
): Promise<CommonsArtifact> {
  // Rate limit: 10 creates per hour
  const rl = await deps.cache.checkRateLimit(
    `rl:commons:artifact:create:${walletId}`,
    L.ARTIFACT_CREATE_RATE_LIMIT_PER_HOUR,
    3600,
  );
  if (!rl.allowed) {
    throw new ValidationError(`Rate limit exceeded. Retry after ${rl.retryAfter}s`);
  }

  // Verify Commons profile
  const profileDoc = await deps.db
    .collection(COMMONS_COLLECTIONS.PROFILES)
    .doc(walletId)
    .get();
  if (!profileDoc.exists) {
    throw new ForbiddenError('Must be registered on the Commons to publish artifacts');
  }

  // Validate type
  if (!body.type || !VALID_ARTIFACT_TYPES.has(body.type)) {
    throw new ValidationError(`Invalid artifact type. Must be one of: ${[...VALID_ARTIFACT_TYPES].join(', ')}`);
  }

  // Validate name
  if (!body.name || body.name.trim().length === 0) {
    throw new ValidationError('Name is required');
  }
  if (body.name.length > L.MAX_ARTIFACT_NAME_LENGTH) {
    throw new ValidationError(`Name must be ${L.MAX_ARTIFACT_NAME_LENGTH} characters or fewer`);
  }

  // Validate description
  if (!body.description || body.description.trim().length === 0) {
    throw new ValidationError('Description is required');
  }
  if (body.description.length > L.MAX_ARTIFACT_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description must be ${L.MAX_ARTIFACT_DESCRIPTION_LENGTH} characters or fewer`);
  }

  // Validate version
  if (!body.version || body.version.trim().length === 0) {
    throw new ValidationError('Version is required');
  }

  // Validate content_hash
  if (!body.content_hash || body.content_hash.trim().length === 0) {
    throw new ValidationError('Content hash is required');
  }

  // Validate tags
  const tags = body.tags ?? [];
  if (tags.length > L.MAX_ARTIFACT_TAGS_COUNT) {
    throw new ValidationError(`Maximum ${L.MAX_ARTIFACT_TAGS_COUNT} tags allowed`);
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > L.MAX_ARTIFACT_TAG_LENGTH) {
      throw new ValidationError(`Each tag must be 1-${L.MAX_ARTIFACT_TAG_LENGTH} characters`);
    }
  }

  // Validate stake
  const stakePvt = body.stake_pvt ?? 0;
  if (stakePvt < 0) {
    throw new ValidationError('Stake cannot be negative');
  }

  // Check max artifacts per wallet - single where clause, filter deprecated in memory
  const existingSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .where('creator_wallet_id', '==', walletId)
    .get();
  const activeCount = existingSnap.docs.filter(d => d.data().deprecated === false).length;
  if (activeCount >= L.MAX_ARTIFACTS_PER_WALLET) {
    throw new ValidationError(`Maximum ${L.MAX_ARTIFACTS_PER_WALLET} active artifacts per wallet`);
  }

  const now = Date.now();
  const artifactId = `artifact_${uuidv4()}`;

  // Generate PE
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_artifact_created',
    metadata: {
      artifact_id: artifactId,
      type: body.type,
      name: body.name,
      version: body.version,
      content_hash: body.content_hash,
      stake_pvt: stakePvt,
      tags,
    },
  });

  const artifact: CommonsArtifact = {
    artifact_id: artifactId,
    creator_wallet_id: walletId,
    creator_user_id: agentId,
    type: body.type,
    name: body.name.trim(),
    description: body.description.trim(),
    version: body.version.trim(),
    content_hash: body.content_hash.trim(),
    source_url: body.source_url?.trim(),
    interface_schema: body.interface_schema,
    tags: tags.map(t => t.trim().toLowerCase()),
    stake_pvt: stakePvt,
    stake_locked_until: stakePvt > 0 ? now + (90 * 24 * 60 * 60 * 1000) : undefined,
    allow_crypto: false,
    created_at: now,
    updated_at: now,
    pe_id: peId,
    invocation_count: 0,
    unique_invoker_count: 0,
    human_attestation_count: 0,
    visibility_score: computeVisibilityScore({
      invocation_count: 0,
      human_attestation_count: 0,
      stake_pvt: stakePvt,
    }),
    deprecated: false,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .set(artifact);

  return artifact;
}

// ─── Get Artifact ──────────────────────────────────────────────────────────

export async function getArtifact(
  deps: CommonsDeps,
  artifactId: string,
): Promise<CommonsArtifact> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Artifact not found');
  }
  return doc.data() as CommonsArtifact;
}

// ─── List Artifacts ────────────────────────────────────────────────────────

export async function listArtifacts(
  deps: CommonsDeps,
  filters: {
    type?: string;
    tags?: string[];
    sort?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{ artifacts: CommonsArtifact[]; next_cursor?: string }> {
  const sort = filters.sort && VALID_SORT_OPTIONS.has(filters.sort) ? filters.sort : 'popular';
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);

  // Simple query only - no compound where + orderBy to avoid composite index requirements.
  // Fetch up to 500 docs, then filter and sort in memory.
  const MAX_FETCH = 500;
  const snapshot = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .limit(MAX_FETCH)
    .get();

  let results = snapshot.docs
    .map(d => d.data() as CommonsArtifact)
    .filter(a => !a.deprecated);

  // Apply type filter in memory
  if (filters.type && VALID_ARTIFACT_TYPES.has(filters.type as ArtifactType)) {
    results = results.filter(a => a.type === filters.type);
  }

  // Apply tag filter in memory
  if (filters.tags && filters.tags.length > 0) {
    const tagFilter = filters.tags[0].toLowerCase();
    results = results.filter(a => a.tags.includes(tagFilter));
  }

  // Sort in memory
  if (sort === 'new') {
    results.sort((a, b) => b.created_at - a.created_at);
  } else if (sort === 'rising') {
    results.sort((a, b) => b.updated_at - a.updated_at);
  } else {
    // popular (default): by visibility score
    results.sort((a, b) => b.visibility_score - a.visibility_score);
  }

  // Cursor-based pagination (by artifact_id)
  if (filters.cursor) {
    const cursorIdx = results.findIndex(a => a.artifact_id === filters.cursor);
    if (cursorIdx >= 0) {
      results = results.slice(cursorIdx + 1);
    }
  }

  const page = results.slice(0, limit);
  const nextCursor = results.length > limit
    ? page[page.length - 1]?.artifact_id
    : undefined;

  return { artifacts: page, next_cursor: nextCursor };
}

// ─── Update Artifact ───────────────────────────────────────────────────────

export async function updateArtifact(
  deps: CommonsDeps,
  artifactId: string,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: UpdateArtifactRequest,
): Promise<CommonsArtifact> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Artifact not found');
  }

  const artifact = doc.data() as CommonsArtifact;
  if (artifact.creator_wallet_id !== walletId) {
    throw new ForbiddenError('Only the creator can update this artifact');
  }
  if (artifact.deprecated) {
    throw new ValidationError('Cannot update a deprecated artifact');
  }

  // Validate patch fields
  if (body.description !== undefined) {
    if (body.description.length === 0) {
      throw new ValidationError('Description cannot be empty');
    }
    if (body.description.length > L.MAX_ARTIFACT_DESCRIPTION_LENGTH) {
      throw new ValidationError(`Description must be ${L.MAX_ARTIFACT_DESCRIPTION_LENGTH} characters or fewer`);
    }
  }
  if (body.tags !== undefined) {
    if (body.tags.length > L.MAX_ARTIFACT_TAGS_COUNT) {
      throw new ValidationError(`Maximum ${L.MAX_ARTIFACT_TAGS_COUNT} tags allowed`);
    }
    for (const tag of body.tags) {
      if (typeof tag !== 'string' || tag.length === 0 || tag.length > L.MAX_ARTIFACT_TAG_LENGTH) {
        throw new ValidationError(`Each tag must be 1-${L.MAX_ARTIFACT_TAG_LENGTH} characters`);
      }
    }
  }

  const now = Date.now();

  // Generate PE
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_artifact_updated',
    metadata: {
      artifact_id: artifactId,
      previous_version: artifact.version,
      new_version: body.version ?? artifact.version,
      content_hash: body.content_hash ?? artifact.content_hash,
    },
  });

  const patch: Record<string, unknown> = {
    updated_at: now,
    pe_id: peId,
  };
  if (body.description !== undefined) patch.description = body.description.trim();
  if (body.version !== undefined) patch.version = body.version.trim();
  if (body.content_hash !== undefined) patch.content_hash = body.content_hash.trim();
  if (body.source_url !== undefined) patch.source_url = body.source_url?.trim();
  if (body.interface_schema !== undefined) patch.interface_schema = body.interface_schema;
  if (body.tags !== undefined) patch.tags = body.tags.map(t => t.trim().toLowerCase());

  await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .update(patch);

  return { ...artifact, ...patch } as CommonsArtifact;
}

// ─── Deprecate Artifact ────────────────────────────────────────────────────

export async function deprecateArtifact(
  deps: CommonsDeps,
  artifactId: string,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
): Promise<{ status: string }> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Artifact not found');
  }

  const artifact = doc.data() as CommonsArtifact;
  if (artifact.creator_wallet_id !== walletId) {
    throw new ForbiddenError('Only the creator can deprecate this artifact');
  }
  if (artifact.deprecated) {
    throw new ValidationError('Artifact is already deprecated');
  }

  const now = Date.now();

  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_artifact_deprecated',
    metadata: {
      artifact_id: artifactId,
      name: artifact.name,
      version: artifact.version,
    },
  });

  await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .update({
      deprecated: true,
      deprecated_at: now,
      deprecated_pe_id: peId,
      updated_at: now,
    });

  return { status: 'deprecated' };
}

// ─── Record Invocation ─────────────────────────────────────────────────────

export async function recordInvocation(
  deps: CommonsDeps,
  artifactId: string,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: InvokeArtifactRequest,
): Promise<{ invocation_id: string }> {
  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Artifact not found');
  }

  const artifact = doc.data() as CommonsArtifact;
  if (artifact.deprecated) {
    throw new ValidationError('Cannot invoke a deprecated artifact');
  }

  const now = Date.now();
  const invocationId = `inv_${uuidv4()}`;

  // NO PE. The relay neither performs nor observes an
  // artifact invocation — the invoker tells it one happened, and that is the only
  // evidence there is. An actor's own claim about its work is never a PE, so the
  // `commons_artifact_invoked` PE this used to generate is gone; the invocation
  // is still recorded as a Commons invocation (doc + counters). Already-sealed
  // invocation PEs are untouched. `agentId` / `actorAddress` stay in the
  // signature so the route's auth contract is unchanged.
  void agentId;
  void actorAddress;

  const invocation: CommonsArtifactInvocation = {
    invocation_id: invocationId,
    artifact_id: artifactId,
    invoker_wallet_id: walletId,
    source_pe_id: body.source_pe_id,
    created_at: now,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACT_INVOCATIONS)
    .doc(invocationId)
    .set(invocation);

  // Check if this is a new unique invoker
  const priorInvocations = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACT_INVOCATIONS)
    .where('artifact_id', '==', artifactId)
    .where('invoker_wallet_id', '==', walletId)
    .limit(2)
    .get();

  const isNewInvoker = priorInvocations.docs.length <= 1; // only the one we just wrote

  // Update artifact stats atomically
  const artifactRef = deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId);

  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(artifactRef);
    if (!snap.exists) return;
    const current = snap.data() as CommonsArtifact;

    const newInvocationCount = current.invocation_count + 1;
    const newUniqueInvokerCount = isNewInvoker
      ? current.unique_invoker_count + 1
      : current.unique_invoker_count;

    const newVisibility = computeVisibilityScore({
      invocation_count: newInvocationCount,
      human_attestation_count: current.human_attestation_count,
      stake_pvt: current.stake_pvt,
    });

    tx.update(artifactRef, {
      invocation_count: newInvocationCount,
      unique_invoker_count: newUniqueInvokerCount,
      visibility_score: newVisibility,
      updated_at: now,
    });
  });

  return { invocation_id: invocationId };
}

// ─── Attest Artifact ───────────────────────────────────────────────────────

export async function attestArtifact(
  deps: CommonsDeps,
  artifactId: string,
  walletId: string,
  agentId: string,
  actorAddress: string | null,
  body: AttestArtifactRequest,
): Promise<CommonsArtifactAttestation> {
  // Validate rating
  if (body.rating === undefined || body.rating < 1 || body.rating > 5 || !Number.isInteger(body.rating)) {
    throw new ValidationError('Rating must be an integer from 1 to 5');
  }

  const doc = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId)
    .get();
  if (!doc.exists) {
    throw new NotFoundError('Artifact not found');
  }

  const artifact = doc.data() as CommonsArtifact;

  // One attestation per human per artifact
  const existing = await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACT_ATTESTATIONS)
    .where('artifact_id', '==', artifactId)
    .where('human_wallet_id', '==', walletId)
    .limit(1)
    .get();
  if (!existing.empty) {
    throw new ValidationError('You have already attested to this artifact');
  }

  const now = Date.now();
  const attestationId = `attest_${uuidv4()}`;

  // Generate PE
  const { peId } = await generatePE(deps, {
    walletId,
    agentId,
    actorAddress,
    actionType: 'commons_artifact_attested',
    metadata: {
      artifact_id: artifactId,
      artifact_name: artifact.name,
      rating: body.rating,
    },
  });

  const attestation: CommonsArtifactAttestation = {
    attestation_id: attestationId,
    artifact_id: artifactId,
    pe_id: peId,
    human_wallet_id: walletId,
    rating: body.rating,
    comment: body.comment?.trim(),
    created_at: now,
  };

  await deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACT_ATTESTATIONS)
    .doc(attestationId)
    .set(attestation);

  // Update artifact stats atomically
  const artifactRef = deps.db
    .collection(COMMONS_COLLECTIONS.ARTIFACTS)
    .doc(artifactId);

  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(artifactRef);
    if (!snap.exists) return;
    const current = snap.data() as CommonsArtifact;

    const newAttestationCount = current.human_attestation_count + 1;
    const newVisibility = computeVisibilityScore({
      invocation_count: current.invocation_count,
      human_attestation_count: newAttestationCount,
      stake_pvt: current.stake_pvt,
    });

    tx.update(artifactRef, {
      human_attestation_count: newAttestationCount,
      visibility_score: newVisibility,
      updated_at: now,
    });
  });

  return attestation;
}
