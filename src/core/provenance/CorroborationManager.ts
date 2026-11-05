import type { BiometricAction } from '../security/biometricAction';
/**
 * CorroborationManager - Automated Corroboration Signal PE Generator
 *
 * Called by existing system flows (x402 settlement, proxied payment,
 * promise fulfillment, etc.) to emit corroboration_signal
 * PEs that upgrade the target PE's attestation tier from 'software' (0.8x)
 * to 'corroborated' (1.1x) for PVT minting weight.
 *
 * This module is NEVER called by users. It operates entirely in the
 * backend/service layer. All emissions are fire-and-forget.
 *
 * SECURITY INVARIANT (from CLAUDE.md #8):
 * - Never suppress, delay, or filter valid corroboration signals
 * - Invalid signals (missing target_pe_id) are rejected, not suppressed
 */

import * as Crypto from 'expo-crypto';
import ProvenanceEnvelopeManager from './ProvenanceEnvelopeManager';
import type { CorroborationSignalType, CorroborationSignalPEDetails } from './CorroborationTypes';

export interface CorroborationSignalInput {
  /** The PE envelope_id being corroborated */
  targetPeId: string;
  /** Hash of the target PE (for verification) */
  targetPeHash: string;
  /** The corroboration signal type */
  signalType: CorroborationSignalType;
  /** Who/what is corroborating - wallet_id or 'system' */
  corroboratingParty: string;
  /** The evidence to hash (tx hash, response body, session data, etc.) */
  evidence: string;
  /** Human-readable reference (tx hash, job_id, session_id, etc.) */
  evidenceRef?: string;
}

class CorroborationManager {
  private static instance: CorroborationManager;

  private constructor() {}

  static getInstance(): CorroborationManager {
    if (!CorroborationManager.instance) {
      CorroborationManager.instance = new CorroborationManager();
    }
    return CorroborationManager.instance;
  }

  /**
   * Emit a corroboration signal PE.
   *
   * Call this at natural completion events (escrow completed, promise fulfilled,
   * x402 settled, etc.). Fire-and-forget - errors are logged but never thrown.
   *
   * @param input Corroboration signal details
   */
  async emitCorroboration(input: CorroborationSignalInput, biometricAction?: BiometricAction): Promise<void> {
    // Validate required fields - reject invalid signals (don't suppress)
    if (!input.targetPeId) {
      console.warn('[CorroborationManager] Rejected: missing target_pe_id');
      return;
    }
    if (!input.targetPeHash) {
      console.warn('[CorroborationManager] Rejected: missing target_pe_hash');
      return;
    }
    if (!input.evidence) {
      console.warn('[CorroborationManager] Rejected: missing evidence');
      return;
    }

    try {
      // Hash the evidence
      const evidenceHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        input.evidence,
      );

      const corroborationMetadata: CorroborationSignalPEDetails = {
        target_pe_id: input.targetPeId,
        target_pe_hash: input.targetPeHash,
        corroborating_party: input.corroboratingParty,
        signal_type: input.signalType,
        evidence_hash: evidenceHash,
        evidence_ref: input.evidenceRef,
        automated: true,
      };

      await ProvenanceEnvelopeManager.createEnvelope({
        actionType: 'corroboration_signal',
        intentText: `Corroboration: ${input.signalType} for PE ${input.targetPeId.slice(0, 12)}...`,
        assetSymbol: 'CORROBORATION',
        amount: '0',
        chainId: 0,
        riskScore: 0,
        riskCategory: 'low',
        policyDecision: 'allow',
        corroborationMetadata: corroborationMetadata,
      }, biometricAction);

      console.log(
        `[CorroborationManager] Emitted ${input.signalType} for PE ${input.targetPeId.slice(0, 12)}`,
      );
    } catch (err) {
      // Fire-and-forget: log but never throw
      console.warn('[CorroborationManager] Failed to emit corroboration signal:', err);
    }
  }
}

export default CorroborationManager.getInstance();
