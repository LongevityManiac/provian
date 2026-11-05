/**
 * canonical-agent-pe-chain — the chain read must tolerate FOREIGN agent_id-tagged
 * PEs that share the provenance_envelopes collection but are not chain members.
 *
 * Production incident (2026-08-19): a freshly-bootstrapped agent 500'd on
 * accept-invite (and would have on every chain read — beneficiary link, badges,
 * PVT minting) with `canonical_agent_pe_chain_integrity:pe_shape`. Cause: the
 * relay connect step (POST /v1/relay/agent/connect) writes an `agent_linked` PE
 * with integration_source 'relay_agent_connect' and a NON-canonical shape into
 * provenance_envelopes with the agent's agent_id. The `.where('agent_id','==',…)`
 * read pulled it in and strict-validated it → pe_shape. The onboarding-walk test
 * never caught it because it starts AFTER wallet creation and never exercises the
 * relay connect that writes that PE — the fixture population lacked the real doc.
 */

import { describe, it, expect } from '@jest/globals';
import {
  canonicalAgentPeHash,
  validateCanonicalAgentPeChainSnapshots,
  validateIdentityPeSnapshots,
  CanonicalAgentPeChainIntegrityError,
} from './canonical-agent-pe-chain';
import { deviceSubmitPeHash } from './device-submit-pe-hash';
import { identityPeFixture } from './__test-helpers__/identity-pe-fixture';

const AGENT = 'agent_test';
const WALLET = 'wallet_aw_test';
const ADDR = `0x${'1'.repeat(40)}`;

/** Build a canonical (agent_bank_generate_pe) stored PE with a correct hash. */
function mkCanonical(o: { id: string; timestamp: number; prev_hash: string; action_type: string }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: o.id, wallet_id: WALLET, agent_id: AGENT, user_id: AGENT,
    action_type: o.action_type, policy_action_type: o.action_type,
    actor_address: ADDR, timestamp: o.timestamp, created_at: o.timestamp,
    prev_hash: o.prev_hash, attestation_type: 'software',
    metadata: {}, compute: null, geo: null, execution_env: null,
    cited_pe_ids: null, parent_goal_pe_id: null,
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null, counterparty_type: null, session_lineage: null,
    self_referencing: false, trust_level_at_creation: null, durability: 'final',
  };
  return { ...base, hash: canonicalAgentPeHash(base) };
}

/**
 * Build a device_pe_submit stored PE (the unified-chain member) with a
 * correct hash. Mirrors routes/devices.ts buildSubmitStoredDoc: NO agent_id,
 * user_id==agentId, extra description/intent_text, hashed by deviceSubmitPeHash.
 */
function mkDevice(o: { id: string; timestamp: number; prev_hash: string; action_type: string; omitDescription?: boolean }): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: o.id, wallet_id: WALLET, action_type: o.action_type, actor_address: ADDR,
    timestamp: o.timestamp, prev_hash: o.prev_hash, attestation_type: 'software',
    description: 'tool turn', intent_text: 'tool turn',
    metadata: {
      source_device_id: 'dev1', source_device_name: 'Mini', source_tool: 'openclaw',
      owner_type: 'agent', attribution_model: 'device_owner',
    },
    compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
  };
  if (o.omitDescription) {
    // Mirror the writer's description-less case EXACTLY: buildPEContent sets
    // description/intent_text to undefined, stableStringify omits them from the
    // hash, and Firestore's ignoreUndefinedProperties strips them from the doc.
    delete content.description;
    delete content.intent_text;
  }
  return {
    ...content, hash: deviceSubmitPeHash(content as never), user_id: AGENT,
    policy_action_type: o.action_type, integration_source: 'device_pe_submit',
    counterparty_address: null, counterparty_type: null, session_lineage: null,
    self_referencing: false, trust_level_at_creation: null, created_at: o.timestamp,
    durability: 'final',
  };
}

