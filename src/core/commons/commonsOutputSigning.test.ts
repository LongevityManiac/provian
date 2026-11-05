import {openPrivateAuthenticatedRequest} from '../../../provian-backend/src/core/meter/private-pricing';
/**
 * (constraint 2): what a person hands out on the Commons carries their phone's
 * signature over exactly the text the relay seals; what they open from someone else is captured
 * through the one hash-checked rule. RED controls for each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import { createHash } from 'crypto';
import { p256 } from '@noble/curves/p256';
import * as CommonsService from './CommonsService';
import {
    captureShownForumPosts,
    captureShownOutput,
    readThreadPlaintext,
    setCommonsOutputSigner,
    signedThreadPlaintext,
} from './commonsOutputSigning';
import {
    deliverableOutputText,
    forumPostOutputText,
    jobPostOutputText,
    outputHashOfText,
    outputSignatureDigestHex,
    wantOutputText,
    type OutputSignature,
} from '../meter/output-signature';
import { __resetOutputCitationQueueForTests, pendingOutputCitationCount, withQueuedOutputCitations } from '../meter/outputSigning';

const KEY = '0b'.repeat(32);
/** A stand-in for the phone's device key (P-256 over the digest, like the Secure Enclave). */
const phoneSigner = async (text: string): Promise<OutputSignature> => {
    const hash = outputHashOfText(text);
    const sig = Buffer.from(p256.sign(outputSignatureDigestHex(hash), KEY, { lowS: true }).toCompactRawBytes()).toString('hex');
    return { hash, signer: { kind: 'app', id: `aok_${'1'.repeat(32)}` }, scheme: 'p256_sha256', sig };
};

function captureFetch() {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    return () => {const [url,init]=fetchMock.mock.calls.at(-1)!;const req={body:JSON.parse(String(init?.body)),originalUrl:new URL(url).pathname};openPrivateAuthenticatedRequest(req,'sess');return req.body as Record<string,unknown>;};
}
const hashOf = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

describe('a person\'s Commons writes carry the phone\'s signature over the sealed text', () => {
    beforeEach(async () => { await SecureStore.setItemAsync('commons_session_token', 'sess'); });
    afterEach(async () => {
        setCommonsOutputSigner(null);
        await SecureStore.deleteItemAsync('commons_session_token');
        vi.unstubAllGlobals();
    });

    it('post, reply, want, job post and deliverable each send provian_output_signature over the relay\'s text', async () => {
        setCommonsOutputSigner(phoneSigner);
        const last = captureFetch();
        await CommonsService.createForumPost({ channel: 'general', content: '  hello world  ' });
        expect((last().provian_output_signature as OutputSignature).hash).toBe(hashOf(forumPostOutputText('  hello world  ')));
        await CommonsService.replyToPost('post_1', { content: 'a reply' });
        expect((last().provian_output_signature as OutputSignature).hash).toBe(hashOf('a reply'));
        await CommonsService.postWant({ outcome: ' a review ', capabilities: ['Legal', 'legal'] });
        expect((last().provian_output_signature as OutputSignature).hash).toBe(hashOf(wantOutputText(' a review ', ['Legal', 'legal'])));
        await CommonsService.postHumanJob({
            title: 'T', description: 'D', category: 'x', skills_required: [], location: { type: 'remote' }, compensation_type: 'pvt', deadline_hours: 1,
        });
        expect((last().provian_output_signature as OutputSignature).hash).toBe(hashOf(jobPostOutputText('T', 'D')));
        await CommonsService.deliverHumanJob('hjob_1', { deliverable_body: 'the work' });
        expect((last().provian_output_signature as OutputSignature).hash).toBe(hashOf(deliverableOutputText(null, 'the work')));
    });

    it('RED — no signer installed, or a signer that fails, sends the write UNSIGNED (never blocks it)', async () => {
        const last = captureFetch();
        await CommonsService.createForumPost({ channel: 'general', content: 'x' });
        expect('provian_output_signature' in last()).toBe(false);
        setCommonsOutputSigner(async () => { throw new Error('output_signing_key_backoff'); });
        await CommonsService.createForumPost({ channel: 'general', content: 'x' });
        expect('provian_output_signature' in last()).toBe(false);
        await CommonsService.deliverHumanJob('hjob_1', {});
        expect('provian_output_signature' in last()).toBe(false);
    });

    it('unpublishes a legacy private PE id only inside its existing-secret encrypted body',async()=>{
        const last=captureFetch(),id='pe_m_guessable_private_commitment';
        await CommonsService.unpublishPE(id);
        const fetchMock=vi.mocked(fetch),[url,init]=fetchMock.mock.calls.at(-1)!;
        expect(String(url)).toMatch(/\/v1\/pe\/unpublish-projection$/);
        expect(String(url)+String(init?.body)).not.toContain(id);
        expect(last()).toEqual({pe_id:id});
    });

    it('a thread message carries its signature inside the sealed plaintext; the reader strips it for display', async () => {
        setCommonsOutputSigner(phoneSigner);
        const plain = await signedThreadPlaintext('the plan');
        const read = readThreadPlaintext(plain);
        expect(read.text).toBe('the plan');
        expect(read.signature?.hash).toBe(hashOf('the plan'));
        setCommonsOutputSigner(null);
        expect(await signedThreadPlaintext('unsigned')).toBe('unsigned');
    });
});

describe('what the person opens is captured through the hash-checked rule only', () => {
    beforeEach(() => __resetOutputCitationQueueForTests());
    const WITNESS = { type: 'observer_device', identity: 'phone_1', attestation_tier: 'hardware' };

    it('an opened post / deliverable from someone else is queued and rides the next PE witnessed by this device', async () => {
        const post = { author_wallet_id: 'wallet_aw_agent', content: ' agent research ', provian_output_signature: await phoneSigner('agent research') };
        expect(captureShownForumPosts([post, null], 'user_me')).toBe(1);
        expect(captureShownOutput(await phoneSigner('the work'), 'the work', { authorId: 'user_worker', myId: 'user_me' })).toBe(true);
        const origins = withQueuedOutputCitations([], WITNESS) as Array<Record<string, unknown>>;
        expect(origins.map((o) => o.hash)).toEqual([hashOf('agent research'), hashOf('the work')]);
        expect(origins.every((o) => o.witnessed === true && (o.witness as { identity: string }).identity === 'phone_1')).toBe(true);
    });

    it('RED — the person\'s own outputs, an unsigned output, or a signature over other text are never queued', async () => {
        const mine = { author_wallet_id: 'user_me', content: 'mine', provian_output_signature: await phoneSigner('mine') };
        const unsigned = { author_wallet_id: 'wallet_aw_agent', content: 'plain' };
        const tampered = { author_wallet_id: 'wallet_aw_agent', content: 'edited text', provian_output_signature: await phoneSigner('original text') };
        expect(captureShownForumPosts([mine, unsigned, tampered], 'user_me')).toBe(0);
        expect(pendingOutputCitationCount()).toBe(0);
    });
});
