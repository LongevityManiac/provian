import { ProvenanceEnvelope } from '../types';
import * as Crypto from 'expo-crypto';
import { GENESIS_PREV_HASH } from '../constants';

export interface ExportPackage {
    version: string;
    generatedAt: number;
    deviceId: string;
    envelopes: ProvenanceEnvelope[];
    hashChainTip: string;
    signature?: string;
    type: 'single' | 'full' | 'bundle';
}

class PEExporter {
    private static instance: PEExporter;

    private constructor() { }

    static getInstance(): PEExporter {
        if (!PEExporter.instance) {
            PEExporter.instance = new PEExporter();
        }
        return PEExporter.instance;
    }

    /**
     * Generate a canonical JSON export of a set of PEs
     */
    async exportEnvelopes(
        envelopes: ProvenanceEnvelope[],
        deviceId: string,
        type: 'single' | 'full' | 'bundle' = 'full'
    ): Promise<string> {
        const exportPkg: ExportPackage = {
            version: '1.0.0',
            generatedAt: Date.now(),
            deviceId,
            envelopes: envelopes.sort((a, b) => a.timestamp - b.timestamp), // Ensure chronological order
            hashChainTip: envelopes.length > 0 ? envelopes[envelopes.length - 1].envelope_id : GENESIS_PREV_HASH,
            type
        };

        // Canonical stringify (ensure key order)
        return this.canonicalStringify(exportPkg);
    }

    /**
     * Generate a minimal hash chain export for verification
     */
    async exportHashChain(envelopes: ProvenanceEnvelope[]): Promise<string[]> {
        return envelopes
            .sort((a, b) => a.timestamp - b.timestamp)
            .map(pe => `${pe.timestamp}|${pe.envelope_id}|${pe.prev_envelope_hash}`);
    }

    /**
     * Deterministic JSON stringify with sorted keys.
     *
     * Used for hash-stable PE export. Phase 2.20 (Theme 6): the previous
     * `any` parameter would silently accept non-JSON values (functions,
     * symbols, BigInt) and either drop them or throw at hash time. The
     * narrower `unknown` type forces callers through the explicit type
     * checks below.
     */
    private canonicalStringify(value: unknown): string {
        if (value === null || typeof value !== 'object') {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return '[' + value.map((item: unknown) => this.canonicalStringify(item)).join(',') + ']';
        }

        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const parts = keys.map((key) => {
            return `${JSON.stringify(key)}:${this.canonicalStringify(obj[key])}`;
        });

        return '{' + parts.join(',') + '}';
    }
}

export default PEExporter.getInstance();