/** The real relay-connect 'agent_linked' PE: same agent_id, foreign shape/source. */
function foreignConnectPe(id: string): Record<string, unknown> {
  return {
    id, agent_id: AGENT, action_type: 'agent_linked', type: 'agent_linked',
    integration_source: 'relay_agent_connect', status: 'connected', action_report: { ok: true },
  };
}

function snap(doc: Record<string, unknown>) {
  return { id: doc.id as string, exists: true, data: () => doc };
}

function tip(hash: string, updated_at: number) {
  return { exists: true, data: () => ({ hash, updated_at, user_id: AGENT }) };
}

describe('validateCanonicalAgentPeChainSnapshots — foreign agent_id PEs are not chain members', () => {
  const birth = mkCanonical({ id: 'pe_birth', timestamp: 1000, prev_hash: '0x0000', action_type: 'agent_wallet_created' });
  const child = mkCanonical({ id: 'pe_child', timestamp: 2000, prev_hash: birth.hash as string, action_type: 'agent_invite_sent' });

  it('RED CONTROL: a foreign relay-connect PE mixed in is IGNORED — the chain still validates (was pe_shape 500)', () => {
    const result = validateCanonicalAgentPeChainSnapshots({
      // deliberately interleave the foreign PE among the canonical ones
      peSnapshots: [snap(birth), snap(foreignConnectPe('pe_connect')), snap(child)],
      tipSnapshot: tip(child.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    });
    expect(result.pes.map((p) => p.id)).toEqual(['pe_child', 'pe_birth']); // tip first, foreign absent
    expect(result.peIds).not.toContain('pe_connect');
    expect(result.tipHash).toBe(child.hash);
  });

  it('a chain with NO foreign PEs still validates (control)', () => {
    const result = validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(child)],
      tipSnapshot: tip(child.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    });
    expect(result.pes.map((p) => p.id)).toEqual(['pe_child', 'pe_birth']);
  });

  it('INTEGRITY PRESERVED: a GENUINE member given a foreign source is skipped, breaking the walk (never hidden)', () => {
    // 3-link chain birth -> mid -> child; corrupt `mid` to a foreign source so it
    // is skipped. The walk from the tip then cannot find child's predecessor.
    const mid = mkCanonical({ id: 'pe_mid', timestamp: 1500, prev_hash: birth.hash as string, action_type: 'genesis_signup' });
    const child3 = mkCanonical({ id: 'pe_child3', timestamp: 2000, prev_hash: mid.hash as string, action_type: 'agent_invite_sent' });
    const midForeign = { ...mid, integration_source: 'relay_agent_connect' }; // pretend an attacker relabels a real member

    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(midForeign), snap(child3)],
      tipSnapshot: tip(child3.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });
});

