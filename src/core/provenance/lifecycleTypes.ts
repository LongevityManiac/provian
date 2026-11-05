/**
 * PE Lifecycle Management Types
 *
 * Types for tiered PE storage and lifecycle management.
 */

import { ProvenanceEnvelope, ActionType } from './types';

// =============================================================================
// STORAGE TIERS
// =============================================================================

/**
 * Storage tier classification.
 */
/** 'cold' survives only to read storage an earlier build wrote; nothing classifies a PE as cold now. */
export type StorageTier = 'hot' | 'warm' | 'cold';

/**
 * Configuration for tiered storage thresholds.
 */
export interface TierConfig {
    /** Hot tier: PEs younger than this (default: 3 days) */
    hotMaxAgeMs: number;
    /** UNUSED since the PE meter: there is no age past which a PE is reduced or dropped. Kept for config compatibility. */
    warmMaxAgeMs: number;
    /** Hot tier: Max bytes before archival (default: 50MB) - primary trigger */
    hotMaxBytes: number;
    /** Hot tier: Max PE count (default: 50000) - secondary sanity cap */
    hotMaxCount: number;
    /** Denied/expired PE retention in hot tier (default: 48 hours) */
    deniedRetentionMs: number;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
    hotMaxAgeMs: 3 * 24 * 60 * 60 * 1000,           // 3 days
    warmMaxAgeMs: Number.MAX_SAFE_INTEGER,          // no cold tier (PEs are never reduced or deleted)
    hotMaxBytes: 50 * 1024 * 1024,                   // 50 MB
    hotMaxCount: 50000,                              // Secondary sanity cap
    deniedRetentionMs: 48 * 60 * 60 * 1000,         // 48 hours
};

// =============================================================================
// COLD HASH STORAGE
// =============================================================================

/**
 * Hash entries an EARLIER build wrote for "cold-tier" PEs. Read-only history: no new ones are
 * written, because no PE is ever reduced to its hash.
 */
export interface ColdHashEntry {
    /**
     * SHA256 canonical hash of the full PE — UNLESS `summaryOnly` is true, in
     * which case no full payload was available and this holds the envelope_id
     * (a UUID) as a stand-in, not a real hash. Never compare this against a
     * prev_envelope_hash when summaryOnly is set.
     */
    hash: string;
    /**
     * True when this entry was reconstructed from a backend summary (no full PE
     * payload), so `hash` is the envelope_id placeholder rather than a real
     * canonical hash.
     */
    summaryOnly?: boolean;
    /** Original PE timestamp */
    timestamp: number;
    /** Action type for filtering */
    actionType: ActionType;
    /** PE ID for retrieval from cloud */
    envelopeId: string;
    /** Whether this was a denied/expired action (low priority) */
    lowPriority?: boolean;
}

// =============================================================================
// CLOUD ARCHIVE FORMAT
// =============================================================================

/**
 * Monthly archive metadata in the index file.
 */
export interface MonthlyArchiveEntry {
    /** Archive file name (e.g., "provian_pe_archive_2026_02.enc") */
    fileName: string;
    /** Year-month key (e.g., "2026-02") */
    monthKey: string;
    /** Number of PEs in this archive */
    peCount: number;
    /** Hash of first PE in archive (for chain linking) */
    firstPEHash: string;
    /** Hash of last PE in archive (for chain linking) */
    lastPEHash: string;
    /** IDs of first and last PEs for efficient range queries */
    firstPEId: string;
    lastPEId: string;
    /** Timestamps for range queries */
    firstTimestamp: number;
    lastTimestamp: number;
    /** Size in bytes (for storage display) */
    sizeBytes: number;
    /** Low priority (denied/expired) PE count */
    lowPriorityCount: number;
}

/**
 * Cloud archive index file structure.
 */
export interface CloudArchiveIndex {
    /** Version for future migrations */
    version: number;
    /** Wallet address this archive belongs to */
    walletAddress: string;
    /** Total PE count across all archives */
    totalPECount: number;
    /** Last sync timestamp */
    lastSyncAt: number;
    /** Monthly archive entries */
    archives: MonthlyArchiveEntry[];
    /** Boundary hash: first PE hash in oldest archive (links to cold hashes) */
    oldestArchiveFirstHash: string;
    /** Boundary hash: last PE hash in newest archive (links to hot tier) */
    newestArchiveLastHash: string;
    /**
     * Hex KDF salt for the AES-256-GCM archive key. Mirrored here (plaintext —
     * a salt is not secret) so a device that restores the wallet seed derives
     * the SAME archive key and can decrypt the cloud archives. Optional for
     * back-compat with indexes written before seed-derived keying.
     */
    encryptionSalt?: string;
}

/**
 * Encrypted archive file structure (before encryption).
 */
export interface CloudArchiveFile {
    /** Version for future migrations */
    version: number;
    /** Month key this archive covers */
    monthKey: string;
    /** The archived PEs */
    envelopes: ProvenanceEnvelope[];
    /** Checksum for integrity */
    checksum: string;
}

// =============================================================================
// ARCHIVAL RESULTS
// =============================================================================

/**
 * Result of an archival sweep.
 */
