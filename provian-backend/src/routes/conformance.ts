/**
 * PE Alliance - Conformance Validation Routes
 *
 * Public endpoints for validating PE implementations against the spec.
 * No auth required. Rate limited to 60/hour per IP.
 *
 * Endpoints:
 *   POST /validate    - Validate a PE against the spec
 *   GET  /spec        - Get the current PE spec as JSON
 *   GET  /action-types - Get all valid ActionType values
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import type { RedisCache } from '../cache';
import { GENESIS_PREV_HASH, TEST_GENESIS_PREV_HASH } from '../core/pe/constants';
import { getEffectiveAttestationMultipliers } from '../core/pvt/pe-weight-framework';
import { isValidPolicyActionType } from '../core/pvt/policy/action-type-syntax';
import { DEVICE_OBSERVATION_ACTION_TYPES } from '../core/provenance/device-observation-types';
import { isSafePETimestamp } from '../pe-validation';

/**
 * HMAC-SHA256 over the canonical (sorted-keys) JSON of the badge body.
 *
 * The previous implementation used `SHA-256(secret || payload)`, which is
 * length-extension vulnerable - an attacker who has any valid badge can
 * append arbitrary bytes and produce a second valid signature without
 * knowing the secret. HMAC's key-derived inner/outer hash construction
 * blocks that attack.
 *
 * Exported so verifiers (and tests) can recompute the signature.
 */
export function signConformanceBadge(
  badgeContent: Record<string, unknown>,
  signingKey: string,
): string {
  return crypto
    .createHmac('sha256', signingKey)
    .update(JSON.stringify(badgeContent))
    .digest('hex');
}

/** Human-readable docs for each attestation tier. Multipliers themselves
 *  are sourced from ATTESTATION_MULTIPLIERS to prevent drift. */
export const ATTESTATION_TIER_DESCRIPTIONS: Record<string, string> = {
  social: 'Self-asserted social attestation',
  software: 'Software-only attestation; mandatory base tier for agent-owned devices before signing-method selection',
  corroborated: 'Third-party corroboration signal (merchant MTL or on-chain) received post-creation, pre-mint',
  hardware_partial: 'Historical factor; current non-App-Attest hardware evidence is disclosed at normal lane pricing',
  software_verified: 'Software with valid Replication Pack (input_hash + model_id + replication_pack_hash)',
  compute_tee: 'Historical factor; verified TPM, GPU and cloud attestations are presentation facts at the normal witness-lane price',
  full_stack: 'RESERVED - phone hardware + compute TEE + on-chain transaction + merchant signal in a single PE.',
  hardware_full: 'Verified Apple App Attest on a human-owned mobile device; only App Attest selects hardware pricing',
};

export const ATTESTATION_POLICY_CONTEXT = Object.freeze({
  configured_range: '0.5x-2.5x',
  human_trust_factor: 'Separate 2.0x factor only after verified direct-human identity or an agent human-beneficiary relationship; attestation never supplies linkage.',
  agent_owned_devices: 'Server-capped at software before signing-method tier selection; agent hardware eligibility has not been approved.',
  agent_device_register: 'Carries no device anchor and mints zero PVT.',
  conformance_claims: 'A submitted identifier can describe claimed evidence, but runtime owner policy and evidence verification assign the authoritative tier.',
});

