/**
 * What a person hands out on the Commons is signed by their phone, and what they are shown signed
 * is captured (; constraint 2: human-device work earns consumption too).
 *
 * SIGNING. Every Commons write whose content others can build on — a forum post or reply, a want,
 * a hiring-board job post, a job deliverable, a thread message — carries the phone's signature
 * (its PE attestation key, never the wallet key; `core/meter/outputSigning.ts`) over exactly the
 * text whose hash the write's PE seals (`forumPostOutputText`, `wantOutputText`, `jobPostOutputText`,
 * `deliverableOutputText`). The relay verifies it is the author's and serves it with the record. A
 * thread message is E2E ciphertext, so its signature rides inside the sealed plaintext
 * (`withThreadOutputSignature`). Signing is best-effort: no signer installed, no registered key, or
 * a signing failure sends the write unsigned (it just is not citable).
 *
 * CAPTURE. When the app SHOWS someone else's signed output, `captureShownOutput` queues it through
 * the one capture rule (`enqueueReceivedOutput` kept only when the signature names the hash of the
 * exact text shown); the person's next PE cites it, witnessed by this device. There is no
 * declared-citation path.
 */
import {
    deliverableOutputText,
    forumPostOutputText,
    jobPostOutputText,
    splitThreadOutputSignature,
    wantOutputText,
    withThreadOutputSignature,
    type OutputSignature,
} from '../meter/output-signature';
import { enqueueReceivedOutput } from '../meter/outputSigning';

export type CommonsOutputSigner = (text: string) => Promise<OutputSignature>;

let signer: CommonsOutputSigner | null = null;

/** Installed once the phone's output key exists (`outputSigningRuntime`); null in tests and pre-wallet. */
export function setCommonsOutputSigner(next: CommonsOutputSigner | null): void {
    signer = next;
}

/** The phone's signature over `text`, or null (never throws, never blocks a write). */
export async function signCommonsOutput(text: string): Promise<OutputSignature | null> {
    if (signer === null || text.length === 0) return null;
    try {
        return await signer(text);
    } catch {
        return null;
    }
}

/** `{ provian_output_signature }` to spread into a write body, or `{}` when unsigned. */
export async function signatureField(text: string): Promise<{ provian_output_signature?: OutputSignature }> {
    const s = await signCommonsOutput(text);
    return s ? { provian_output_signature: s } : {};
}

export const forumPostSignatureField = (content: string) => signatureField(forumPostOutputText(content));
export const wantSignatureField = (outcome: string, capabilities: readonly string[], preferredChains?: readonly string[]) =>
    signatureField(wantOutputText(outcome, capabilities, preferredChains ?? []));
export const jobPostSignatureField = (title: string, description: string) => signatureField(jobPostOutputText(title, description));
export const deliverableSignatureField = (uri?: string | null, body?: string | null) => signatureField(deliverableOutputText(uri, body));

/** The plaintext to seal for a thread message: the text, plus its signature trailer when signed. */
export async function signedThreadPlaintext(text: string): Promise<string> {
    const s = await signCommonsOutput(text);
    return s ? withThreadOutputSignature(text, s) : text;
}

/** What a thread message SHOWS (the trailer stripped) and the signature over it, if any. */
export function readThreadPlaintext(plaintext: string): { text: string; signature: OutputSignature | null } {
    return splitThreadOutputSignature(plaintext);
}

/**
 * Queue a signed output the app is SHOWING, unless it is the viewer's own. Returns true when queued.
 * The hash check is the capture rule's own (`enqueueReceivedOutput`).
 */
export function captureShownOutput(
    signature: unknown,
    shownText: string,
    who: { readonly authorId: string | null | undefined; readonly myId: string | null | undefined },
): boolean {
    if (signature === undefined || signature === null) return false;
    if (who.myId && who.authorId && who.authorId === who.myId) return false;
    return enqueueReceivedOutput(signature, shownText);
}

/** Every signed post in a forum read (the post, its root and its comments), captured as shown. */
export function captureShownForumPosts(
    posts: ReadonlyArray<{ author_wallet_id: string; content: string; provian_output_signature?: unknown } | null | undefined>,
    myId: string | null,
): number {
    let queued = 0;
    for (const p of posts) {
        if (!p) continue;
        if (captureShownOutput(p.provian_output_signature, forumPostOutputText(p.content), { authorId: p.author_wallet_id, myId })) queued += 1;
    }
    return queued;
}
