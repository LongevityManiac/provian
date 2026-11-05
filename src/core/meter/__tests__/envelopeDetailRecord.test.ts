import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { heldEnvelopeDetail, v2EnvelopeDetail } from '../envelopeDetailRecord';
import { PE_V2_SCHEMA, peHashOf, type PeV2 } from '../meter-wire';
import { openStore, recordPes } from './meterTestkit';

// Run the actual screen loader so the storage regression cannot pass while the UI
// keeps using the old history projection. Native rendering is irrelevant to this read.
const screenSource = readFileSync('src/screens/Activity/EnvelopeDetailScreen.tsx', 'utf8');
const screenAst = ts.createSourceFile('screen.tsx', screenSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function screenInitializer(name: string): string {
    let found: ts.Expression | undefined;
    function visit(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && node.name.getText(screenAst) === name) found = node.initializer;
        ts.forEachChild(node, visit);
    }
    visit(screenAst);
    if (!found) throw new Error(`Missing screen initializer: ${name}`);
    return found.getText(screenAst);
}

describe('owner-held envelope detail', () => {
    const pe: PeV2 = {
        schema: PE_V2_SCHEMA, pe_id: 'new_wallet', device_id: 'relay:human_owner',
        prev_hash: 'genesis', timestamp: 1793815121557, action_type: 'wallet_created',
        actor_address: '0x28a7d164741d4d81c5793d88fee33ad63a7d1f59', description: 'Wallet registered',
    };
    it('reads the returned registration PE with its actual predecessor/actor and unchanged raw bytes', async () => {
        const { store, files } = await openStore();
        const hash = peHashOf(pe);
        await store.recordReceived({ mailbox_id: 'direct:new_wallet', pe_id: pe.pe_id, pe, pe_hash: hash,
            from_device: pe.device_id, from_actor: 'human_owner', batch_hash: '', created_at_ms: pe.timestamp, received_at_ms: pe.timestamp });
        const before = JSON.stringify([...files.files.entries()]);
        const detail = await heldEnvelopeDetail(store, pe.pe_id);
        expect(detail?.kind).toBe('v2');
        expect(detail?.envelope.prev_envelope_hash).toBe(pe.prev_hash);
        expect(detail?.envelope.prev_envelope_hash).not.toBe(hash); // the old projection used its own hash
        expect(detail?.envelope.actor_address).toBe(pe.actor_address);
        expect(detail?.raw).toEqual(pe);
        expect(JSON.stringify([...files.files.entries()])).toBe(before);
        expect(detail?.envelope.signature).toBeUndefined();
        expect(detail?.envelope.chain_id).toBeUndefined();
        expect(detail?.envelope.risk_score).toBeUndefined();
    });
    it('keeps a phone-created proof’s committed full detail and real signature', async () => {
        const { store } = await openStore();
        const [own] = await recordPes(store, 1, { signature: 'real_local_signature', actor_address: 'owner', prev_envelope_hash: 'prior_v1' });
        const detail = await heldEnvelopeDetail(store, own.pe_id);
        expect(detail?.kind).toBe('v1');
        expect(detail?.envelope.signature).toBe('real_local_signature');
        expect(detail?.envelope.prev_envelope_hash).toBe('prior_v1');
    });
    it('does not substitute a different held proof when the selected id is missing', async () => {
        const { store } = await openStore();
        await recordPes(store, 1);
        expect(await heldEnvelopeDetail(store, 'missing')).toBeNull();
    });
    it('preserves an actual signature when the v2 carries one, without inventing it', () => {
        expect(v2EnvelopeDetail({ ...pe, signature: 'actual_v2_signature' }).envelope.signature).toBe('actual_v2_signature');
    });
    it('the detail screen reads held registration bytes before requesting any lossy history projection', async () => {
        const { store } = await openStore();
        await store.recordReceived({ mailbox_id: 'direct:new_wallet', pe_id: pe.pe_id, pe, pe_hash: peHashOf(pe),
            from_device: pe.device_id, from_actor: 'human_owner', batch_hash: '', created_at_ms: pe.timestamp, received_at_ms: pe.timestamp });
        let envelope: unknown, raw: unknown, kind: unknown, loading: unknown;
        const js = ts.transpileModule(`const load = ${screenInitializer('loadEnvelope')};`, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText;
        const unexpected = () => { throw new Error('History projection must not replace held proof'); };
        const load = new Function('require', 'useCallback', 'envelopeId', 'heldEnvelopeDetail', 'setEnvelope', 'setRawEnvelope',
            'setRecordKind', 'setLoading', 'ProvenanceEnvelopeManager', 'RelayAPIService', js + ';return load;')(
            () => ({ getPhoneMeter: () => ({ start: async () => undefined, store }) }), (fn: unknown) => fn, pe.pe_id,
            heldEnvelopeDetail, (v: unknown) => { envelope = v; }, (v: unknown) => { raw = v; },
            (v: unknown) => { kind = v; }, (v: unknown) => { loading = v; }, { getHistory: unexpected },
            { getPVTHistory: unexpected, getProvenanceEnvelopes: unexpected },
        ) as () => Promise<void>;
        await load();
        expect(envelope).toMatchObject({ prev_envelope_hash: pe.prev_hash, actor_address: pe.actor_address });
        expect(raw).toEqual(pe);
        expect(kind).toBe('v2');
        expect(loading).toBe(false);
    });
    it('a history-only projection does not invent a predecessor, actor or signature from its own hash', () => {
        const js = ts.transpileModule(`const map = ${screenInitializer('mapHistoryEntryToEnvelope')};`, {
            compilerOptions: { target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const map = new Function(js + ';return map;')() as (entry: object) => Record<string, unknown>;
        const view = map({ peId: 'history_only', timestamp: pe.timestamp, actionType: pe.action_type, hash: peHashOf(pe) });
        expect(view.envelope_id).toBe('history_only');
        expect(view.prev_envelope_hash).toBeUndefined();
        expect(view.actor_address).toBeUndefined();
        expect(view.signature).toBeUndefined();
    });
    it('keeps intact legacy proofs readable when the meter cannot start', async () => {
        const legacy = { envelope_id: 'legacy_selected', action_type: 'wallet_created', timestamp: pe.timestamp, signature: 'real_signature' };
        let envelope: unknown, raw: unknown, kind: unknown;
        const js = ts.transpileModule(`const load = ${screenInitializer('loadEnvelope')};`, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText;
        const load = new Function('require', 'useCallback', 'envelopeId', 'heldEnvelopeDetail', 'setEnvelope', 'setRawEnvelope',
            'setRecordKind', 'setLoading', 'ProvenanceEnvelopeManager', js + ';return load;')(
            () => ({ getPhoneMeter: () => ({ start: async () => { throw new Error('meter unavailable'); } }) }),
            (fn: unknown) => fn, legacy.envelope_id, heldEnvelopeDetail,
            (v: unknown) => { envelope = v; }, (v: unknown) => { raw = v; }, (v: unknown) => { kind = v; },
            () => undefined, { getHistory: async () => [legacy] },
        ) as () => Promise<void>;
        await load();
        expect(envelope).toEqual(legacy);
        expect(raw).toEqual(legacy);
        expect(kind).toBe('v1');
    });
    it('the rendered points row distinguishes an absent amount from a known zero', () => {
        let condition: ts.Expression | undefined;
        function visit(node: ts.Node): void {
            if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression)
                && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                && node.expression.right.getText(screenAst).includes("label={t('envelope.recordPoints')} value={historyEntry.recordPoints}")) {
                condition = node.expression.left;
            }
            ts.forEachChild(node, visit);
        }
        visit(screenAst);
        if (!condition) throw new Error('Record points row must have an explicit known-amount guard');
        const showPoints = new Function('historyEntry', `return ${condition.getText(screenAst)}`) as (entry: object) => boolean;
        expect(showPoints({ recordPoints: '0', recordPointsAtomic: null })).toBe(false);
        expect(showPoints({ recordPoints: '0', recordPointsAtomic: '0' })).toBe(true);
        expect(showPoints({ recordPoints: '20', recordPointsAtomic: '20000000000000000000' })).toBe(true);
    });
});