// CATALOG_ACTION_TYPES - A catalog of known first-party Provian action types.
//
// THE TYPE OF WORK IS NEVER THE GATE; A WITNESS IS. Any valid identifier string
// (alphanumeric + underscores, or namespace:action format) may be submitted on a
// witness lane. Types not in this catalog generate a warning, not an error. A type
// the network has never seen records with no mint, enters the public review queue
// (GET /v1/pe/earning-proposals) and earns from the signing cut forward; it is
// catalogued in the pe_type_catalog Firestore collection as it is sealed.
//
// - Tier 1: First-party types listed here (seeded in catalog as source='seed')
// - Tier 2: Third-party namespaced types (namespace:action_name format)
// - Tier 3: Any other valid identifier (catalogued as source='auto_registered')
//
// There is no write form for the catalog; review status for every type is at
// GET /v1/pe/earning-proposals (provian.ai/proposals).
export const CATALOG_ACTION_TYPES: string[] = [
  'send', 'swap', 'stake', 'receive', 'onramp', 'approve', 'burn_spam',
  'recovery_action', 'recovery_init', 'recovery_complete', 'recurring_payment_run',
  'export_logs', 'x402_payment', 'REVOKE_APPROVAL', 'onramp_order',
  'device_register', 'device_revoke', 'agent_action', 'link_spend', 'agent_authorization',
  'vouch_for_device', 'agreement', 'agreement_settled',
  'credential_added', 'credential_updated', 'credential_frozen', 'credential_unfrozen',
  'credential_deleted', 'credential_released', 'credential_injected',
  'credential_release_expired', 'credential_release_used',
  'agent_session_started', 'agent_session_suspended', 'agent_session_revoked',
  'policy_created', 'policy_updated', 'friction_escalation', 'emergency_stop',
  'promise_created', 'promise_accepted', 'promise_fulfilled', 'promise_broken',
  'promise_disputed', 'promise_offered', 'promise_countered',
  'promise_negotiation_accepted', 'promise_negotiation_rejected', 'promise_negotiation_expired',
  'negotiation_expired', 'negotiation_rejected',
  'agent_communicate', 'agent_commit', 'agent_share_data', 'agent_public_post',
  'agent_system_access', 'agent_uncategorized',
  'social_post_approved', 'social_post_denied',
  'system_access_approved', 'system_access_denied',
  'uncategorized_action_approved', 'uncategorized_action_denied',
  'proxied_payment_requested', 'proxied_payment_approved',
  'proxied_payment_executed', 'proxied_payment_failed',
  'egress_data_requested', 'egress_data_approved', 'egress_data_denied',
  'egress_data_executed', 'egress_data_blocked',
  'request_expired', 'request_auto_approved',
  'agent_transaction_reported', 'agent_transaction_synced',
  'anomaly_detected', 'behavior_baseline_updated', 'classification_reclassified',
  'environment_attestation', 'environment_drift_detected', 'skill_install_requested',
  'wallet_created', 'agent_wallet_created', 'external_address_proven',
  'badge_earned', 'agent_invite_sent', 'invite_accepted',
  'escrow_created', 'escrow_funded', 'escrow_completed', 'escrow_disputed', 'escrow_resolved',
  'promise_funded', 'promise_settled', 'promise_defaulted',
  'pool_created', 'pool_contributed', 'pool_executed', 'pool_refunded',
  'court_panel_assigned', 'court_vote_cast', 'court_verdict',
  'court_majority_bonus', 'court_minority_vote', 'court_escalated',
  'court_general_dispute_filed', 'court_general_dispute_resolved', 'court_evidence_submitted',
  'pvt_batch_minted', 'pvt_epoch_advanced', 'pvt_pe_anchored',
  'governance_proposal_created', 'governance_vote_cast',
  'governance_proposal_executed', 'governance_proposal_cancelled', 'governance_premint_weight_set',
  'agent_capabilities_registered', 'job_posted', 'job_applied', 'job_accepted',
  'job_delivered', 'webhook_subscribed', 'pe_type_proposed',
  'pvt_fee_burned', 'pvt_reputation_staked', 'pvt_reputation_unstaked',
  'pvt_reputation_slashed', 'pvt_burned_voluntary',
  'pvt_governance_proposed', 'pvt_governance_voted',
  'goal_envelope_created', 'goal_envelope_completed', 'goal_envelope_expired',
  'goal_envelope_cancelled', 'goal_action_auto_approved', 'goal_constraint_violation',
  'corroboration_signal', 'replication_pack',
  // Agent-built ecosystem action type categories
  'agent_marketplace', 'agent_court', 'agent_governance', 'agent_labor_market',
  'agent_compute_market', 'agent_reputation_system', 'agent_ecosystem_uncategorized',
  // SDK-reported work types
  'coding_session', 'refactor', 'test_run', 'deployment', 'research', 'document',
];

