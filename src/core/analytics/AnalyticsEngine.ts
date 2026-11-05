import * as SecureStore from 'expo-secure-store';

export interface AnonymousEvents {
    highRiskBlocked: number;
    frictionTriggered: number;
    recoverySessions: number;
    drainerDetections: number;
    impersonationWarnings: number;
    onrampOrders: number;
    offrampOrders: number;
}

class AnalyticsEngine {
    private static instance: AnalyticsEngine;
    private events: AnonymousEvents = {
        highRiskBlocked: 0,
        frictionTriggered: 0,
        recoverySessions: 0,
        drainerDetections: 0,
        impersonationWarnings: 0,
        onrampOrders: 0,
        offrampOrders: 0
    };

    private constructor() {
        this.loadStats();
    }

    static getInstance(): AnalyticsEngine {
        if (!AnalyticsEngine.instance) {
            AnalyticsEngine.instance = new AnalyticsEngine();
        }
        return AnalyticsEngine.instance;
    }

    async trackEvent(event: keyof AnonymousEvents) {
        this.events[event]++;
        await this.saveStats();
    }

    async getStats(): Promise<AnonymousEvents> {
        return { ...this.events };
    }

    private async loadStats() {
        try {
            const stored = await SecureStore.getItemAsync('provian_anon_stats');
            if (stored) {
                this.events = JSON.parse(stored);
            }
        } catch (e) {
            console.warn('Failed to load analytics stats');
        }
    }

    private async saveStats() {
        try {
            await SecureStore.setItemAsync('provian_anon_stats', JSON.stringify(this.events));
        } catch (e) {
            console.warn('Failed to save analytics stats');
        }
    }
}

export default AnalyticsEngine.getInstance();
