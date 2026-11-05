import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import PEExporter from '../provenance/export/PEExporter';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';

export type SupportCategory = 'bug' | 'scam_report' | 'fiat_issue' | 'recovery_help' | 'other';

export interface SupportBundle {
    appVersion: string;
    buildVersion: string;
    deviceModel: string;
    osVersion: string;
    supportId: string;
    category: SupportCategory;
    recentLogs?: string; // JSON string of recent PEs (anonymized if needed)
}

class SupportManager {
    private static instance: SupportManager;
    private readonly SUPPORT_EMAIL = 'hello@provian.ai';

    private constructor() { }

    static getInstance(): SupportManager {
        if (!SupportManager.instance) {
            SupportManager.instance = new SupportManager();
        }
        return SupportManager.instance;
    }

    /**
     * Generate a support bundle for email attachment
     */
    async generateSupportBundle(category: SupportCategory, includeLogs: boolean = true): Promise<SupportBundle> {
        const supportId = `sup_${Date.now().toString(36)}`;

        let recentLogs = '';
        if (includeLogs) {
            // Export last 50 envelopes for context
            const history = await ProvenanceEnvelopeManager.getHistory();
            const recent = history.slice(-50);
            recentLogs = await PEExporter.exportEnvelopes(recent, 'support_export', 'single');
        }

        return {
            appVersion: Application.nativeApplicationVersion || '1.0.0',
            buildVersion: Application.nativeBuildVersion || '1',
            deviceModel: Device.modelName || 'Unknown',
            osVersion: `${Platform.OS} ${Device.osVersion}`,
            supportId,
            category,
            recentLogs
        };
    }

    /**
     * Get mailto link for support
     */
    async getSupportMailto(category: SupportCategory, bundle: SupportBundle): Promise<string> {
        const subject = `[${category.toUpperCase()}] Support Request ${bundle.supportId}`;
        const body = `
Describe your issue below:


------------------------------------------------
Diagnostic Info (Do not edit)
Support ID: ${bundle.supportId}
App: ${bundle.appVersion} (${bundle.buildVersion})
Device: ${bundle.deviceModel} (${bundle.osVersion})
Category: ${category}
------------------------------------------------
`;
        return `mailto:${this.SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    /**
     * Get specific instructions for fiat issues
     */
    getFiatSupportInstructions(providerName: string): string {
        return `For issues with ${providerName}, please contact their support directly first. As a non-custodial wallet, Provian cannot reverse fiat transactions. If they are unresponsive, reply to this email with your Ticket ID from them.`;
    }
}

export default SupportManager.getInstance();
