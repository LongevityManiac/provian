/**
 * EnvironmentAttestation - Agent Environment Integrity Monitor
 *
 * Phase 4: Agent Environment Integrity
 *
 * Monitors the integrity of connected agents' configuration environments:
 * - Stores environment baselines per agent (set at connect time)
 * - Detects drift when agents re-attest (config/skills/prompt changes)
 * - Classifies skill installation as a commit action requiring approval
 *
 * CRITICAL: Attestation checks are background operations.
 * Do NOT add latency to the authorization hot path.
 * Performance budget: baseline lookups < 5ms (in-memory Map).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EnvironmentState } from '../provenance/types';
import { getItemHmac, setItemHmac } from '../security/hmacAsyncStorage';

// =============================================================================
// TYPES
// =============================================================================

/** Result of comparing current state against stored baseline */
export interface DriftResult {
    /** Whether any drift was detected */
    drift_detected: boolean;
    /** Which fields changed (empty if no drift) */
    changed_fields: string[];
    /** SHA-256 hash of the previous baseline state */
    previous_hash: string;
    /** SHA-256 hash of the current state */
    current_hash: string;
    /** Human-readable summary of changes */
    summary: string;
}

/** Stored baseline for a single agent */
export interface AgentEnvironmentBaseline {
    /** Agent identifier */
    agent_id: string;
    /** The baseline environment state (set at connect time) */
    baseline_state: EnvironmentState;
    /** SHA-256 hash of the baseline state (for quick comparison) */
    baseline_hash: string;
    /** When the baseline was first established */
    established_at: number;
    /** When the last successful attestation occurred */
    last_attested_at: number;
    /** Number of successful attestations since baseline */
    attestation_count: number;
    /** Number of drift events detected */
    drift_count: number;
}

/** Configuration for attestation behavior */
export interface AttestationConfig {
    /** How often agents should re-attest in hours (default: 6) */
    attestation_interval_hours: number;
    /** Whether to freeze agents on drift until user acknowledges (default: false) */
    freeze_on_drift: boolean;
}

const DEFAULT_ATTESTATION_CONFIG: AttestationConfig = {
    attestation_interval_hours: 6,
    freeze_on_drift: false,
};

// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEY = 'provian_environment_baselines';
const STORAGE_CONFIG_KEY = 'provian_attestation_config';

// =============================================================================
// ENVIRONMENT ATTESTATION TRACKER
// =============================================================================

/**
 * EnvironmentAttestationTracker
 *
 * Singleton that maintains per-agent environment baselines.
 * Baselines are established on agent connect and verified on re-attestation.
 * All storage is async; lookups are in-memory.
 */
class EnvironmentAttestationTracker {
    private static instance: EnvironmentAttestationTracker;

    /** In-memory baselines keyed by agent_id */
    private baselines: Map<string, AgentEnvironmentBaseline> = new Map();
    /** Whether storage has been loaded */
    private loaded = false;
    /** Attestation configuration */
    private config: AttestationConfig = DEFAULT_ATTESTATION_CONFIG;

    private constructor() {}

