/**
 * peTrustDetail — the Trust Layer §2.2 view of one PE, extracted from the raw
 * relay PE document.
 *
 * The PE detail screen renders witness class, evidence class, output digests,
 * input origins (grouped by class, `pe:` resolved to the cited party's handle
 * when the relay resolved one), the consumption reverse-index count, the
 * hardware-attestation metadata slot, supervision / model / environment, and an
 * adverse-linkage marker. Every value here is METADATA ONLY: hashes are hashes,
 * never content; a device serial is never surfaced even when present.
 *
 * This reader is deliberately DEFENSIVE. Pass 1 landed these fields on the
 * canonical `provenance_envelopes` document, but a given relay build may name a
 * field differently or omit it entirely; the §2.2 rule is "use what it returns
 * and render — for absent ones", never invent an endpoint or a value. So every
 * field is read across its plausible names and falls back to null. Pure +
 * typed (no `any`), so the screen stays clean.
 */

/** One output artifact digest (hash + optional kind tag). Never content. */
export interface PeOutputDigestView {
    hash: string;
    kind: string | null;
}

/** The class an input origin belongs to, parsed from its identifier prefix. */
export type OriginClass = 'pe' | 'evm' | 'pkg' | 'repo' | 'domain' | 'doi' | 'private' | 'other';

/** One input origin the PE's work consumed, with a resolved handle for `pe:`. */
export interface PeInputOriginView {
    originClass: OriginClass;
    originIdentifier: string;
    hash: string;
    /** For a `pe:` origin: the cited party's public handle, when the relay resolved one. */
    citedHandle: string | null;
    citedSigner: string | null;
    citedActionType: string | null;
    /** True only for a NON-actor-witnessed origin (a voucher crossed the boundary). */
    witnessed: boolean;
}

/**
 * The hardware-attestation metadata slot (§2.9). Every field is metadata about
 * the attestation, NEVER a device serial (which the relay does not surface).
 */
export interface PeHardwareWitnessView {
    scheme: string | null;
    teeType: string | null;
    measurementDigest: string | null;
    issuerRoot: string | null;
    attestedRegion: string | null;
    attestedTimeSource: string | null;
    deviceClass: string | null;
    verified: boolean | null;
}

