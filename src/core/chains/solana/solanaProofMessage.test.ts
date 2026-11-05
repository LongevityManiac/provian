/**
 * The app's Solana proof-message check is a MIRROR of the agent SDK's. This suite runs both on the
 * same vectors and requires identical verdicts, so neither copy can drift into accepting a message
 * the other refuses.
 */
import { describe, it, expect } from 'vitest';
import * as app from './solanaProofMessage';
import * as sdk from '../../../../provian-agent-sdk/src/solana-proof-message';

const ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2';
const ISSUED = Date.UTC(2026, 9, 4, 12, 0, 0);
const EXPIRES = ISSUED + 600_000;
const NOW = ISSUED + 1_000;
const NONCE = '0123456789abcdef0123456789abcdef';

function msg(subjectLine: string, address = ADDRESS): string {
    return app.buildSolanaProofMessage({
        subjectLine, address, nonce: NONCE,
        issuedIso: new Date(ISSUED).toISOString(), expiresIso: new Date(EXPIRES).toISOString(),
    });
}

type Subject = app.SolanaProofSubject;
const PERSON: Subject = { kind: 'person' };
const AGENT: Subject = { kind: 'agent', agentId: 'agent-1' };

const VECTORS: Array<{ name: string; message: string; subject: Subject; ok: boolean; fields?: Record<string, unknown> }> = [
    { name: 'canonical person', message: msg('person: user_7'), subject: PERSON, ok: true, fields: { nonce: NONCE, issued_at: ISSUED, expires_at: EXPIRES } },
    { name: 'canonical person, ISO fields', message: msg('person: user_7'), subject: PERSON, ok: true, fields: { issued_at: new Date(ISSUED).toISOString() } },
    { name: 'canonical agent', message: msg('agent: agent-1'), subject: AGENT, ok: true },
    { name: 'another address', message: msg('person: user_7', OTHER), subject: PERSON, ok: false },
    { name: 'agent line on the person route', message: msg('agent: agent-1'), subject: PERSON, ok: false },
    { name: 'person line on the agent route', message: msg('person: user_7'), subject: AGENT, ok: false },
    { name: 'another agent', message: msg('agent: agent-2'), subject: AGENT, ok: false },
    { name: 'EVM header', message: msg('person: user_7').replace(app.SOLANA_PROOF_MESSAGE_HEADER, 'Provian proof of control'), subject: PERSON, ok: false },
    { name: 'extra line', message: `${msg('person: user_7')}\nx: y`, subject: PERSON, ok: false },
    { name: 'trailing newline', message: `${msg('person: user_7')}\n`, subject: PERSON, ok: false },
    { name: 'CRLF', message: msg('person: user_7').split('\n').join('\r\n'), subject: PERSON, ok: false },
    { name: 'person id with a space', message: msg('person: user 7'), subject: PERSON, ok: false },
    { name: 'uppercase nonce', message: msg('person: user_7').replace(NONCE, NONCE.toUpperCase()), subject: PERSON, ok: false },
    { name: 'issued_at disagrees', message: msg('person: user_7'), subject: PERSON, ok: false, fields: { issued_at: ISSUED + 1 } },
    { name: 'nonce field disagrees', message: msg('person: user_7'), subject: PERSON, ok: false, fields: { nonce: 'f'.repeat(32) } },
    { name: 'arbitrary text', message: 'please sign this', subject: PERSON, ok: false },
];

describe('solanaProofMessage — app mirror ≡ SDK', () => {
    it('evaluates a non-empty population with both outcomes', () => {
        expect(VECTORS.filter((v) => v.ok).length).toBeGreaterThan(0);
        expect(VECTORS.filter((v) => !v.ok).length).toBeGreaterThan(5);
    });

    for (const v of VECTORS) {
        it(`${v.ok ? 'accepts' : 'refuses'}: ${v.name} (both copies agree)`, () => {
            const challenge = { message: v.message, ...(v.fields ?? {}) };
            const a = app.checkSolanaProofMessage(challenge, { address: ADDRESS, subject: v.subject }, NOW);
            const b = sdk.checkSolanaProofMessage(challenge, { address: ADDRESS, subject: v.subject }, NOW);
            expect(a.ok).toBe(v.ok);
            expect(a).toEqual(b);
        });
    }

    it('expiry is reported as EXPIRED by both', () => {
        const challenge = { message: msg('person: user_7') };
        const a = app.checkSolanaProofMessage(challenge, { address: ADDRESS, subject: PERSON }, EXPIRES);
        expect(a).toMatchObject({ ok: false, code: 'SOLANA_PROOF_CHALLENGE_EXPIRED' });
        expect(a).toEqual(sdk.checkSolanaProofMessage(challenge, { address: ADDRESS, subject: PERSON }, EXPIRES));
    });

    it('the header and lifetime constants are identical', () => {
        expect(app.SOLANA_PROOF_MESSAGE_HEADER).toBe(sdk.SOLANA_PROOF_MESSAGE_HEADER);
        expect(app.SOLANA_PROOF_MAX_LIFETIME_MS).toBe(sdk.SOLANA_PROOF_MAX_LIFETIME_MS);
    });
});
