/**
 * PE METER (app) — PEs the relay hands the phone DIRECTLY in a response (not through the
 * mailbox), e.g. `POST /v1/wallet/human/register` → `firstEnvelope`: the person's own
 * `wallet_created` PE v2 (device `relay:<user_id>`). The relay keeps no copy, and at registration
 * the person has no published message key yet, so no mailbox copy exists either — this response is
 * the only place the PE exists. It must therefore be held durably the moment it arrives and filed in
 * the PE store (idempotent by pe_id), from where it reaches the person's iCloud / Drive backup.
 *
 * `stageRelayAuthoredPe` validates the PE and appends it to a small durable inbox (AsyncStorage)
 * before anything else; the meter files the inbox into the store on start, on every tick and as
 * soon as something is staged, and only then removes it from the inbox.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { peHashOf, PE_V2_SCHEMA, type PeV2 } from './meter-wire';
import type { KeyValue } from './phoneMeter';
import type { PhonePeStore } from './phonePeStore';

export const RELAY_AUTHORED_INBOX_KEY = 'provian_meter_relay_pes_pending_v1';

export interface RelayAuthoredItem {
    readonly source: string;
    readonly pe: PeV2;
    readonly pe_hash: string;
    readonly received_at_ms: number;
}

let listener: (() => void) | null = null;

/** The meter subscribes so a staged PE is filed at once (it is also filed on the next tick). */
export function setRelayAuthoredListener(fn: (() => void) | null): void {
    listener = fn;
}

/** Check a relay-handed PE: a PE v2 from a relay device whose hash recomputes. Null = refuse. */
export function validateRelayAuthoredPe(raw: unknown): { pe: PeV2; pe_hash: string } | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pe = raw as PeV2;
    if (pe.schema !== PE_V2_SCHEMA || typeof pe.pe_id !== 'string' || pe.pe_id.length === 0 || pe.pe_id.length > 200) return null;
    if (typeof pe.device_id !== 'string' || !pe.device_id.startsWith('relay:')) return null;
    if (typeof pe.action_type !== 'string' || !Number.isSafeInteger(pe.timestamp)) return null;
    let hash: string;
    try {
        hash = peHashOf(pe);
    } catch {
        return null;
    }
    if (typeof pe.pe_hash === 'string' && pe.pe_hash !== hash) return null;
    return { pe, pe_hash: hash };
}

async function readInbox(kv: KeyValue): Promise<RelayAuthoredItem[]> {
    const raw = await kv.getItem(RELAY_AUTHORED_INBOX_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed as RelayAuthoredItem[] : [];
    } catch {
        return [];
    }
}

/** Hold a relay-handed PE durably until the store has filed it. Never throws. */
export async function stageRelayAuthoredPe(raw: unknown, source: string, kv: KeyValue = AsyncStorage, nowMs: number = Date.now()): Promise<boolean> {
    try {
        const checked = validateRelayAuthoredPe(raw);
        if (checked === null) {
            console.warn('[PE meter] a PE the relay returned did not verify; it was not kept');
            return false;
        }
        const inbox = await readInbox(kv);
        if (!inbox.some((i) => i.pe.pe_id === checked.pe.pe_id && i.pe.device_id === checked.pe.device_id)) {
            inbox.push({ source, pe: checked.pe, pe_hash: checked.pe_hash, received_at_ms: nowMs });
            await kv.setItem(RELAY_AUTHORED_INBOX_KEY, JSON.stringify(inbox));
        }
        try { listener?.(); } catch { /* the meter files it on its next tick */ }
        return true;
    } catch (err) {
        console.warn('[PE meter] could not hold a relay-returned PE:', err instanceof Error ? err.message : String(err));
        return false;
    }
}

/** The received-store id of a directly handed PE (one per device + pe_id, so re-delivery is a no-op). */
export function directReceiptId(pe: PeV2): string {
    return `direct:${pe.device_id}:${pe.pe_id}`;
}

/** File every staged PE into the store, then drop exactly those from the inbox. */
export async function drainRelayAuthoredInbox(store: PhonePeStore, kv: KeyValue = AsyncStorage, nowMs: number = Date.now()): Promise<number> {
    const inbox = await readInbox(kv);
    if (inbox.length === 0) return 0;
    let filed = 0;
    for (const item of inbox) {
        const result = await store.recordReceived({
            mailbox_id: directReceiptId(item.pe),
            pe_id: item.pe.pe_id,
            pe: item.pe,
            pe_hash: item.pe_hash,
            from_device: item.pe.device_id,
            from_actor: typeof item.pe.device_id === 'string' ? item.pe.device_id.slice('relay:'.length) : '',
            batch_hash: '',
            created_at_ms: item.received_at_ms,
            received_at_ms: nowMs,
        });
        if (result.filed) filed += 1;
    }
    // Re-read: anything staged while filing stays for the next drain.
    const after = await readInbox(kv);
    const done = new Set(inbox.map((i) => `${i.pe.device_id}|${i.pe.pe_id}`));
    const remaining = after.filter((i) => !done.has(`${i.pe.device_id}|${i.pe.pe_id}`));
    if (remaining.length === 0) await kv.removeItem(RELAY_AUTHORED_INBOX_KEY);
    else await kv.setItem(RELAY_AUTHORED_INBOX_KEY, JSON.stringify(remaining));
    return filed;
}