/**
 * Seeded types that name mechanisms the wallet no longer has (removed the agent-authorization
 * gate, the credential vault, relay agent sessions, agent policies, the friction router's agent lane,
 * the emergency stop, and goal envelopes). They stay in the seed catalog so historical records keep
 * classifying, but nothing emits them today, so the served discovery list reports them SEPARATELY as
 * legacy rather than as current first-party types (fact-base fixes item 5, 2026-09-23). Every entry
 * has an empty `static_emitter_files` list in the signed matrix; `policy_updated` is NOT here — the
 * beneficiary share update, the governance-flags route, and the chain listener still emit it.
 */
export const LEGACY_RETIRED_ACTION_TYPES: readonly string[] = Object.freeze([
  'agent_authorization',
  'credential_added', 'credential_updated', 'credential_frozen', 'credential_unfrozen',
  'credential_deleted', 'credential_released', 'credential_injected',
  'credential_release_expired', 'credential_release_used',
  'agent_session_started', 'agent_session_suspended', 'agent_session_revoked',
  'policy_created', 'friction_escalation', 'emergency_stop',
  'goal_envelope_created', 'goal_envelope_completed', 'goal_envelope_expired',
  'goal_envelope_cancelled', 'goal_action_auto_approved', 'goal_constraint_violation',
]);

const SPEC_VERSION = '1.0.0';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_REGEX = /^[0-9a-f]{64}$/i;
const CUSTOM_TYPE_REGEX = /^[a-z][a-z0-9]*:[a-z][a-z0-9_]*$/;

interface ConformanceError {
  field: string;
  message: string;
  severity: 'error';
}

interface ConformanceWarning {
  field: string;
  message: string;
  severity: 'warning';
}

