/**
 * Requester-named disclosure (2026-10-10) — plain-language rendering of a request and an answer,
 * shared by the presenter screen (what is about to be disclosed) and the requester screen (what
 * was asked, what came back). Pure; every string is an i18n key under `trustLayer.disclosure`.
 */
import type { TFunction } from 'i18next';
import type { CanonicalDisclosureRequest, DisclosedRecord, DisclosureContent } from './disclosureRequest';

const CONTENT_KEY: Record<DisclosureContent, string> = {
    description: 'trustLayer.disclosure.contentDescription',
    intent: 'trustLayer.disclosure.contentIntent',
    artifacts: 'trustLayer.disclosure.contentArtifacts',
    fact_tier: 'trustLayer.disclosure.contentFactTier',
};

function short(hex: string): string {
    return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

/** One line naming WHAT the request asks for (which records). */
export function describeDisclosureRequest(t: TFunction, req: CanonicalDisclosureRequest): string {
    if (req.kind === 'pe') {
        const base = t('trustLayer.disclosure.reqPe', { digest: short(req.output_digest) });
        return req.issuer !== undefined ? `${base} ${t('trustLayer.disclosure.reqIssuerTail', { issuer: short(req.issuer) })}` : base;
    }
    if (req.issuer !== undefined && req.signer !== undefined) {
        return t('trustLayer.disclosure.reqWitnessBoth', { issuer: short(req.issuer), signer: short(req.signer), limit: req.limit });
    }
    if (req.issuer !== undefined) return t('trustLayer.disclosure.reqWitnessIssuer', { issuer: short(req.issuer), limit: req.limit });
    return t('trustLayer.disclosure.reqWitnessSigner', { signer: short(req.signer ?? ''), limit: req.limit });
}

/** The extra the request asks beyond the metadata floor: named fields and elected content. */
export function describeDisclosureExtras(t: TFunction, req: CanonicalDisclosureRequest): string[] {
    const out: string[] = [];
    if (req.fields && req.fields.length > 0) out.push(t('trustLayer.disclosure.fieldsLine', { fields: req.fields.join(', ') }));
    if (req.content && req.content.length > 0) out.push(t('trustLayer.disclosure.contentLine', { content: req.content.map((c) => t(CONTENT_KEY[c])).join(', ') }));
    return out;
}

/** One line per disclosed record: type · when · witness. */
export function describeDisclosedRecord(t: TFunction, rec: DisclosedRecord, actionLabel: (actionType: string) => string): string {
    const when = new Date(rec.timestamp).toLocaleString();
    const w = rec.witness;
    const witness = w.kind === 'hardware'
        ? t('trustLayer.disclosure.witnessHardware', { scheme: w.scheme ?? 'hardware' })
        : w.kind === 'chain' ? t('trustLayer.disclosure.witnessChain') : t('trustLayer.disclosure.witnessDevice');
    return t('trustLayer.disclosure.recordLine', { type: actionLabel(rec.action_type), when, witness });
}