describe('validateCanonicalAgentPeChainSnapshots — device_pe_submit PEs are unified chain members', () => {
  // put an agent-owned device's ordinary PEs on the SAME pe_chain_tips/{agent_id}.
  // The reader admitted only agent_bank_generate_pe docs, so the first ordinary tool
  // turn moved the tip to a hash it could not see -> tip_pe_missing -> registry gate
  // zeroed every later PE. The reader must now admit device_pe_submit members too.
  const birth = mkCanonical({ id: 'pe_birth', timestamp: 1000, prev_hash: '0x0000', action_type: 'agent_wallet_created' });
  const deviceTurn = mkDevice({ id: 'pe_devturn', timestamp: 2000, prev_hash: birth.hash as string, action_type: 'agent_tool_orchestration' });

  it('RED->GREEN: a device_pe_submit tip resolves; the chain walks device->birth (was tip_pe_missing)', () => {
    const result = validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(deviceTurn)],
      tipSnapshot: tip(deviceTurn.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    });
    expect(result.pes.map((p) => p.id)).toEqual(['pe_devturn', 'pe_birth']); // tip first
    expect(result.tipHash).toBe(deviceTurn.hash);
    expect(result.byId.get('pe_devturn')?.integration_source).toBe('device_pe_submit');
  });

  it('REVIEWER DEFECT : a DESCRIPTION-LESS device tip resolves — the common observer PE', () => {
    // buildPEContent sets description/intent_text from an OPTIONAL body.description;
    // compute_session / inference_session (reportAction) carry none, so both are
    // undefined and Firestore's ignoreUndefinedProperties STRIPS them — a 24-key
    // stored doc. A 26-key exactKeys gate rejected exactly these PEs (device_pe_shape),
    // so verifyRegistryHold left the held rows pending forever. This is the exact
    // population exists to release; the omit-description device PE must resolve.
    const bareTurn = mkDevice({ id: 'pe_bareturn', timestamp: 2000, prev_hash: birth.hash as string, action_type: 'compute_session', omitDescription: true });
    // Non-vacuous: the fixture really lacks the two keys.
    expect('description' in bareTurn).toBe(false);
    expect('intent_text' in bareTurn).toBe(false);
    const result = validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(bareTurn)],
      tipSnapshot: tip(bareTurn.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    });
    expect(result.pes.map((p) => p.id)).toEqual(['pe_bareturn', 'pe_birth']);
    expect(result.byId.get('pe_bareturn')?.integration_source).toBe('device_pe_submit');
  });

  it('INTEGRITY (RED control): an EXTRA unexpected key on a device PE is still rejected', () => {
    // The optional allowance must not become "anything goes": a key outside the
    // required ∪ {description,intent_text} set fails device_pe_shape.
    const withExtra = { ...deviceTurn, unexpected_field: 'x' };
    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(withExtra)],
      tipSnapshot: tip(deviceTurn.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });

  it('INTEGRITY (RED control): a device PE missing a REQUIRED key is rejected', () => {
    // Dropping a non-optional key (attestation_type) must fail — the optional
    // allowance is exactly {description,intent_text}, nothing else.
    const missingRequired: Record<string, unknown> = { ...deviceTurn };
    delete missingRequired.attestation_type;
    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(missingRequired)],
      tipSnapshot: tip(deviceTurn.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });

  it('a mixed chain (canonical birth -> canonical mid -> device tip) walks all three', () => {
    const mid = mkCanonical({ id: 'pe_mid2', timestamp: 1500, prev_hash: birth.hash as string, action_type: 'genesis_signup' });
    const devTip = mkDevice({ id: 'pe_devtip', timestamp: 2000, prev_hash: mid.hash as string, action_type: 'agent_api_orchestration' });
    const result = validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(mid), snap(devTip)],
      tipSnapshot: tip(devTip.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    });
    expect(result.pes.map((p) => p.id)).toEqual(['pe_devtip', 'pe_mid2', 'pe_birth']);
  });

  it('INTEGRITY: a device tip whose hash matches NO stored member still fails tip_pe_missing', () => {
    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(deviceTurn)],
      tipSnapshot: tip('f'.repeat(64), 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });

  it('INTEGRITY: a device member with a tampered hash is rejected, never admitted', () => {
    const tampered = { ...deviceTurn, hash: 'a'.repeat(64) };
    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(tampered)],
      tipSnapshot: tip(tampered.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });

  it('INTEGRITY: a device member with tampered CONTENT (hash no longer matches) is rejected', () => {
    // Keep the original stored hash but mutate a hashed field -> stored hash is now stale.
    const tamperedContent: Record<string, unknown> = { ...deviceTurn, action_type: 'genesis_signup' };
    expect(() => validateCanonicalAgentPeChainSnapshots({
      peSnapshots: [snap(birth), snap(tamperedContent)],
      tipSnapshot: tip(deviceTurn.hash as string, 2000),
      agentId: AGENT,
      walletId: WALLET,
    })).toThrow(CanonicalAgentPeChainIntegrityError);
  });
});

// =============================================================================
// PE METER — identity PE point reads (identity act first, pre-meter envelope fallback)
// =============================================================================

