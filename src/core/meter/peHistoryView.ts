/**
 * PE METER (app) — the app's PE list from the PEs this phone HOLDS (:
 * the relay stops storing PEs, so it can no longer serve a per-PE history of metered acts).
 *
 * Each row is one PE in the phone's store:
 * - this phone's own PEs (and any restored from a previous phone), with the disposition and
 * record points from the relay's RECEIPT for the batch that carried them; a PE not yet sent
 * has no receipt and therefore no earning claim;
 * - PEs a linked agent, another device or the relay sealed to this person (mailbox), and the
 * pre-meter history the relay handed back — shown with whatever disposition they carry.
 *
 * MONEY-SAFETY (unchanged): a row's shown earning is ONLY the settlement projection, which
 * the phone does not compute — `currentSettlementProjectionPVT` is always null here, so a row shows
 * its disposition chip without an amount. Record points are labelled as points, never as PVT.
 */

import type { PVTHistoryEntry } from '../../services/RelayAPIService';
import { normalizePVTAttestationTier } from '../provenance/attestationTiers';
import type { MeterActReceiptWire, PhonePeStore } from './phonePeStore';

const ATOMIC_SCALE = 10n ** 18n;

/** `formatPvtAtomic(x, 1)` — the relay's own formatting of an 18-decimal atomic amount. */
export function formatAtomic1(atomic: string): string {
    let value: bigint;
    try {
        value = BigInt(atomic);
    } catch {
        return '0.0';
    }
    const whole = value / ATOMIC_SCALE;
    const fraction = (value % ATOMIC_SCALE).toString(10).padStart(18, '0').slice(0, 1);
    return `${whole.toString(10)}.${fraction}`;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowOf(input: {
    peId: string;
    actionType: string;
    timestamp: number;
    attestation: unknown;
    mintStatus: string | null;
    pointsAtomic: string | null;
    hash: string;
    hidden?: boolean;
    description?: string | null;
}): PVTHistoryEntry {
    return {
        peId: input.peId,
        actionType: input.actionType,
        timestamp: input.timestamp,
        attestationDepth: normalizePVTAttestationTier(input.attestation),
        mintStatus: input.mintStatus,
        commitSha: null,
        recordPoints: formatAtomic1(input.pointsAtomic ?? '0'),
        recordPointsAtomic: input.pointsAtomic,
        currentSettlementProjectionPVT: null,
        currentSettlementProjectionAtomic: null,
        exactGenesisReservedGrossPVT: '0.0',
        exactGenesisReservedGrossAtomic: null,
        hash: input.hash,
        hidden: input.hidden === true,
        ...(input.description ? { description: input.description } : {}),
    };
}

/** Every PE this phone holds, newest first, as history rows. */
export async function localHistoryEntries(store: PhonePeStore, options: { readonly showHidden?: boolean } = {}): Promise<PVTHistoryEntry[]> {
    const rows: PVTHistoryEntry[] = [];
    for (const deviceId of store.deviceIds()) {
        const chain = await store.chain(deviceId);
        const receiptActs = new Map<string, MeterActReceiptWire>();
        for (const receipt of await chain.listReceipts()) {
            for (const act of receipt.acts) receiptActs.set(act.pe_hash, act);
        }
        for (const entry of await chain.allPes()) {
            const act = receiptActs.get(entry.pe.pe_hash) ?? null;
            const hidden = entry.detail?.hidden === true;
            if (hidden && !options.showHidden) continue;
            rows.push(rowOf({
                peId: entry.pe.pe_id,
                actionType: entry.pe.action_type,
                timestamp: entry.pe.timestamp,
                attestation: entry.pe.attestation_depth,
                mintStatus: act?.mint_status ?? null,
                pointsAtomic: act?.record_points_atomic ?? null,
                hash: entry.pe.pe_hash,
                hidden,
                description: entry.detail?.intent_text ?? (typeof entry.pe.description === 'string' ? entry.pe.description : null),
            }));
        }
    }
    for (const item of await store.listReceived()) {
        const r = item.pe as Record<string, unknown>;
        const actionType = str(r.action_type) ?? str(r.actionType) ?? 'unknown';
        const timestamp = typeof r.timestamp === 'number' ? r.timestamp : item.created_at_ms;
        rows.push(rowOf({
            peId: item.pe_id,
            actionType,
            timestamp,
            attestation: r.attestation_depth ?? r.attestationDepth ?? r.attestation_tier,
            mintStatus: str(r.mint_status),
            pointsAtomic: str(r.record_points_atomic),
            hash: item.pe_hash,
        }));
    }
    rows.sort((a, b) => b.timestamp - a.timestamp || (a.peId < b.peId ? -1 : 1));
    return rows;
}