export interface PeTrustDetail {
    witnessClass: string | null;
    evidenceClass: string | null;
    outputDigests: PeOutputDigestView[];
    inputOrigins: PeInputOriginView[];
    /** Reverse-index count of independent parties that built on this PE, or null when absent. */
    consumptionIndependentParties: number | null;
    hardwareWitness: PeHardwareWitnessView | null;
    /** Supervision ratio in basis points (human-directed share of turns), or null. */
    supervisionRatioBps: number | null;
    supervisedTurns: number | null;
    modelFamily: string | null;
    environmentClass: string | null;
    /** True when this PE is itself an adverse standing event (dispute/slash/broken/invalidation). */
    isAdverse: boolean;
    adverseType: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/** First non-null string among the given field names on a record. */
function firstStr(o: Record<string, unknown>, ...keys: string[]): string | null {
    for (const k of keys) {
        const s = str(o[k]);
        if (s !== null) return s;
    }
    return null;
}

function firstNum(o: Record<string, unknown>, ...keys: string[]): number | null {
    for (const k of keys) {
        const v = o[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
}

/** Classify an origin identifier by its prefix (mirrors the relay's origin classes). */
export function classifyOrigin(identifier: string): OriginClass {
    const id = identifier.toLowerCase();
    if (id.startsWith('pe:')) return 'pe';
    if (id.startsWith('evm:')) return 'evm';
    if (id.startsWith('pkg:')) return 'pkg';
    if (id.startsWith('repo:')) return 'repo';
    if (id.startsWith('domain:')) return 'domain';
    if (id.startsWith('doi:')) return 'doi';
    if (id.startsWith('private_') || id.startsWith('private:')) return 'private';
    return 'other';
}

/**
 * Which sealed rows are an adverse Standing event AGAINST THEIR ACTOR. This mirrors the relay's one
 * rule (`countsAsAdverse` in `provian-backend/src/core/pvt/actor-stats.ts`), so the label on a record
 * and the number a presentation carries cannot disagree:
 *
 * - chain-witnessed types count only on the Standing watcher's own row (it names the chain event);
 * a slash's own autonomy downgrade is the same event and is not labelled twice;
 * - a promise default counts on the borrower, never the lender;
 * - a hire dispute and a Commons challenge count on the losing party's row only;
 * - a person's one-sided "broken" promise marks nobody.
 */
const CHAIN_WITNESSED_ADVERSE_TYPES = new Set([
    'bond_slashed',
    'bond_abandoned',
    'bond_autonomy_downgraded',
    'bond_claim_dismissed',
    'court_verdict',
    'court_arbitrator_seat_forfeited',
    'court_arbitrator_collateral_slashed',
]);
const RELAY_WITNESSED_ADVERSE_TYPES = new Set(['bond_expired_processed', 'promise_defaulted', 'pvt_reputation_slashed']);
const BASE_CHAIN_ID = 8453;

function nonEmpty(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

/** Pure: is this sealed row one adverse Standing event against its actor? Unknown shape = no label. */
export function isAdverseStandingRow(actionType: string | null, metadata: unknown): boolean {
    if (actionType === null) return false;
    const md = isRecord(metadata) ? metadata : {};
    const lost = (key: 'verdict' | 'resolution'): boolean =>
        (md.role === 'depositor' && md[key] === 'release_to_recipient')
        || (md.role === 'recipient' && md[key] === 'refund_to_depositor');
    if (actionType === 'escrow_resolved') return lost('resolution') && nonEmpty(md.hire_job_id);
    if (actionType === 'commons_challenge_resolved') {
        return md.role === 'challenged' && md.status === 'upheld' && nonEmpty(md.challenge_id);
    }
    if (CHAIN_WITNESSED_ADVERSE_TYPES.has(actionType)) {
        if (md.standing === 'adverse' && nonEmpty(md.canonical_event_id)) {
            return !(actionType === 'bond_autonomy_downgraded' && md.paired_bond_slash === true);
        }
        return actionType === 'court_verdict' && lost('verdict')
            && typeof md.chain_id === 'number' && Number.isSafeInteger(md.chain_id) && md.chain_id !== BASE_CHAIN_ID;
    }
    if (!RELAY_WITNESSED_ADVERSE_TYPES.has(actionType)) return false;
    return !(actionType === 'promise_defaulted' && md.role === 'lender');
}

function extractOutputDigests(raw: Record<string, unknown>): PeOutputDigestView[] {
    const arr = raw.output_digests;
    if (!Array.isArray(arr)) return [];
    const out: PeOutputDigestView[] = [];
    for (const entry of arr) {
        if (!isRecord(entry)) continue;
        const hash = firstStr(entry, 'hash', 'digest');
        if (hash === null) continue;
        out.push({ hash, kind: firstStr(entry, 'kind', 'type') });
    }
    return out;
}

function extractInputOrigins(raw: Record<string, unknown>): PeInputOriginView[] {
    const arr = raw.input_origins;
    if (!Array.isArray(arr)) return [];
    const out: PeInputOriginView[] = [];
    for (const entry of arr) {
        if (!isRecord(entry)) continue;
        const originIdentifier = firstStr(entry, 'origin_identifier', 'identifier');
        const hash = firstStr(entry, 'hash', 'digest');
        if (originIdentifier === null || hash === null) continue;
        out.push({
            originClass: classifyOrigin(originIdentifier),
            originIdentifier,
            hash,
            citedHandle: firstStr(entry, 'cited_handle', 'cited_signer_handle', 'cited_display_name'),
            citedSigner: firstStr(entry, 'cited_signer', 'cited_signer_address'),
            citedActionType: firstStr(entry, 'cited_action_type'),
            witnessed: entry.witnessed === true,
        });
    }
    return out;
}

function extractHardwareWitness(raw: Record<string, unknown>): PeHardwareWitnessView | null {
    const hw = raw.hardware_witness ?? raw.hardware_attestation;
    if (!isRecord(hw)) return null;
    const view: PeHardwareWitnessView = {
        scheme: firstStr(hw, 'scheme', 'type'),
        teeType: firstStr(hw, 'tee_type', 'teeType'),
        measurementDigest: firstStr(hw, 'measurement', 'measurement_digest', 'measurementDigest'),
        issuerRoot: firstStr(hw, 'issuer_root', 'root', 'issuerRoot'),
        attestedRegion: firstStr(hw, 'attested_region', 'region', 'attestedRegion'),
        attestedTimeSource: firstStr(hw, 'attested_time_source', 'time_source', 'attestedTimeSource'),
        deviceClass: firstStr(hw, 'device_class', 'deviceClass'),
        verified: typeof hw.verified === 'boolean' ? hw.verified : null,
    };
    // If literally nothing usable is present, treat the slot as absent.
    const anyPresent = view.scheme || view.teeType || view.measurementDigest || view.issuerRoot
        || view.attestedRegion || view.attestedTimeSource || view.deviceClass || view.verified !== null;
    return anyPresent ? view : null;
}

function extractConsumption(raw: Record<string, unknown>): number | null {
    const consumption = raw.consumption;
    if (isRecord(consumption)) {
        const n = firstNum(consumption, 'independent_parties', 'independentParties');
        if (n !== null) return n;
    }
    return firstNum(raw, 'consumed_by_independent_parties', 'consumption_independent_parties');
}

function extractSupervision(raw: Record<string, unknown>): { ratioBps: number | null; supervisedTurns: number | null } {
    const meta = isRecord(raw.metadata) ? raw.metadata : {};
    const sup = isRecord(meta.supervision) ? meta.supervision : (isRecord(raw.supervision) ? raw.supervision : {});
    return {
        ratioBps: firstNum(sup, 'human_directed_turn_share_bps', 'ratio_bps', 'supervision_ratio_bps'),
        supervisedTurns: firstNum(sup, 'supervised_turns', 'supervisedTurns'),
    };
}

function extractModelFamily(raw: Record<string, unknown>): string | null {
    const meta = isRecord(raw.metadata) ? raw.metadata : {};
    const model = meta.model ?? raw.model;
    if (isRecord(model)) return firstStr(model, 'family', 'id', 'name');
    return str(model);
}

function extractEnvironmentClass(raw: Record<string, unknown>): string | null {
    const env = raw.execution_env ?? raw.environment_class;
    if (isRecord(env)) return firstStr(env, 'class', 'environment_class', 'kind');
    return str(env);
}

function extractAdverse(raw: Record<string, unknown>): { isAdverse: boolean; adverseType: string | null } {
    if (raw.is_adverse === true || raw.adverse_standing_event === true) {
        return { isAdverse: true, adverseType: firstStr(raw, 'adverse_type', 'standing_event_type', 'action_type') };
    }
    const actionType = firstStr(raw, 'action_type');
    if (isAdverseStandingRow(actionType, raw.metadata)) {
        return { isAdverse: true, adverseType: actionType };
    }
    return { isAdverse: false, adverseType: null };
}

/**
 * Extract the §2.2 trust-layer view from a raw relay PE document. Never throws;
 * an unrecognized shape yields an all-empty detail (the screen renders "—").
 */
export function extractPeTrustDetail(raw: unknown): PeTrustDetail {
    if (!isRecord(raw)) {
        return {
            witnessClass: null, evidenceClass: null, outputDigests: [], inputOrigins: [],
            consumptionIndependentParties: null, hardwareWitness: null,
            supervisionRatioBps: null, supervisedTurns: null, modelFamily: null,
            environmentClass: null, isAdverse: false, adverseType: null,
        };
    }
    const supervision = extractSupervision(raw);
    const adverse = extractAdverse(raw);
    return {
        witnessClass: firstStr(raw, 'witness_class', 'witnessClass'),
        evidenceClass: firstStr(raw, 'evidence_class', 'evidenceClass'),
        outputDigests: extractOutputDigests(raw),
        inputOrigins: extractInputOrigins(raw),
        consumptionIndependentParties: extractConsumption(raw),
        hardwareWitness: extractHardwareWitness(raw),
        supervisionRatioBps: supervision.ratioBps,
        supervisedTurns: supervision.supervisedTurns,
        modelFamily: extractModelFamily(raw),
        environmentClass: extractEnvironmentClass(raw),
        isAdverse: adverse.isAdverse,
        adverseType: adverse.adverseType,
    };
}

/** True when the detail carries at least one renderable trust-layer fact. */
export function hasTrustDetail(d: PeTrustDetail): boolean {
    return d.witnessClass !== null
        || d.evidenceClass !== null
        || d.outputDigests.length > 0
        || d.inputOrigins.length > 0
        || d.consumptionIndependentParties !== null
        || d.hardwareWitness !== null
        || d.supervisionRatioBps !== null
        || d.modelFamily !== null
        || d.environmentClass !== null
        || d.isAdverse;
}

/** The order origin classes are grouped in on the PE detail screen. */
export const ORIGIN_CLASS_ORDER: readonly OriginClass[] = [
    'pe', 'evm', 'pkg', 'repo', 'domain', 'doi', 'private', 'other',
];