    static getInstance(): EnvironmentAttestationTracker {
        if (!EnvironmentAttestationTracker.instance) {
            EnvironmentAttestationTracker.instance = new EnvironmentAttestationTracker();
        }
        return EnvironmentAttestationTracker.instance;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.loadFromStorage();
            this.loaded = true;
        }
    }

    private async loadFromStorage(): Promise<void> {
        try {
            // HMAC-protected reads - tampered baselines / configs are
            // dropped silently and the next attestation re-establishes them.
            const data = await getItemHmac<AgentEnvironmentBaseline[]>(STORAGE_KEY);
            if (data) {
                for (const baseline of data) {
                    this.baselines.set(baseline.agent_id, baseline);
                }
            }

            const config = await getItemHmac<Partial<typeof DEFAULT_ATTESTATION_CONFIG>>(STORAGE_CONFIG_KEY);
            if (config) {
                this.config = { ...DEFAULT_ATTESTATION_CONFIG, ...config };
            }
        } catch (error) {
            console.error('[EnvironmentAttestation] Failed to load from storage:', error);
        }
    }

    private async saveToStorage(): Promise<void> {
        try {
            const data = Array.from(this.baselines.values());
            await setItemHmac(STORAGE_KEY, data);
        } catch (error) {
            console.error('[EnvironmentAttestation] Failed to save to storage:', error);
        }
    }

    // =========================================================================
    // BASELINE MANAGEMENT
    // =========================================================================

    /**
     * Establish a baseline for an agent. Called when agent first connects
     * and provides its environment state.
     */
    async establishBaseline(agentId: string, state: EnvironmentState): Promise<AgentEnvironmentBaseline> {
        await this.ensureLoaded();

        const now = Date.now();
        const stateHash = await this.hashState(state);

        const baseline: AgentEnvironmentBaseline = {
            agent_id: agentId,
            baseline_state: state,
            baseline_hash: stateHash,
            established_at: now,
            last_attested_at: now,
            attestation_count: 1,
            drift_count: 0,
        };

        this.baselines.set(agentId, baseline);

        // Save async (fire and forget)
        this.saveToStorage().catch((e) =>
            console.error('[EnvironmentAttestation] Save error:', e)
        );

        return baseline;
    }

    /**
     * Get the stored baseline for an agent. Returns null if no baseline exists.
     * This is synchronous and safe to call on the authorization path.
     */
    getBaseline(agentId: string): AgentEnvironmentBaseline | null {
        return this.baselines.get(agentId) || null;
    }

    /**
     * Check if an agent has an established baseline.
     */
    hasBaseline(agentId: string): boolean {
        return this.baselines.has(agentId);
    }

    // =========================================================================
    // ATTESTATION & DRIFT DETECTION
    // =========================================================================

    /**
     * Verify an agent's current environment state against its stored baseline.
     * Returns a DriftResult describing any changes detected.
     */
    async verifyAttestation(agentId: string, currentState: EnvironmentState): Promise<DriftResult> {
        await this.ensureLoaded();

        const baseline = this.baselines.get(agentId);
        if (!baseline) {
            // No baseline - treat as first attestation, establish it
            await this.establishBaseline(agentId, currentState);
            const hash = await this.hashState(currentState);
            return {
                drift_detected: false,
                changed_fields: [],
                previous_hash: hash,
                current_hash: hash,
                summary: 'Baseline established (first attestation)',
            };
        }

        const currentHash = await this.hashState(currentState);
        const previousHash = baseline.baseline_hash;

        // Quick check - if hashes match, no drift
        if (currentHash === previousHash) {
            // Update attestation metadata
            baseline.last_attested_at = Date.now();
            baseline.attestation_count++;
            this.baselines.set(agentId, baseline);

            this.saveToStorage().catch((e) =>
                console.error('[EnvironmentAttestation] Save error:', e)
            );

            return {
                drift_detected: false,
                changed_fields: [],
                previous_hash: previousHash,
                current_hash: currentHash,
                summary: 'Environment unchanged',
            };
        }

        // Hashes differ - find what changed
        const changedFields = this.detectChangedFields(baseline.baseline_state, currentState);

        // Update baseline with drift info
        baseline.last_attested_at = Date.now();
        baseline.attestation_count++;
        baseline.drift_count++;
        this.baselines.set(agentId, baseline);

        this.saveToStorage().catch((e) =>
            console.error('[EnvironmentAttestation] Save error:', e)
        );

        const summary = this.buildDriftSummary(changedFields, baseline.baseline_state, currentState);

        return {
            drift_detected: true,
            changed_fields: changedFields,
            previous_hash: previousHash,
            current_hash: currentHash,
            summary,
        };
    }

    /**
     * Update the baseline to the current state after user acknowledges drift.
     * This resets the baseline so future attestations compare against the new state.
     */
    async acknowledgeAndUpdateBaseline(agentId: string, newState: EnvironmentState): Promise<void> {
        await this.ensureLoaded();

        const existing = this.baselines.get(agentId);
        const now = Date.now();
        const stateHash = await this.hashState(newState);

        const baseline: AgentEnvironmentBaseline = {
            agent_id: agentId,
            baseline_state: newState,
            baseline_hash: stateHash,
            established_at: existing?.established_at || now,
            last_attested_at: now,
            attestation_count: (existing?.attestation_count || 0) + 1,
            drift_count: existing?.drift_count || 0,
        };

        this.baselines.set(agentId, baseline);

        this.saveToStorage().catch((e) =>
            console.error('[EnvironmentAttestation] Save error:', e)
        );
    }

    /**
     * Check if an agent is overdue for re-attestation.
     */
    isAttestationOverdue(agentId: string): boolean {
        const baseline = this.baselines.get(agentId);
        if (!baseline) return true;

        const intervalMs = this.config.attestation_interval_hours * 60 * 60 * 1000;
        return (Date.now() - baseline.last_attested_at) > intervalMs;
    }

    /**
     * Get the attestation configuration.
     */
    getConfig(): AttestationConfig {
        return { ...this.config };
    }

    /**
     * Update the attestation configuration.
     */
    async updateConfig(config: Partial<AttestationConfig>): Promise<void> {
        this.config = { ...this.config, ...config };
        try {
            await setItemHmac(STORAGE_CONFIG_KEY, this.config);
        } catch (error) {
            console.error('[EnvironmentAttestation] Failed to save config:', error);
        }
    }

    // =========================================================================
    // DRIFT DETECTION INTERNALS
    // =========================================================================

    /**
     * Compare two environment states field by field and return the names
     * of fields that changed.
     */
    private detectChangedFields(baseline: EnvironmentState, current: EnvironmentState): string[] {
        const changed: string[] = [];

        if (baseline.config_hash !== current.config_hash) {
            changed.push('config_hash');
        }
        if (baseline.skills_hash !== current.skills_hash) {
            changed.push('skills_hash');
        }
        if (baseline.system_prompt_hash !== current.system_prompt_hash) {
            changed.push('system_prompt_hash');
        }
        if (baseline.memory_hash !== current.memory_hash) {
            changed.push('memory_hash');
        }
        if (baseline.openclaw_version !== current.openclaw_version) {
            changed.push('openclaw_version');
        }

        // Check installed_skills list for additions/removals
        const baselineSkills = new Set(baseline.installed_skills);
        const currentSkills = new Set(current.installed_skills);

        const added = current.installed_skills.filter(s => !baselineSkills.has(s));
        const removed = baseline.installed_skills.filter(s => !currentSkills.has(s));

        if (added.length > 0 || removed.length > 0) {
            changed.push('installed_skills');
        }

        return changed;
    }

    /**
     * Build a human-readable summary of environment drift.
     */
    private buildDriftSummary(
        changedFields: string[],
        baseline: EnvironmentState,
        current: EnvironmentState
    ): string {
        const parts: string[] = [];

        if (changedFields.includes('config_hash')) {
            parts.push('Gateway configuration changed');
        }
        if (changedFields.includes('system_prompt_hash')) {
            parts.push('System prompt modified');
        }
        if (changedFields.includes('skills_hash') || changedFields.includes('installed_skills')) {
            const baselineSkills = new Set(baseline.installed_skills);
            const currentSkills = new Set(current.installed_skills);
            const added = current.installed_skills.filter(s => !baselineSkills.has(s));
            const removed = baseline.installed_skills.filter(s => !currentSkills.has(s));

            if (added.length > 0) {
                parts.push(`Skills added: ${added.join(', ')}`);
            }
            if (removed.length > 0) {
                parts.push(`Skills removed: ${removed.join(', ')}`);
            }
        }
        if (changedFields.includes('memory_hash')) {
            parts.push('Agent memory/context changed');
        }
        if (changedFields.includes('openclaw_version')) {
            parts.push(`OpenClaw version: ${baseline.openclaw_version} → ${current.openclaw_version}`);
        }

        return parts.length > 0 ? parts.join('; ') : 'Environment drift detected';
    }

    // =========================================================================
    // HASHING
    // =========================================================================

    /**
     * Compute a deterministic SHA-256 hash of an EnvironmentState.
     * Uses sorted JSON serialization for determinism.
     */
    private async hashState(state: EnvironmentState): Promise<string> {
        // Build a deterministic representation:
        // sort installed_skills, stringify with sorted keys
        const normalized = {
            config_hash: state.config_hash,
            installed_skills: [...state.installed_skills].sort(),
            memory_hash: state.memory_hash || '',
            openclaw_version: state.openclaw_version,
            skills_hash: state.skills_hash,
            system_prompt_hash: state.system_prompt_hash,
        };

        const serialized = JSON.stringify(normalized);

        // Use a simple hash implementation that works in React Native
        // (expo-crypto is available but would add an import - use the same
        // approach as BehavioralBaseline which uses plain string hashing)
        return this.sha256Hex(serialized);
    }

    /**
     * Simple SHA-256 hex digest. Uses the SubtleCrypto API when available,
     * falls back to a deterministic string hash for environments without it.
     */
    private async sha256Hex(input: string): Promise<string> {
        // React Native with expo-crypto provides a global crypto.subtle in newer versions
        // For robustness, use a simple DJB2-based hash as a fast fallback
        // In production the actual SHA-256 is computed server-side; this is for
        // local comparison only.
        try {
            if (typeof globalThis.crypto?.subtle?.digest === 'function') {
                const encoder = new TextEncoder();
                const data = encoder.encode(input);
                const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }
        } catch {
            // Fall through to fallback
        }

        // Fallback: FNV-1a 64-bit equivalent using two 32-bit hashes
        // Good enough for local drift detection (server does the real SHA-256)
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < input.length; i++) {
            const c = input.charCodeAt(i);
            h1 ^= c;
            h1 = Math.imul(h1, 0x01000193);
            h2 ^= c;
            h2 = Math.imul(h2, 0x811c9dc5);
        }
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    }

    // =========================================================================
    // UTILITY
    // =========================================================================

    /**
     * Remove the baseline for an agent (e.g., on disconnect).
     */
    async removeBaseline(agentId: string): Promise<void> {
        this.baselines.delete(agentId);
        await this.saveToStorage();
    }

    /**
     * Clear all baseline data (for testing or reset).
     */
    async clearAll(): Promise<void> {
        this.baselines.clear();
        this.loaded = false;
        this.config = DEFAULT_ATTESTATION_CONFIG;
        await AsyncStorage.removeItem(STORAGE_KEY);
        await AsyncStorage.removeItem(STORAGE_CONFIG_KEY);
    }
}

export default EnvironmentAttestationTracker.getInstance();

export { EnvironmentAttestationTracker };
