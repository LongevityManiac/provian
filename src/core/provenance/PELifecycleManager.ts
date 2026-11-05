import type { BiometricAction } from '../security/biometricAction';
/**
 * PELifecycleManager - Provenance Envelope Lifecycle Management
 *
 * Manages where the app's activity records (v1 envelopes) live ON THIS PHONE:
 * - Hot (AsyncStorage): the most recent days, for fast display
 * - Warm (local month archives, `<documents>/pe_archives/`): everything older, kept forever
 *
 * PEs are never deleted by any lifecycle. The former one-year "cold"
 * tier — which reduced a record to its hash and dropped its content — is gone: nothing here ever
 * removes a record's content. Every record is also kept in the PE meter's store and backed up,
 * encrypted, to the person's own iCloud / Google Drive (core/meter/).
 *
 * Runs archival sweeps on app launch and every 24 hours (moving records hot -> warm only).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ProvenanceEnvelope } from './types';
import { GENESIS_PREV_HASH } from './constants';
import { hashEnvelopeCanonical } from './peHash';
import { setItemHmac, getItemHmacWithLegacyFallback } from '../security/hmacAsyncStorage';
import {
    StorageTier,
    TierConfig,
    DEFAULT_TIER_CONFIG,
    ColdHashEntry,
    LocalPEStorage,
    ArchivalResult,
    CrossTierIntegrityResult,
    PEQueryOptions,
    PEQueryResult,
    MonthlyArchiveEntry,
    CloudArchiveIndex,
    IntegrityIssue,
    isLowPriorityPE,
    getMonthKey,
    classifyPETier,
} from './lifecycleTypes';
import PECloudSync from './PECloudSync';

// Storage keys
const STORAGE_KEYS = {
    /** Tiered storage structure */
    tieredStorage: 'provian_pe_tiered',
    /** Legacy monolithic storage (for migration) */
    legacyHistory: 'provian_pe_history',
    /** Chain head hash */
    chainHead: 'provian_pe_chain_head',
    /** Last archival timestamp */
    lastArchival: 'provian_pe_last_archival',
    /** Migration flag */
    migrationComplete: 'provian_pe_migration_complete',
};

// Archival interval (24 hours)
const ARCHIVAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Integrity issue callback
type IntegrityIssueCallback = (issue: IntegrityIssue) => void;
let integrityIssueCallback: IntegrityIssueCallback | null = null;

class PELifecycleManager {
    private static instance: PELifecycleManager;
    private config: TierConfig = DEFAULT_TIER_CONFIG;
    private archivalTimer: ReturnType<typeof setInterval> | null = null;
    private initialized = false;


    private constructor() {}