describe('validateIdentityPeSnapshots — one point read per pinned identity PE', () => {
  const ABSENT = { exists: false, data: () => undefined };
  function present(doc: Record<string, unknown>) {
    return { exists: true, data: () => structuredClone(doc) };
  }
  const BIRTH = identityPeFixture({
    id: 'pe_birth', walletId: WALLET, agentId: AGENT, actorAddress: ADDR,
    actionType: 'agent_wallet_created', policyActionType: 'wallet_created',
    timestamp: 1_000, prevHash: '0x0000', metadata: { platform: 'sdk' },
  });
  const binding = { peId: 'pe_birth', peHash: BIRTH.hash, agentId: AGENT, walletId: WALLET };
  const reasonOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      if (error instanceof CanonicalAgentPeChainIntegrityError) return error.reason;
      throw error;
    }
    return 'accepted';
  };
  const tamperedBirth = (): Record<string, unknown> => {
    const doc = structuredClone(BIRTH.document) as { act: { pricing: { metadata: Record<string, unknown> } } };
    doc.act.pricing.metadata.platform = 'forged';
    return doc as unknown as Record<string, unknown>;
  };

  it('accepts the identity act its pin names, as the stored-PE view validators read', () => {
    const pe = validateIdentityPeSnapshots({ identity: present(BIRTH.document), legacy: ABSENT }, binding);
    expect(pe).toMatchObject({
      id: 'pe_birth', agent_id: AGENT, user_id: AGENT, wallet_id: WALLET,
      action_type: 'agent_wallet_created', policy_action_type: 'wallet_created',
      actor_address: ADDR, timestamp: 1_000, prev_hash: '0x0000', hash: BIRTH.hash,
      metadata: { platform: 'sdk' },
    });
  });

  it('RED: a tampered, re-pinned, re-owned, re-shaped, or foreign-authored identity act is refused — never a legacy fallback', () => {
    const legacy = mkCanonical({ id: 'pe_birth', timestamp: 1_000, prev_hash: '0x0000', action_type: 'agent_wallet_created' });
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present(tamperedBirth()), legacy: present(legacy) },
      { ...binding, peHash: legacy.hash as string },
    ))).toBe('identity_act_invalid');
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present(BIRTH.document), legacy: ABSENT },
      { ...binding, peHash: 'f'.repeat(64) },
    ))).toBe('identity_act_invalid');
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present(BIRTH.document), legacy: ABSENT },
      { ...binding, agentId: 'agent_other' },
    ))).toBe('identity_act_invalid');
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present({ ...BIRTH.document, smuggled: true }), legacy: ABSENT },
      binding,
    ))).toBe('identity_act_invalid');
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present(BIRTH.document), legacy: ABSENT },
      { ...binding, allowedActorAddresses: new Set([`0x${'2'.repeat(40)}`]) },
    ))).toBe('pe_actor_authority');
  });

  it('falls back to the pre-meter envelope only when no identity act exists, and binds its pin', () => {
    const legacy = mkCanonical({ id: 'pe_birth', timestamp: 1_000, prev_hash: '0x0000', action_type: 'agent_wallet_created' });
    expect(validateIdentityPeSnapshots(
      { identity: ABSENT, legacy: present(legacy) },
      { ...binding, peHash: legacy.hash as string },
    )).toMatchObject({ id: 'pe_birth', hash: legacy.hash });
    // RED: a self-consistent envelope whose hash is not the pinned one.
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: ABSENT, legacy: present(legacy) },
      { ...binding, peHash: 'f'.repeat(64) },
    ))).toBe('source_not_in_chain');
    // RED: neither store holds it.
    expect(reasonOf(() => validateIdentityPeSnapshots({ identity: ABSENT, legacy: ABSENT }, binding)))
      .toBe('identity_pe_missing');
  });

  it('a record that names its PE by id alone (a vote) still requires a self-consistent act', () => {
    expect(validateIdentityPeSnapshots(
      { identity: present(BIRTH.document), legacy: ABSENT },
      { ...binding, peHash: null },
    )).toMatchObject({ hash: BIRTH.hash });
    expect(reasonOf(() => validateIdentityPeSnapshots(
      { identity: present(tamperedBirth()), legacy: ABSENT },
      { ...binding, peHash: null },
    ))).toBe('identity_act_invalid');
  });
});