export function validatePE(
  pe: Record<string, unknown>,
  publicKey: string,
  previousPE?: Record<string, unknown>,
): { errors: ConformanceError[]; warnings: ConformanceWarning[]; score: number; attestationTier: string } {
  const errors: ConformanceError[] = [];
  const warnings: ConformanceWarning[] = [];
  let score = 100;

  // --- STRUCTURE CHECKS ---

  // envelope_id: UUID format
  if (typeof pe.envelope_id !== 'string') {
    errors.push({ field: 'envelope_id', message: 'Must be a string', severity: 'error' });
    score -= 15;
  } else if (!UUID_REGEX.test(pe.envelope_id)) {
    errors.push({ field: 'envelope_id', message: 'Must be UUID format', severity: 'error' });
    score -= 10;
  }

  // prev_envelope_hash
  if (typeof pe.prev_envelope_hash !== 'string') {
    errors.push({ field: 'prev_envelope_hash', message: 'Must be a string', severity: 'error' });
    score -= 15;
  } else if (pe.prev_envelope_hash !== GENESIS_PREV_HASH && pe.prev_envelope_hash !== TEST_GENESIS_PREV_HASH && !HEX64_REGEX.test(pe.prev_envelope_hash)) {
    errors.push({ field: 'prev_envelope_hash', message: 'Must be 64-char hex SHA-256, "genesis", or "test_genesis"', severity: 'error' });
    score -= 10;
  }

  // timestamp
  if (!isSafePETimestamp(pe.timestamp)) {
    errors.push({ field: 'timestamp', message: 'Must be a non-negative safe integer (Unix ms)', severity: 'error' });
    score -= 15;
  } else {
    const now = Date.now();
    const diff = Math.abs(now - (pe.timestamp as number));
    if (diff > 5 * 60 * 1000) {
      errors.push({ field: 'timestamp', message: 'Must be within 5 minutes of submission time', severity: 'error' });
      score -= 10;
    }
  }

  // action_type - the type of work is never the gate (a witness is; see custom_action_types).
  //   - Catalog types (first-party seed): accepted silently
  //   - Namespaced types (namespace:action_name): accepted with a soft warning
  //   - Any other valid identifier: accepted with a new-type warning
  //   - Structurally invalid (empty, non-string, non-identifier chars): error
  if (typeof pe.action_type !== 'string') {
    errors.push({ field: 'action_type', message: 'Must be a string', severity: 'error' });
    score -= 15;
  } else {
    const actionType = pe.action_type as string;
    const isKnownType = CATALOG_ACTION_TYPES.includes(actionType);
    const isValidIdentifier = isValidPolicyActionType(actionType);
    const isCustomType = isValidIdentifier && CUSTOM_TYPE_REGEX.test(actionType);
    if (actionType.length === 0) {
      errors.push({ field: 'action_type', message: 'Must be a non-empty string', severity: 'error' });
      score -= 15;
    } else if (!isValidIdentifier) {
      // Structurally invalid (special characters, whitespace, starts with digit, etc.)
      errors.push({ field: 'action_type', message: 'Must be a valid identifier of at most 200 characters (alphanumeric + underscores, starts with letter) or lowercase namespace:action_name format', severity: 'error' });
      score -= 10;
    } else if (!isKnownType && !isCustomType) {
      // Unknown flat type - accepted; a never-seen type records with no mint and enters review
      warnings.push({ field: 'action_type', message: 'Unknown action type. Emitted on a witness lane (a hardware-witnessed submission on the sovereign lane, or a registered machine\'s observer witnessing it through an observer plugin), your envelope is sealed as proof you own; a type the network has never seen records with no mint and enters the public review queue (GET /v1/pe/earning-proposals, provian.ai/proposals). It earns from the day its policy row is signed; envelopes sealed before then stay records. You are notified when it earns. Contributing an emitter and a verifier is welcome, never required. Consider using namespace:action_name format for third-party types.', severity: 'warning' });
    }
    if (isCustomType) {
      warnings.push({ field: 'action_type', message: 'Namespaced action type - recorded on a witness lane and catalogued for discovery. A type the network has never seen records with no mint and enters the public review queue (provian.ai/proposals); it earns from the day its policy row is signed, and envelopes sealed before then stay records.', severity: 'warning' });
    }
  }

  // details
  if (pe.details === undefined || pe.details === null || typeof pe.details !== 'object' || Array.isArray(pe.details)) {
    errors.push({ field: 'details', message: 'Must be an object', severity: 'error' });
    score -= 10;
  }

  // risk_score
  if (typeof pe.risk_score !== 'number') {
    errors.push({ field: 'risk_score', message: 'Must be a number', severity: 'error' });
    score -= 10;
  } else if ((pe.risk_score as number) < 0 || (pe.risk_score as number) > 100) {
    errors.push({ field: 'risk_score', message: 'Must be between 0 and 100', severity: 'error' });
    score -= 5;
  }

  // device_attestation_id
  if (typeof pe.device_attestation_id !== 'string' || !(pe.device_attestation_id as string).length) {
    errors.push({ field: 'device_attestation_id', message: 'Must be a non-empty string', severity: 'error' });
    score -= 10;
  }

  // signature
  if (typeof pe.signature !== 'string' || !(pe.signature as string).length) {
    errors.push({ field: 'signature', message: 'Must be a non-empty string', severity: 'error' });
    score -= 15;
  }

  // --- HASH CHAIN VALIDATION ---
  if (previousPE && typeof pe.prev_envelope_hash === 'string' && pe.prev_envelope_hash !== GENESIS_PREV_HASH && pe.prev_envelope_hash !== TEST_GENESIS_PREV_HASH) {
    // Compute hash of previous PE body (excluding signature)
    const prevBody = { ...previousPE };
    delete prevBody.signature;
    const sortedKeys = Object.keys(prevBody).sort();
    const canonical: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      canonical[key] = prevBody[key];
    }
    const expectedHash = crypto.createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    if (pe.prev_envelope_hash !== expectedHash) {
      errors.push({
        field: 'prev_envelope_hash',
        message: `Hash chain broken. Expected ${expectedHash}, got ${pe.prev_envelope_hash}`,
        severity: 'error',
      });
      score -= 20;
    }
  }

  // --- SIGNATURE VALIDATION ---
  if (typeof pe.signature === 'string' && (pe.signature as string).length && publicKey) {
    try {
      // Build canonical body (sorted keys, excluding signature)
      const body = { ...(pe as Record<string, unknown>) };
      delete body.signature;
      const sortedKeys = Object.keys(body).sort();
      const canonical: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        canonical[key] = body[key];
      }
      const canonicalJSON = JSON.stringify(canonical);

      // Try to verify with the provided public key
      // Support both secp256k1 and P-256 by trying EC verify
      let signatureValid = false;
      const signatureBuffer = Buffer.from(pe.signature as string, 'hex');

      for (const curve of ['prime256v1', 'secp256k1'] as const) {
        try {
          const verify = crypto.createVerify('SHA256');
          verify.update(canonicalJSON);
          const pubKeyDer = Buffer.from(publicKey, 'hex');
          // Try raw EC key format
          const ecKey = crypto.createPublicKey({
            key: pubKeyDer,
            format: 'der',
            type: 'spki',
          });
          signatureValid = verify.verify(ecKey, signatureBuffer);
          if (signatureValid) break;
        } catch {
          // Try next curve or format
        }
      }

      if (!signatureValid) {
        // If we couldn't verify, it might be a format issue - warn rather than fail
        warnings.push({
          field: 'signature',
          message: 'Could not verify signature with provided public key. Ensure key is DER-encoded SPKI format.',
          severity: 'warning',
        });
        score -= 5;
      }
    } catch {
      warnings.push({
        field: 'signature',
        message: 'Signature verification encountered an error',
        severity: 'warning',
      });
      score -= 5;
    }
  }

  // --- JURISDICTION FIELDS (relay-set, informational validation) ---

  if (pe.mint_status !== undefined) {
    const validStatuses = [
      'eligible',
      'record_only',
      'pending_evidence',
      'pending_review',
      'deferred',
      'minted',
      'ineligible',
      'skipped_no_output',
    ];
    if (!validStatuses.includes(pe.mint_status as string)) {
      warnings.push({
        field: 'mint_status',
        message: `Invalid mint_status '${pe.mint_status}'. Valid values: ${validStatuses.join(', ')}. Note: this field is set by the relay, not the submitter.`,
        severity: 'warning',
      });
    }
  }

  if (pe.jurisdiction_context !== undefined) {
    if (typeof pe.jurisdiction_context !== 'string' || !/^(?:[A-Z]{2}(?:-[A-Z0-9]{2,3})?)?$/.test(pe.jurisdiction_context as string)) {
      warnings.push({
        field: 'jurisdiction_context',
        message: 'jurisdiction_context is relay-derived from offline request-IP country/region observations in authenticated wallet sessions. Submitter values carry no authority. Actor and recipient country/region policy and OFAC SDN address screening govern mint status; unknown never defaults to US. Unknown location or unavailable screening holds the act for automatic recovery; jurisdiction blocks hold the act until policy permits release at its sealed value; only SDN hits are terminal compliance denials.',
        severity: 'warning',
      });
    }
  }

  // --- ATTESTATION TIER DETECTION ---
  // Prefixes mirror the active tiers in
  // provian-backend/src/core/pvt/pe-weight-framework.ts. Order matters:
  // hw_partial: must be checked before hw: so the more specific prefix
  // wins.
  let attestationTier = 'software';
  if (typeof pe.device_attestation_id === 'string') {
    const daid = pe.device_attestation_id as string;
    if (daid.startsWith('hw_partial:')) {
      attestationTier = 'hardware_partial';
    } else if (daid.startsWith('hw:') || daid.includes('secure_enclave') || daid.includes('strongbox')) {
      attestationTier = 'hardware_full';
    } else if (daid.startsWith('sw_verified:')) {
      attestationTier = 'software_verified';
    } else if (daid.startsWith('corr:')) {
      attestationTier = 'corroborated';
    }
  }

  // Ensure score doesn't go below 0
  score = Math.max(0, score);

  return { errors, warnings, score, attestationTier };
}