    static getInstance(): PELifecycleManager {
        if (!PELifecycleManager.instance) {
            PELifecycleManager.instance = new PELifecycleManager();
        }
        return PELifecycleManager.instance;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize the lifecycle manager.
     * Runs migration if needed and starts archival timer.
     */
    async initialize(biometricAction?: BiometricAction): Promise<void> {
        if (this.initialized) return;

        console.log('[PELifecycleManager] Initializing...');

        // Check if migration is needed
        const migrationComplete = await AsyncStorage.getItem(STORAGE_KEYS.migrationComplete);
        if (migrationComplete !== 'true') {
            console.log('[PELifecycleManager] Running migration from monolithic storage...');
            await this.migrateFromMonolithic(biometricAction);
        }

        // Run initial archival sweep
        await this.runArchivalSweep(biometricAction);

        // Start periodic archival (every 24 hours)
        this.startArchivalTimer();

        this.initialized = true;
        console.log('[PELifecycleManager] Initialized');
    }

    /**
     * Set the tier configuration.
     */
    setConfig(config: Partial<TierConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Register callback for integrity issues.
     */
    setIntegrityIssueCallback(callback: IntegrityIssueCallback | null): void {
        integrityIssueCallback = callback;
    }

    // =========================================================================
    // MIGRATION
    // =========================================================================

    /**
     * Migrate from monolithic PE storage to tiered storage.
     */
    private async migrateFromMonolithic(biometricAction?: BiometricAction): Promise<void> {
        try {
            // Load existing PEs from monolithic storage. [Group 9 / chunk-i]
            // The legacy key may have been written either as plain JSON
            // (pre-chunk-i) or as an HMAC envelope (post-chunk-i, after the
            // saveEnvelopeToHistory writer rewrote it). Use the migrating
            // helper so either source resolves correctly.
            const legacyPEs = await getItemHmacWithLegacyFallback<ProvenanceEnvelope[]>(
                STORAGE_KEYS.legacyHistory,
            );
            if (!legacyPEs) {
                console.log('[PELifecycleManager] No legacy storage found, starting fresh');
                await this.initializeFreshStorage();
                return;
            }

            console.log(`[PELifecycleManager] Migrating ${legacyPEs.length} PEs from legacy storage`);

            // Sort by timestamp (oldest first)
            legacyPEs.sort((a, b) => a.timestamp - b.timestamp);

            // Classify into tiers
            const now = Date.now();
            const hot: ProvenanceEnvelope[] = [];
            const warm: ProvenanceEnvelope[] = [];
            const cold: ProvenanceEnvelope[] = [];

            for (const pe of legacyPEs) {
                const tier = classifyPETier(pe, now, this.config);
                switch (tier) {
                    case 'hot':
                        hot.push(pe);
                        break;
                    case 'warm':
                        warm.push(pe);
                        break;
                    case 'cold':
                        cold.push(pe);
                        break;
                }
            }

            // Enforce hot tier count limit
            if (hot.length > this.config.hotMaxCount) {
                const overflow = hot.splice(0, hot.length - this.config.hotMaxCount);
                warm.push(...overflow);
            }

            // Archive warm tier to cloud
            if (warm.length > 0) {
                console.log(`[PELifecycleManager] Archiving ${warm.length} PEs to cloud...`);
                await PECloudSync.syncPEsToCloud(warm, biometricAction);
            }

            // Cold hashes: none are created any more (`classifyPETier` never answers cold); kept for the type.
            const coldHashes: ColdHashEntry[] = [];
            for (const pe of cold) {
                coldHashes.push({
                    hash: await this.hashEnvelope(pe),
                    timestamp: pe.timestamp,
                    actionType: pe.action_type,
                    envelopeId: pe.envelope_id,
                    lowPriority: isLowPriorityPE(pe),
                });
            }

            // Calculate warm boundary hash (links hot to warm)
            let warmBoundaryHash = GENESIS_PREV_HASH;
            if (warm.length > 0) {
                warmBoundaryHash = await this.hashEnvelope(warm[warm.length - 1]);
            } else if (cold.length > 0) {
                // If no warm tier, boundary is last cold PE
                warmBoundaryHash = coldHashes[coldHashes.length - 1]?.hash || GENESIS_PREV_HASH;
            }

            // Create tiered storage structure
            const tieredStorage: LocalPEStorage = {
                version: 1,
                hotPEs: hot,
                coldHashes,
                warmBoundaryHash,
                lastArchivalAt: now,
                migrationComplete: true,
            };

            // Save tiered storage
            await setItemHmac(STORAGE_KEYS.tieredStorage, tieredStorage);

            // Mark migration complete
            await AsyncStorage.setItem(STORAGE_KEYS.migrationComplete, 'true');

            // Create migration PE (meta!)
            // Note: This is done after migration to avoid recursion
            console.log(`[PELifecycleManager] Migration complete: ${hot.length} hot, ${warm.length} warm, ${coldHashes.length} cold`);

            // Delete legacy storage
            await AsyncStorage.removeItem(STORAGE_KEYS.legacyHistory);
            console.log('[PELifecycleManager] Legacy storage deleted');

        } catch (error) {
            console.error('[PELifecycleManager] Migration failed:', error);
            throw error;
        }
    }

    /**
     * Initialize fresh tiered storage.
     */
    private async initializeFreshStorage(): Promise<void> {
        const tieredStorage: LocalPEStorage = {
            version: 1,
            hotPEs: [],
            coldHashes: [],
            warmBoundaryHash: GENESIS_PREV_HASH,
            lastArchivalAt: Date.now(),
            migrationComplete: true,
        };
        await setItemHmac(STORAGE_KEYS.tieredStorage, tieredStorage);
        await AsyncStorage.setItem(STORAGE_KEYS.migrationComplete, 'true');
    }

    // =========================================================================
    // ARCHIVAL
    // =========================================================================

    /**
     * Start the periodic archival timer.
     */
    private startArchivalTimer(): void {
        if (this.archivalTimer) return;

        this.archivalTimer = setInterval(async () => {
            console.log('[PELifecycleManager] Running scheduled archival sweep...');
            await this.runArchivalSweep();
        }, ARCHIVAL_INTERVAL_MS);

        console.log('[PELifecycleManager] Archival timer started (24h interval)');
    }

    /**
     * Stop the archival timer.
     */
    stopArchivalTimer(): void {
        if (this.archivalTimer) {
            clearInterval(this.archivalTimer);
            this.archivalTimer = null;
            console.log('[PELifecycleManager] Archival timer stopped');
        }
    }

    /**
     * Run an archival sweep.
     * Moves PEs between tiers based on age.
     */
    async runArchivalSweep(biometricAction?: BiometricAction): Promise<ArchivalResult> {
        const startTime = Date.now();
        const result: ArchivalResult = {
            timestamp: startTime,
            hotTierCount: 0,
            archivedCount: 0,
            coldHashCount: 0,
            deletedCount: 0,
            errors: [],
            cloudSyncSuccess: true,
            durationMs: 0,
        };

        try {
            // Load current tiered storage
            const storage = await this.loadTieredStorage();
            const now = Date.now();

            // Classify current hot tier PEs
            const stillHot: ProvenanceEnvelope[] = [];
            const toArchive: ProvenanceEnvelope[] = [];

            for (const pe of storage.hotPEs) {
                const tier = classifyPETier(pe, now, this.config);
                if (tier === 'hot') {
                    stillHot.push(pe);
                } else {
                    toArchive.push(pe);
                }
            }

            // Enforce byte budget (primary) and count cap (secondary)
            stillHot.sort((a, b) => a.timestamp - b.timestamp);
            let hotSizeBytes = JSON.stringify(stillHot).length;

            // Primary: shed oldest PEs until under byte budget
            while (hotSizeBytes > this.config.hotMaxBytes && stillHot.length > 0) {
                toArchive.push(stillHot.shift()!);
                hotSizeBytes = JSON.stringify(stillHot).length;
            }

            // Secondary: count sanity cap
            if (stillHot.length > this.config.hotMaxCount) {
                const overflow = stillHot.splice(0, stillHot.length - this.config.hotMaxCount);
                toArchive.push(...overflow);
            }

            // Hash entries written by earlier builds are kept as they are; no new ones are made
            // (a record's content is never reduced to its hash).
            const updatedColdHashes: ColdHashEntry[] = [...storage.coldHashes];

            // Move aged records into the local month archives (files on this phone, never deleted).
            if (toArchive.length > 0) {
                try {
                    await PECloudSync.syncPEsToCloud(toArchive, biometricAction);
                    result.archivedCount = toArchive.length;
                } catch (error) {
                    console.error('[PELifecycleManager] Cloud sync failed:', error);
                    result.errors.push(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    result.cloudSyncSuccess = false;
                    // Keep PEs in hot tier if cloud sync fails
                    stillHot.push(...toArchive);
                }
            }

            // Update warm boundary hash
            let warmBoundaryHash = storage.warmBoundaryHash;
            if (toArchive.length > 0 && result.cloudSyncSuccess) {
                warmBoundaryHash = await this.hashEnvelope(toArchive[toArchive.length - 1]);
            }

            // Save updated storage
            const updatedStorage: LocalPEStorage = {
                version: storage.version,
                hotPEs: stillHot,
                coldHashes: updatedColdHashes,
                warmBoundaryHash,
                lastArchivalAt: now,
                migrationComplete: true,
            };

            await setItemHmac(STORAGE_KEYS.tieredStorage, updatedStorage);

            // The cloud copy of every record — hot ones included — is the PE meter's encrypted file
            // backup (core/meter/peCloudBackup.ts); this sweep only moves records between local tiers.

            result.hotTierCount = stillHot.length;
            result.coldHashCount = updatedColdHashes.length;
            result.durationMs = Date.now() - startTime;

            const finalHotBytes = JSON.stringify(updatedStorage.hotPEs).length;
            console.log(`[PELifecycleManager] Archival complete: ${result.hotTierCount} hot (${(finalHotBytes / (1024 * 1024)).toFixed(1)}MB), ${result.archivedCount} archived, ${result.coldHashCount} cold hashes (${result.durationMs}ms)`);

        } catch (error) {
            console.error('[PELifecycleManager] Archival sweep failed:', error);
            result.errors.push(`Archival failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        return result;
    }

    // =========================================================================
    // STORAGE ACCESS
    // =========================================================================

    /**
     * Load tiered storage from AsyncStorage.
     * [Group 9 / chunk-i] HMAC-protected with legacy fallback.
     */
    private async loadTieredStorage(): Promise<LocalPEStorage> {
        const stored = await getItemHmacWithLegacyFallback<LocalPEStorage>(STORAGE_KEYS.tieredStorage);
        if (stored) {
            return stored;
        }
        // Return empty structure if not found
        return {
            version: 1,
            hotPEs: [],
            coldHashes: [],
            warmBoundaryHash: GENESIS_PREV_HASH,
            lastArchivalAt: 0,
            migrationComplete: false,
        };
    }

    /**
     * Save a new PE to hot tier storage.
     * Called by ProvenanceEnvelopeManager after creating a PE.
     */
    async addPEToHotTier(pe: ProvenanceEnvelope, biometricAction?: BiometricAction): Promise<void> {
        const storage = await this.loadTieredStorage();
        // [Audit #40] Idempotent by envelope_id. flushQueueInternal re-queues the
        // un-written tail of a partially-flushed batch, and WAL crash-recovery can
        // re-present an already-written PE. Dedup here so a re-write is a no-op
        // instead of physically duplicating the PE in the hot tier (which shares
        // an envelope_id/prev_envelope_hash with its twin and tripped the
        // tiered-integrity diagnostic).
        if (storage.hotPEs.some(p => p.envelope_id === pe.envelope_id)) {
            return;
        }
        storage.hotPEs.push(pe);

        const hotSizeBytes = JSON.stringify(storage.hotPEs).length; // Byte approximation

        // Primary trigger: byte budget at 80% of hotMaxBytes
        // Secondary trigger: count sanity cap at 95% of hotMaxCount
        const byteTrigger = hotSizeBytes > this.config.hotMaxBytes * 0.8;
        const countTrigger = storage.hotPEs.length > this.config.hotMaxCount * 0.95;

        if (byteTrigger || countTrigger) {
            const reason = byteTrigger
                ? `bytes ${(hotSizeBytes / (1024 * 1024)).toFixed(1)}MB > ${(this.config.hotMaxBytes * 0.8 / (1024 * 1024)).toFixed(0)}MB`
                : `count ${storage.hotPEs.length} > ${Math.floor(this.config.hotMaxCount * 0.95)}`;
            console.log(`[PELifecycleManager] Hot tier overflow (${reason}), triggering archival...`);
            // [Audit #40 follow-up] Persist the just-pushed PE BEFORE the sweep.
            // runArchivalSweep re-reads tiered storage FRESH from disk (there is
            // no in-memory cache), so without this write the PE we pushed above
            // is silently discarded — lost from hot storage AND (after the flush
            // clears the WAL) from the WAL too, while the chain head still
            // references it, breaking the hash chain. Persisting first makes the
            // PE durable before the sweep reclassifies it, honoring the flush
            // "count only what is durably written" contract.
            await setItemHmac(STORAGE_KEYS.tieredStorage, storage);
            await this.runArchivalSweep(biometricAction);
        } else {
            await setItemHmac(STORAGE_KEYS.tieredStorage, storage);
        }
    }

    /**
     * Get hot tier PEs (fast, for recent activity display).
     */
    async getHotTierPEs(): Promise<ProvenanceEnvelope[]> {
        const storage = await this.loadTieredStorage();
        return storage.hotPEs;
    }

    /**
     * Get hot tier count for display.
     */
    async getHotTierCount(): Promise<number> {
        const storage = await this.loadTieredStorage();
        return storage.hotPEs.length;
    }

    /**
     * Set the hidden flag on a PE in hot tier storage.
     * Hidden PEs are excluded from default queries but remain in the chain.
     * This is a display-only change - the PE itself is immutable.
     */
    async setPEHidden(envelopeId: string, hidden: boolean): Promise<boolean> {
        const storage = await this.loadTieredStorage();
        const pe = storage.hotPEs.find(p => p.envelope_id === envelopeId);
        if (!pe) return false;

        pe.hidden = hidden;
        await setItemHmac(STORAGE_KEYS.tieredStorage, storage);
        return true;
    }

    /**
     * Get storage summary for settings display.
     */
    async getStorageSummary(): Promise<{
        hotCount: number;
        hotSizeBytes: number;
        warmCount: number;
        coldHashCount: number;
        lastSyncAt: number;
    }> {
        const storage = await this.loadTieredStorage();
        const cloudIndex = await PECloudSync.getCloudArchiveIndex();

        const hotJson = JSON.stringify(storage.hotPEs);
        const hotSizeBytes = new TextEncoder().encode(hotJson).length;

        return {
            hotCount: storage.hotPEs.length,
            hotSizeBytes,
            warmCount: cloudIndex?.totalPECount || 0,
            coldHashCount: storage.coldHashes.length,
            lastSyncAt: cloudIndex?.lastSyncAt || 0,
        };
    }

    // =========================================================================
    // QUERY / RETRIEVAL
    // =========================================================================

    /**
     * Query PEs across all tiers.
     */
    async queryPEs(options: PEQueryOptions = {}, biometricAction?: BiometricAction): Promise<PEQueryResult> {
        const result: PEQueryResult = {
            envelopes: [],
            totalCount: 0,
            hasMore: false,
            sourceTiers: [],
            cloudFetchRequired: false,
        };

        // Start with hot tier
        const storage = await this.loadTieredStorage();
        let candidates = [...storage.hotPEs];
        result.sourceTiers.push('hot');

        // Apply filters
        candidates = this.filterPEs(candidates, options);

        // Check if we need warm tier
        const limit = options.limit || 100;
        const offset = options.offset || 0;

        if (candidates.length < limit + offset) {
            // Need to fetch from cloud
            if (options.startDate || options.endDate) {
                // Date range query - fetch specific months
                const warmPEs = await PECloudSync.fetchPEsByDateRange(
                    options.startDate || 0,
                    options.endDate || Date.now(), biometricAction
                );
                candidates = [...candidates, ...this.filterPEs(warmPEs, options)];
                result.sourceTiers.push('warm');
                result.cloudFetchRequired = true;
            }
        }

        // Sort by timestamp (newest first)
        candidates.sort((a, b) => b.timestamp - a.timestamp);

        // Apply pagination
        result.totalCount = candidates.length;
        result.envelopes = candidates.slice(offset, offset + limit);
        result.hasMore = offset + limit < candidates.length;

        return result;
    }

    /**
     * Filter PEs based on query options.
     */
    private filterPEs(pes: ProvenanceEnvelope[], options: PEQueryOptions): ProvenanceEnvelope[] {
        return pes.filter(pe => {
            // Hidden filter (default: exclude hidden)
            if (!options.includeHidden && pe.hidden) return false;

            // Date range
            if (options.startDate && pe.timestamp < options.startDate) return false;
            if (options.endDate && pe.timestamp > options.endDate) return false;

            // Action types
            if (options.actionTypes && !options.actionTypes.includes(pe.action_type)) return false;

            // Agent ID
            if (options.agentId && pe.agent_id !== options.agentId) return false;

            // Auth decision
            if (options.authDecision && pe.authorization_decision !== options.authDecision) return false;

            // Low priority filter
            if (!options.includeLowPriority && isLowPriorityPE(pe)) return false;

            return true;
        });
    }

    /**
     * Load PEs from a specific month archive.
     */
    async loadMonthArchive(monthKey: string, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope[]> {
        return await PECloudSync.fetchPEsByMonth(monthKey, biometricAction);
    }

    /**
     * Get list of available month archives.
     */
    async getAvailableArchives(): Promise<MonthlyArchiveEntry[]> {
        const index = await PECloudSync.getCloudArchiveIndex();
        return index?.archives || [];
    }

    // =========================================================================
    // INTEGRITY VERIFICATION
    // =========================================================================

    /**
     * Verify integrity across all tiers.
     */
    async verifyCrossTierIntegrity(): Promise<CrossTierIntegrityResult> {
        const result: CrossTierIntegrityResult = {
            valid: true,
            hotTierValid: true,
            hotTierCount: 0,
            boundaryValid: true,
            coldTierValid: true,
            coldTierCount: 0,
            errors: [],
            verifiedAt: Date.now(),
        };

        try {
            const storage = await this.loadTieredStorage();
            result.hotTierCount = storage.hotPEs.length;
            result.coldTierCount = storage.coldHashes.length;

            // Verify hot tier chain
            if (storage.hotPEs.length > 0) {
                const hotResult = await this.verifyHotTierChain(storage.hotPEs);
                result.hotTierValid = hotResult.valid;
                if (!hotResult.valid) {
                    result.valid = false;
                    result.errors.push(hotResult.error || 'Hot tier chain invalid');
                    this.reportIntegrityIssue({
                        type: 'hash_mismatch',
                        affectedPEIds: [hotResult.brokenEnvelopeId || ''],
                        description: hotResult.error || 'Hot tier chain hash mismatch',
                        detectedAt: Date.now(),
                        severity: 'critical',
                    });
                }
            }

            // Verify hot-to-warm boundary
            if (storage.hotPEs.length > 0 && storage.warmBoundaryHash !== GENESIS_PREV_HASH) {
                const firstHotPE = storage.hotPEs[0];
                if (firstHotPE.prev_envelope_hash !== storage.warmBoundaryHash) {
                    result.boundaryValid = false;
                    result.valid = false;
                    result.boundaryError = 'Hot tier does not link to warm boundary';
                    result.errors.push(result.boundaryError);
                    this.reportIntegrityIssue({
                        type: 'boundary_mismatch',
                        affectedPEIds: [firstHotPE.envelope_id],
                        description: 'Hot tier first PE does not link to archived PEs',
                        detectedAt: Date.now(),
                        severity: 'warning',
                    });
                }
            }

            // Verify cold hashes are contiguous (basic check)
            if (storage.coldHashes.length > 1) {
                const sorted = [...storage.coldHashes].sort((a, b) => a.timestamp - b.timestamp);
                // Check for large gaps (more than 30 days without any PE)
                for (let i = 1; i < sorted.length; i++) {
                    const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
                    if (gap > 30 * 24 * 60 * 60 * 1000) {
                        result.coldTierValid = false;
                        result.errors.push(`Large gap in cold hashes between ${sorted[i - 1].envelopeId} and ${sorted[i].envelopeId}`);
                    }
                }
            }

        } catch (error) {
            result.valid = false;
            result.errors.push(`Verification error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        return result;
    }

    /**
     * Verify hot tier chain integrity.
     */
    private async verifyHotTierChain(pes: ProvenanceEnvelope[]): Promise<{
        valid: boolean;
        error?: string;
        brokenEnvelopeId?: string;
    }> {
        if (pes.length === 0) return { valid: true };

        // Sort by timestamp
        const sorted = [...pes].sort((a, b) => a.timestamp - b.timestamp);

        for (let i = 1; i < sorted.length; i++) {
            const prevPE = sorted[i - 1];
            const currentPE = sorted[i];

            const expectedHash = await this.hashEnvelope(prevPE);
            if (currentPE.prev_envelope_hash !== expectedHash) {
                return {
                    valid: false,
                    error: `Chain broken at PE ${currentPE.envelope_id}: expected ${expectedHash}, got ${currentPE.prev_envelope_hash}`,
                    brokenEnvelopeId: currentPE.envelope_id,
                };
            }
        }

        return { valid: true };
    }

    /**
     * Report an integrity issue.
     */
    private reportIntegrityIssue(issue: IntegrityIssue): void {
        console.error('[PELifecycleManager] Integrity issue:', issue);
        if (integrityIssueCallback) {
            integrityIssueCallback(issue);
        }
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    // =========================================================================
    // PE RESTORATION (for wallet recovery)
    // =========================================================================

    /**
     * Restore activity records a wallet backed up BEFORE the PE meter (month archives an older build
     * pushed to synced keychain items / Drive). Current backups are restored by the PE meter
     * (`PhoneMeter.restoreAfterRecovery`), which calls `restoreEnvelopes` below.
     *
     * Recovery never depends on the relay holding PEs: the former fallback that rebuilt history from
     * the relay's PE summaries is gone with the relay's PE storage.
     */
    async restorePEsAfterRecovery(biometricAction?: BiometricAction): Promise<{ restoredCount: number; source: 'cloud' | 'none' }> {
        console.log('[PELifecycleManager] Restoring pre-meter activity archives...');
        const allPEs: ProvenanceEnvelope[] = [];
        try {
            await PECloudSync.initialize();
            const cloudIndex = await PECloudSync.getCloudArchiveIndex();
            if (cloudIndex && cloudIndex.archives.length > 0) {
                for (const entry of cloudIndex.archives) {
                    try {
                        allPEs.push(...await PECloudSync.fetchPEsByMonth(entry.monthKey, biometricAction));
                    } catch (err) {
                        console.warn(`[PELifecycleManager] Failed to fetch archive ${entry.monthKey}:`, err);
                    }
                }
            }
        } catch (err) {
            console.warn('[PELifecycleManager] Pre-meter archive restoration failed:', err);
        }
        if (allPEs.length === 0) return { restoredCount: 0, source: 'none' };
        const restoredCount = await this.restoreEnvelopes(allPEs, biometricAction);
        return { restoredCount, source: 'cloud' };
    }

    /**
     * Put restored activity records back where the app's screens read them: recent ones in the hot
     * tier, older ones in the local month archives. Idempotent by envelope_id. Nothing is reduced
     * to a hash. Sets the chain head to the restored tip so new records link after it.
     */
    async restoreEnvelopes(envelopes: readonly ProvenanceEnvelope[], biometricAction?: BiometricAction): Promise<number> {
        const seen = new Set<string>();
        const allPEs = [...envelopes]
            .filter((pe) => pe && typeof pe.envelope_id === 'string')
            .sort((a, b) => a.timestamp - b.timestamp)
            .filter((pe) => {
                if (seen.has(pe.envelope_id)) return false;
                seen.add(pe.envelope_id);
                return true;
            });
        if (allPEs.length === 0) return 0;

        const now = Date.now();
        const storage = await this.loadTieredStorage();
        const existingIds = new Set(storage.hotPEs.map(p => p.envelope_id));
        const hotPEs: ProvenanceEnvelope[] = [];
        const warmPEs: ProvenanceEnvelope[] = [];
        for (const pe of allPEs) {
            if (existingIds.has(pe.envelope_id)) continue;
            if (classifyPETier(pe, now, this.config) === 'hot') hotPEs.push(pe);
            else warmPEs.push(pe);
        }

        storage.hotPEs = [...storage.hotPEs, ...hotPEs].sort((a, b) => a.timestamp - b.timestamp);
        if (warmPEs.length > 0) {
            storage.warmBoundaryHash = await this.hashEnvelope(warmPEs[warmPEs.length - 1]);
        }
        storage.migrationComplete = true;
        await setItemHmac(STORAGE_KEYS.tieredStorage, storage);
        await AsyncStorage.setItem(STORAGE_KEYS.migrationComplete, 'true');

        if (warmPEs.length > 0) {
            try {
                await PECloudSync.syncPEsToCloud(warmPEs, biometricAction);
            } catch (err) {
                console.warn('[PELifecycleManager] Failed to write restored records to the local month archives:', err);
            }
        }

        const lastHash = await this.hashEnvelope(allPEs[allPEs.length - 1]);
        await setItemHmac(STORAGE_KEYS.chainHead, lastHash);

        const restored = hotPEs.length + warmPEs.length;
        console.log(`[PELifecycleManager] Restored ${restored} records (${hotPEs.length} hot, ${warmPEs.length} archived)`);
        return restored;
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    /**
     * Hash a PE. Delegates to the single canonical hasher (peHash.ts) so the
     * warm-boundary hash, cold-tier hashes, and hot-tier chain checks here use
     * the EXACT same hash that ProvenanceEnvelopeManager wrote into each PE's
     * prev_envelope_hash. The previous local JSON.stringify(pe) implementation
     * both included the signature and was non-canonical, so it could never
     * match a real prev_envelope_hash.
     */
    private async hashEnvelope(pe: ProvenanceEnvelope): Promise<string> {
        return hashEnvelopeCanonical(pe);
    }
}

export default PELifecycleManager.getInstance();
