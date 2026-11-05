/**
 * SpendingPolicy - Policy Storage and Management
 *
 * Manages spending policies for agents. Policies define what agents
 * are allowed to do and under what conditions.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import {
    SpendingPolicy,
    PolicyUsage,
    DEFAULT_POLICY_TEMPLATE,
    PolicyStatus,
    SpendingLimits,
    CategoryControls,
    MerchantControls,
    RailControls,
    ScheduleControls,
    FrictionThresholds,
    AgentCapabilities,
    CardAccessMode,
} from './types';
import type { CryptoSpendingControls } from './CryptoSpendingGovernance';

const STORAGE_KEYS = {
    policies: 'provian_spending_policies',
    policyUsage: 'provian_policy_usage',
};

class SpendingPolicyManager {
    private static instance: SpendingPolicyManager;
    private loaded = false;
    private policies: Map<string, SpendingPolicy> = new Map();
    private policyByAgent: Map<string, string> = new Map(); // agentId -> policyId
    private usage: Map<string, PolicyUsage> = new Map();

    private constructor() {}

    static getInstance(): SpendingPolicyManager {
        if (!SpendingPolicyManager.instance) {
            SpendingPolicyManager.instance = new SpendingPolicyManager();
        }
        return SpendingPolicyManager.instance;
    }

    // =====================
    // INITIALIZATION
    // =====================

    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.loadFromStorage();
            this.loaded = true;
        }
    }

    private async loadFromStorage(): Promise<void> {
        try {
            const policiesJson = await AsyncStorage.getItem(STORAGE_KEYS.policies);
            if (policiesJson) {
                const policies: SpendingPolicy[] = JSON.parse(policiesJson);
                policies.forEach((p) => {
                    this.policies.set(p.id, p);
                    this.policyByAgent.set(p.agentId, p.id);
                });
            }

            const usageJson = await AsyncStorage.getItem(STORAGE_KEYS.policyUsage);
            if (usageJson) {
                const usageArray: PolicyUsage[] = JSON.parse(usageJson);
                usageArray.forEach((u) => this.usage.set(u.policyId, u));
            }
        } catch (error) {
            console.error('[SpendingPolicyManager] Failed to load from storage:', error);
        }
    }

    private async saveToStorage(): Promise<void> {
        const policies = Array.from(this.policies.values());
        await AsyncStorage.setItem(STORAGE_KEYS.policies, JSON.stringify(policies));

        const usage = Array.from(this.usage.values());
        await AsyncStorage.setItem(STORAGE_KEYS.policyUsage, JSON.stringify(usage));
    }

    // =====================
    // POLICY CRUD
    // =====================

    /**
     * Create a new spending policy for an agent.
     */
    async createPolicy(params: {
        agentId: string;
        name: string;
        description?: string;
        limits?: Partial<SpendingLimits>;
        categories?: Partial<CategoryControls>;
        merchants?: Partial<MerchantControls>;
        rails?: Partial<RailControls>;
        schedule?: Partial<ScheduleControls>;
        friction?: Partial<FrictionThresholds>;
        capabilities?: Partial<AgentCapabilities>;
        cardAccessMode?: CardAccessMode;
        cryptoControls?: CryptoSpendingControls;
    }): Promise<SpendingPolicy> {
        await this.ensureLoaded();

        const now = Date.now();
        const policyId = uuidv4();

        const policy: SpendingPolicy = {
            id: policyId,
            agentId: params.agentId,
            name: params.name,
            description: params.description,
            limits: { ...DEFAULT_POLICY_TEMPLATE.limits, ...params.limits },
            categories: { ...DEFAULT_POLICY_TEMPLATE.categories, ...params.categories },
            merchants: { ...DEFAULT_POLICY_TEMPLATE.merchants, ...params.merchants },
            rails: { ...DEFAULT_POLICY_TEMPLATE.rails, ...params.rails },
            schedule: { ...DEFAULT_POLICY_TEMPLATE.schedule, ...params.schedule },
            friction: { ...DEFAULT_POLICY_TEMPLATE.friction, ...params.friction },
            capabilities: { ...DEFAULT_POLICY_TEMPLATE.capabilities, ...params.capabilities },
            cardAccessMode: params.cardAccessMode || 'provian_holds',
            cryptoControls: params.cryptoControls,
            status: 'active',
            createdAt: now,
            updatedAt: now,
        };

        // If agent already has a policy, archive it
        const existingPolicyId = this.policyByAgent.get(params.agentId);
        if (existingPolicyId) {
            const existingPolicy = this.policies.get(existingPolicyId);
            if (existingPolicy) {
                existingPolicy.status = 'archived';
                existingPolicy.updatedAt = now;
            }
        }

        this.policies.set(policyId, policy);
        this.policyByAgent.set(params.agentId, policyId);

        // Initialize usage tracking
        this.usage.set(policyId, {
            policyId,
            agentId: params.agentId,
            dailyUsage: {},
            weeklyUsage: {},
            monthlyUsage: {},
            transactionCount: 0,
        });

        await this.saveToStorage();

        return policy;
    }

    /**
     * Get policy by ID.
     */
    async getPolicy(policyId: string): Promise<SpendingPolicy | null> {
        await this.ensureLoaded();
        return this.policies.get(policyId) || null;
    }

    /**
     * Get active policy for an agent.
     */
    async getPolicyForAgent(agentId: string): Promise<SpendingPolicy | null> {
        await this.ensureLoaded();
        const policyId = this.policyByAgent.get(agentId);
        if (!policyId) return null;

        const policy = this.policies.get(policyId);
        if (!policy || policy.status !== 'active') return null;

        return policy;
    }

    /**
     * Get all policies (optionally filtered by status).
     */
    async getAllPolicies(status?: PolicyStatus): Promise<SpendingPolicy[]> {
        await this.ensureLoaded();
        const policies = Array.from(this.policies.values());
        if (status) {
            return policies.filter((p) => p.status === status);
        }
        return policies;
    }

    // SECURITY FIX: C-8 - Blocked field names for prototype pollution prevention
    private static readonly BLOCKED_FIELD_NAMES = new Set([
        '__proto__',
        'constructor',
        'prototype',
    ]);

    /**
     * SECURITY FIX: C-8 - Sanitize object to remove prototype pollution vectors
     */
    private sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
        if (!obj || typeof obj !== 'object') return obj;

        const sanitized = {} as T;
        for (const key of Object.keys(obj)) {
            if (SpendingPolicyManager.BLOCKED_FIELD_NAMES.has(key)) {
                console.warn(`[SpendingPolicyManager] Blocked attempt to set dangerous field: ${key}`);
                continue;
            }
            sanitized[key as keyof T] = obj[key] as T[keyof T];
        }
        return sanitized;
    }

    /**
     * Update an existing policy.
     */
    async updatePolicy(
        policyId: string,
        updates: Partial<
            Pick<
                SpendingPolicy,
                'name' | 'description' | 'limits' | 'categories' | 'merchants' | 'rails' | 'schedule' | 'friction' | 'capabilities'
            >
        >
    ): Promise<SpendingPolicy> {
        await this.ensureLoaded();

        const policy = this.policies.get(policyId);
        if (!policy) {
            throw new Error('Policy not found');
        }

        // SECURITY FIX: C-8 - Sanitize all nested objects before merging
        const updated: SpendingPolicy = {
            ...policy,
            ...this.sanitizeObject(updates as unknown as Record<string, unknown>),
            // Deep merge nested objects with sanitization
            limits: updates.limits ? { ...policy.limits, ...this.sanitizeObject(updates.limits as unknown as Record<string, unknown>) } : policy.limits,
            categories: updates.categories ? { ...policy.categories, ...this.sanitizeObject(updates.categories as unknown as Record<string, unknown>) } : policy.categories,
            merchants: updates.merchants ? { ...policy.merchants, ...this.sanitizeObject(updates.merchants as unknown as Record<string, unknown>) } : policy.merchants,
            rails: updates.rails ? { ...policy.rails, ...this.sanitizeObject(updates.rails as unknown as Record<string, unknown>) } : policy.rails,
            schedule: updates.schedule ? { ...policy.schedule, ...this.sanitizeObject(updates.schedule as unknown as Record<string, unknown>) } : policy.schedule,
            friction: updates.friction ? { ...policy.friction, ...this.sanitizeObject(updates.friction as unknown as Record<string, unknown>) } : policy.friction,
            capabilities: updates.capabilities ? { ...policy.capabilities, ...this.sanitizeObject(updates.capabilities as unknown as Record<string, unknown>) } : policy.capabilities,
            updatedAt: Date.now(),
        };

        this.policies.set(policyId, updated);
        await this.saveToStorage();

        return updated;
    }

    /**
     * Set policy status.
     */
    async setPolicyStatus(policyId: string, status: PolicyStatus): Promise<void> {
        await this.ensureLoaded();

        const policy = this.policies.get(policyId);
        if (!policy) {
            throw new Error('Policy not found');
        }

        policy.status = status;
        policy.updatedAt = Date.now();

        await this.saveToStorage();
    }

    /**
     * Delete a policy (marks as archived).
     */
    async deletePolicy(policyId: string): Promise<void> {
        await this.setPolicyStatus(policyId, 'archived');
    }

    /**
     * Save a complete policy object (replacing the existing one).
     * Used by AutonomySettingsManager to sync autonomy settings with policy.
     */
    async savePolicy(policy: SpendingPolicy): Promise<void> {
        await this.ensureLoaded();

        if (!this.policies.has(policy.id)) {
            throw new Error('Policy not found');
        }

        policy.updatedAt = Date.now();
        this.policies.set(policy.id, policy);
        await this.saveToStorage();
    }

    // =====================
    // USAGE TRACKING
    // =====================

    /**
     * Get usage for a policy.
     */
    async getUsage(policyId: string): Promise<PolicyUsage | null> {
        await this.ensureLoaded();
        return this.usage.get(policyId) || null;
    }

    /**
     * Record a transaction against a policy.
     */
    async recordTransaction(policyId: string, amount: number): Promise<void> {
        await this.ensureLoaded();

        let usage = this.usage.get(policyId);
        if (!usage) {
            const policy = this.policies.get(policyId);
            if (!policy) {
                throw new Error('Policy not found');
            }
            usage = {
                policyId,
                agentId: policy.agentId,
                dailyUsage: {},
                weeklyUsage: {},
                monthlyUsage: {},
                transactionCount: 0,
            };
            this.usage.set(policyId, usage);
        }

        const now = new Date();
        const dayKey = this.getDayKey(now);
        const weekKey = this.getWeekKey(now);
        const monthKey = this.getMonthKey(now);

        usage.dailyUsage[dayKey] = (usage.dailyUsage[dayKey] || 0) + amount;
        usage.weeklyUsage[weekKey] = (usage.weeklyUsage[weekKey] || 0) + amount;
        usage.monthlyUsage[monthKey] = (usage.monthlyUsage[monthKey] || 0) + amount;
        usage.lastTransactionAt = now.getTime();
        usage.transactionCount++;

        await this.saveToStorage();
    }

    /**
     * Get current usage amounts for a policy.
     */
    async getCurrentUsage(policyId: string): Promise<{
        daily: number;
        weekly: number;
        monthly: number;
    }> {
        await this.ensureLoaded();

        const usage = this.usage.get(policyId);
        if (!usage) {
            return { daily: 0, weekly: 0, monthly: 0 };
        }

        const now = new Date();
        const dayKey = this.getDayKey(now);
        const weekKey = this.getWeekKey(now);
        const monthKey = this.getMonthKey(now);

        return {
            daily: usage.dailyUsage[dayKey] || 0,
            weekly: usage.weeklyUsage[weekKey] || 0,
            monthly: usage.monthlyUsage[monthKey] || 0,
        };
    }

    /**
     * Get remaining limits for a policy.
     */
    async getRemainingLimits(policyId: string): Promise<{
        daily: number;
        weekly: number;
        monthly: number;
    }> {
        await this.ensureLoaded();

        const policy = this.policies.get(policyId);
        if (!policy) {
            return { daily: 0, weekly: 0, monthly: 0 };
        }

        const currentUsage = await this.getCurrentUsage(policyId);

        return {
            daily: Math.max(0, policy.limits.daily - currentUsage.daily),
            weekly: Math.max(0, policy.limits.weekly - currentUsage.weekly),
            monthly: Math.max(0, policy.limits.monthly - currentUsage.monthly),
        };
    }

    /**
     * Clean up old usage data (keep last 90 days).
     */
    async cleanupOldUsage(): Promise<void> {
        await this.ensureLoaded();

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 90);
        const cutoffDay = this.getDayKey(cutoffDate);

        for (const usage of this.usage.values()) {
            // Clean daily usage
            for (const dayKey of Object.keys(usage.dailyUsage)) {
                if (dayKey < cutoffDay) {
                    delete usage.dailyUsage[dayKey];
                }
            }

            // Clean weekly usage (older than ~13 weeks)
            const cutoffWeek = this.getWeekKey(cutoffDate);
            for (const weekKey of Object.keys(usage.weeklyUsage)) {
                if (weekKey < cutoffWeek) {
                    delete usage.weeklyUsage[weekKey];
                }
            }

            // Clean monthly usage (older than 3 months)
            const cutoffMonth = this.getMonthKey(cutoffDate);
            for (const monthKey of Object.keys(usage.monthlyUsage)) {
                if (monthKey < cutoffMonth) {
                    delete usage.monthlyUsage[monthKey];
                }
            }
        }

        await this.saveToStorage();
    }

    // =====================
    // DATE KEY HELPERS
    // =====================

    private getDayKey(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    private getWeekKey(date: Date): string {
        // ISO week number
        const tempDate = new Date(date.getTime());
        tempDate.setHours(0, 0, 0, 0);
        tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
        const week1 = new Date(tempDate.getFullYear(), 0, 4);
        const weekNum = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
        return `${tempDate.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }

    private getMonthKey(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
}

export default SpendingPolicyManager.getInstance();