export interface ArchivalResult {
    /** Timestamp of archival */
    timestamp: number;
    /** PEs kept in hot tier */
    hotTierCount: number;
    /** PEs moved to warm tier (cloud) */
    archivedCount: number;
    /** Hash entries held from earlier builds (none are created any more). */
    coldHashCount: number;
    /** Always 0: no lifecycle deletes a PE. */
    deletedCount: number;
    /** Errors encountered */
    errors: string[];
    /** Whether cloud sync succeeded */
    cloudSyncSuccess: boolean;
    /** Duration in ms */
    durationMs: number;
}

// =============================================================================
// INTEGRITY VERIFICATION (CROSS-TIER)
// =============================================================================

/**
 * Cross-tier integrity verification result.
 */
export interface CrossTierIntegrityResult {
    /** Overall validity */
    valid: boolean;
    /** Hot tier verification result */
    hotTierValid: boolean;
    hotTierCount: number;
    /** Hot-to-warm boundary valid */
    boundaryValid: boolean;
    boundaryError?: string;
    /** Cold tier hash contiguity valid */
    coldTierValid: boolean;
    coldTierCount: number;
    /** Errors */
    errors: string[];
    /** Timestamp of verification */
    verifiedAt: number;
}

// =============================================================================
// LOCAL STORAGE STRUCTURE
// =============================================================================

/**
 * Local storage structure for tiered PEs.
 */
export interface LocalPEStorage {
    /** Version for migrations */
    version: number;
    /** Hot tier PEs */
    hotPEs: ProvenanceEnvelope[];
    /** Cold tier hash entries */
    coldHashes: ColdHashEntry[];
    /** Boundary hash: links hot tier to warm tier */
    warmBoundaryHash: string;
    /** Last archival timestamp */
    lastArchivalAt: number;
    /** Whether migration from monolithic storage is complete */
    migrationComplete: boolean;
}

// =============================================================================
// RETRIEVAL
// =============================================================================

/**
 * Query options for PE retrieval.
 */
export interface PEQueryOptions {
    /** Date range filter */
    startDate?: number;
    endDate?: number;
    /** Action type filter */
    actionTypes?: ActionType[];
    /** Agent ID filter */
    agentId?: string;
    /** Authorization decision filter */
    authDecision?: 'allow' | 'deny' | 'require_human';
    /** Include low priority (denied/expired) */
    includeLowPriority?: boolean;
    /** Include hidden PEs (default: false) */
    includeHidden?: boolean;
    /** Limit results */
    limit?: number;
    /** Offset for pagination */
    offset?: number;
}

/**
 * Result of PE retrieval.
 */
export interface PEQueryResult {
    /** Retrieved PEs */
    envelopes: ProvenanceEnvelope[];
    /** Total count (for pagination) */
    totalCount: number;
    /** Whether more results exist */
    hasMore: boolean;
    /** Source tiers consulted */
    sourceTiers: StorageTier[];
    /** Whether cloud fetch was required */
    cloudFetchRequired: boolean;
}

// =============================================================================
// EXPORT
// =============================================================================

/**
 * Export format options.
 */
export type ExportFormat = 'json' | 'csv';

/**
 * Export result.
 */
export interface ExportResult {
    /** File path or data URI */
    filePath: string;
    /** Format used */
    format: ExportFormat;
    /** PE count exported */
    peCount: number;
    /** File size in bytes */
    sizeBytes: number;
    /** Generation timestamp */
    generatedAt: number;
}

// =============================================================================
// NOTIFICATIONS
// =============================================================================

/**
 * Integrity issue notification.
 */
export interface IntegrityIssue {
    /** Issue type */
    type: 'gap' | 'hash_mismatch' | 'boundary_mismatch' | 'cloud_mismatch';
    /** Affected PE IDs */
    affectedPEIds: string[];
    /** Human-readable description */
    description: string;
    /** When detected */
    detectedAt: number;
    /** Severity */
    severity: 'warning' | 'critical';
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a PE is considered "denied/expired" (low priority for retention).
 */
export function isLowPriorityPE(pe: ProvenanceEnvelope): boolean {
    // Denied agent authorizations
    if (pe.authorization_decision === 'deny') {
        return true;
    }

    // Expired negotiations
    if (
        pe.action_type === 'negotiation_expired' ||
        pe.action_type === 'negotiation_rejected'
    ) {
        return true;
    }

    // Failed/cancelled actions
    if (pe.policy_decision === 'block') {
        return true;
    }

    return false;
}

/**
 * Get the month key for a timestamp (YYYY-MM format).
 */
export function getMonthKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * Classify a PE into a storage tier based on age and config: 'hot' (recent, for fast display) or
 * 'warm' (the local month archives). Never 'cold' PEs are never deleted or reduced to a hash by
 * any lifecycle, however old they are.
 */
export function classifyPETier(
    pe: ProvenanceEnvelope,
    now: number,
    config: TierConfig = DEFAULT_TIER_CONFIG
): StorageTier {
    const age = now - pe.timestamp;
    const isLowPriority = isLowPriorityPE(pe);

    // Low priority PEs leave the hot tier sooner (to the archives — never deleted)
    if (isLowPriority && age > config.deniedRetentionMs) {
        return 'warm';
    }

    if (age < config.hotMaxAgeMs) {
        return 'hot';
    }

    return 'warm';
}