export function createConformanceRouter(cache: RedisCache): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /validate - Validate a PE against the spec
  // -------------------------------------------------------------------------
  router.post('/validate', async (req: Request, res: Response) => {
    try {
      // Rate limit: 60/hour per IP
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rateLimit = await cache.checkRateLimit(`rl:conformance:${ip}`, 60, 3600);
      if (!rateLimit.allowed) {
        res.status(429).json({ error: 'Rate limit exceeded (60/hour)', retry_after: rateLimit.retryAfter });
        return;
      }

      const { pe, public_key, previous_pe, implementation_name } = req.body;

      if (!pe || typeof pe !== 'object') {
        res.status(400).json({ error: 'pe (object) is required' });
        return;
      }
      if (!public_key || typeof public_key !== 'string') {
        res.status(400).json({ error: 'public_key (string) is required' });
        return;
      }

      const { errors, warnings, score, attestationTier } = validatePE(
        pe as Record<string, unknown>,
        public_key,
        previous_pe as Record<string, unknown> | undefined,
      );

      const passed = errors.length === 0;
      const recommendations: string[] = [];

      if (score < 100) {
        if (errors.some(e => e.field === 'signature')) {
          recommendations.push('Ensure signatures use secp256k1 or P-256 over the canonical PE body (JSON.stringify with sorted keys, signature field excluded)');
        }
        if (errors.some(e => e.field === 'prev_envelope_hash')) {
          recommendations.push('Hash chain: SHA-256 of the previous PE canonical body (sorted keys, no signature)');
        }
        if (attestationTier === 'software') {
          recommendations.push('For higher attestation tier, use hardware-backed keys (prefix device_attestation_id with "hw:")');
        }
      }

      const response: Record<string, unknown> = {
        passed,
        score,
        errors,
        warnings,
        attestation_tier_detected: attestationTier,
        recommendations,
        conformance_version: SPEC_VERSION,
        test_timestamp: Date.now(),
      };

      // Conformance badge for perfect score. Signed with HMAC-SHA256 over
      // the canonical badge content. RELAY_SIGNING_KEY is required at boot
      // (see validateRequiredEnv in server.ts); the in-handler check below
      // is defense-in-depth in case the route is mounted in a unit-test
      // harness that bypasses startup validation.
      if (passed && score === 100) {
        const signingKey = process.env.RELAY_SIGNING_KEY;
        if (!signingKey) {
          console.error('[Conformance] RELAY_SIGNING_KEY not set; refusing to issue badge');
          return res.status(503).json({ error: 'Badge signing unavailable', code: 'SIGNING_KEY_NOT_CONFIGURED' });
        }
        const badgeContent = {
          implementation_name: implementation_name || 'unnamed',
          conformance_score: 100,
          spec_version: SPEC_VERSION,
          timestamp: Date.now(),
          expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days
        };
        response.conformance_badge = {
          ...badgeContent,
          signature: signConformanceBadge(badgeContent, signingKey),
        };
      }

      res.json(response);
    } catch (error) {
      console.error('[Conformance] Validation error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /spec - Current PE spec as JSON
  // -------------------------------------------------------------------------
  router.get('/spec', async (_req: Request, res: Response) => {
    // W6-3: read effective multipliers (base + Foundation overrides) so
    // governance changes show up in the spec without a code deploy.
    const effective = await getEffectiveAttestationMultipliers();
    res.json({
      version: SPEC_VERSION,
      name: 'Provenance Envelope Specification',
      description: 'Canonical specification for PE-compatible implementations',
      constitutional_status: {
        status: 'stable',
        note: 'This specification is the authoritative PE validity standard for the entire Provian Network, as defined by Article I of the Provian Network Constitution (NETWORK_CONSTITUTION.md). Changes require community proposal and 30-day notice.',
      },
      required_fields: {
        envelope_id: {
          type: 'string',
          format: 'UUID v4',
          description: 'Unique identifier for this envelope',
        },
        prev_envelope_hash: {
          type: 'string',
          format: '64-char hex SHA-256 | "genesis" | "test_genesis"',
          description: 'SHA-256 hash of the previous PE body (sorted keys, excluding signature), or "genesis" for the first PE',
        },
        timestamp: {
          type: 'number',
          format: 'Unix milliseconds',
          description: 'Must be within 5 minutes of submission time',
        },
        action_type: {
          type: 'string',
          format: 'Any valid identifier or namespace:action_name',
          description: 'Type of action recorded. Any valid identifier may be submitted; recording needs a witness, not an approved type (see custom_action_types). Use GET /action-types for the seed catalog and GET /v1/pe/type-catalog for the live catalog.',
        },
        details: {
          type: 'object',
          description: 'Action-specific details. Contents not validated - open extension point.',
        },
        risk_score: {
          type: 'number',
          range: '0-100',
          description: 'Risk assessment score for the action',
        },
        device_attestation_id: {
          type: 'string',
          description: 'Non-empty device attestation identifier. Prefix with "hw:" for hardware-backed keys.',
        },
        signature: {
          type: 'string',
          format: 'Hex-encoded secp256k1 or P-256 signature',
          description: 'Signature over canonical PE body (JSON.stringify with sorted keys, excluding signature field)',
        },
      },
      optional_fields: {
        actor_address: { type: 'string', description: 'On-chain address of the actor' },
        chain_id: { type: 'number | string', description: 'Chain identifier' },
        counterparty_address: { type: 'string', description: 'Address of the counterparty' },
        intent_origin: { type: 'object', description: 'Intent provenance metadata' },
      },
      relay_set_fields: {
        mint_status: {
          type: 'string',
          values: [
            'eligible',
            'record_only',
            'pending_evidence',
            'pending_review',
            'deferred',
            'minted',
            'ineligible',
            'skipped_no_output',
          ],
          set_by: 'relay',
          description: 'Relay-owned derived mint workflow status. It is not part of the submitter-signed PE body. record_only/pending_evidence/pending_review are explicit fail-closed economic states; deferred is jurisdiction deferral; skipped_no_output is terminal no-output provenance.',
        },
        jurisdiction_context: {
          type: 'string',
          format: 'ISO country or deferred jurisdiction code; empty when unresolved',
          set_by: 'relay',
          description: 'Relay-derived country from authenticated request-IP sessions, or the jurisdiction holding minting. Offline subdivision lookup and both actor/recipient OFAC SDN address checks apply; unknown never defaults to US. Unknown location or unavailable screening holds the act for automatic recovery; jurisdiction blocks hold the act until policy permits release at its sealed value; only SDN hits are terminal compliance denials.',
        },
        deferred_since: {
          type: 'number | null',
          set_by: 'relay',
          description: 'Unix milliseconds when minting deferral began. null for non-deferred PEs. Audit evidence only — it does not affect what the PE pays. Time spent deferred never reduces a PE.',
        },
      },
      // Multipliers come live from
      // provian-backend/src/core/pvt/pe-weight-framework.ts
      // (ATTESTATION_MULTIPLIERS). HIGH-3: previously this object had a
      // hand-maintained inline copy that had drifted (software_verified
      // was 0.9x and hardware_full was 1.0x in the spec while the
      // framework had 1.2x and 2.5x). Reading from the source-of-truth
      // table here makes drift impossible.
      attestation_tiers: Object.fromEntries(
        Object.entries(effective.multipliers)
          .sort(([, a], [, b]) => a - b)
          .map(([tier, mult]) => [tier, {
            multiplier: `${mult}x`,
            description: ATTESTATION_TIER_DESCRIPTIONS[tier] ?? `Attestation tier ${tier}`,
          }]),
      ),
      attestation_policy: ATTESTATION_POLICY_CONTEXT,
      attestation_multipliers_meta: {
        foundation_override_active: effective.foundation_override_active,
        last_changed_at: effective.last_changed_at,
        runtime_mutable: false,
        authority: 'Frozen code table; no Foundation Safe or runtime attestation override.',
      },
      hash_chain: {
        algorithm: 'SHA-256',
        canonical_body: 'JSON.stringify with keys sorted alphabetically, signature field excluded',
        genesis: 'Use "genesis" for the first PE for a given device_attestation_id',
        test_genesis: 'Use "test_genesis" for conformance testing of isolated single PEs',
      },
      signature: {
        supported_curves: ['secp256k1', 'P-256 (secp256r1)'],
        message: 'SHA-256 of canonical PE body',
        format: 'DER-encoded signature, hex-encoded',
      },
      custom_action_types: {
        pattern: 'namespace:action_name',
        regex: '^[a-z][a-z0-9]*:[a-z][a-z0-9_]*$',
        identifier_pattern: '^[a-zA-Z][a-zA-Z0-9_]*$',
        description: 'Emit your envelope; that is all you need to do. Any valid identifier (a flat name like "my_action" or namespace:action like "myapp:user_signup") may be submitted: the type of work is never the gate, a witness is. '
          + 'A new type records on a witness lane: a hardware-witnessed submission on the sovereign lane (POST /v1/pe/submit-sovereign, carrying an admitted non-actor hardware_witness), or a registered machine\'s observer witnessing it through an observer plugin (the gateway path: the act rides the device batch POST /v1/meter/batch at device tier, stamped metadata.source "observer_plugin" and metadata.observer_plugin by the observer). '
          + `The device batch still admits the observation-lane types (${[...DEVICE_OBSERVATION_ACTION_TYPES].join(', ')}; link_spend only from the transcript lane) as before; the chain, forge, relay and counterparty lanes witness their own types. `
          + 'A type the network has never seen is recorded with no mint and enters the public review queue (GET /v1/pe/earning-proposals, provian.ai/proposals). It earns from the day its policy row is signed, on each lane it came in on; envelopes sealed before the signature stay records. Submitters are notified when it earns (a push for people; an action_type_activated inbox event and webhook for agents). Contributing an emitter and a verifier is welcome, never required. '
          + 'A bare call asserting work with nothing else vouching for it (an agent or device vouching for its own claim) is refused with 403 actor_declared_work_is_not_a_pe, not recorded. A named type keeps its own witness: a chain, relay, forge or Genesis type presented through the actor\'s own hardware report or an observer plugin is refused. '
          + 'On the phone\'s batch (POST /v1/meter/batch/mobile) a type the action-policy matrix does not name is the person\'s own claim: it records at the actor_declared witness class, earns zero and does not enter review. '
          + 'The single-PE recorders (POST /v1/pe/submit, /v1/pe/submit/mobile, /v1/relay/action, /v1/relay/work-product) are retired and answer 410 pe_recorder_retired. '
          + 'Types are catalogued as they are sealed; see GET /v1/pe/type-catalog.',
        permissionless: true,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /action-types - Current catalog of first-party ActionType values.
  // This endpoint returns the seeded catalog for discovery. Any valid identifier may be
  // submitted on a witness lane; a never-seen type records with no mint and enters the
  // public review queue (see custom_action_types on GET /spec).
  // Use GET /v1/pe/type-catalog for the full catalog including auto-registered types.
  // -------------------------------------------------------------------------
  router.get('/action-types', (_req: Request, res: Response) => {
    const legacy = new Set(LEGACY_RETIRED_ACTION_TYPES);
    const current = CATALOG_ACTION_TYPES.filter((t) => !legacy.has(t));
    res.json({
      action_types: current,
      count: current.length,
      legacy_action_types: CATALOG_ACTION_TYPES.filter((t) => legacy.has(t)),
      legacy_note: 'Historical records from mechanisms the wallet no longer has (the agent-authorization gate, credential vault, relay agent sessions, agent policies, emergency stop, goal envelopes — all removed). Nothing emits them today; they remain recognized so older records still classify.',
      permissionless: true,
      custom_pattern: 'namespace:action_name',
      custom_regex: '^[a-z][a-z0-9]*:[a-z][a-z0-9_]*$',
      identifier_pattern: '^[a-zA-Z][a-zA-Z0-9_]*$',
      note: 'This is the seed catalog. Any valid identifier may be submitted on a witness lane; a type the network has never seen records with no mint and enters the public review queue (GET /v1/pe/earning-proposals). How each lane witnesses a new type is in GET /v1/pe/conformance/spec (custom_action_types). Types are catalogued as they are sealed; see GET /v1/pe/type-catalog for the live catalog.',
      spec_version: SPEC_VERSION,
    });
  });

  return router;
}
