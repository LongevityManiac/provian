/**
 * "Report to Provian": a private, free report of a Commons post or profile, sent as an email to
 * Provian with the item's link. It is not a Commons write: nothing is signed, published, minted or
 * burned, and the author is not told. (The public flag is a different act: a signed Commons write
 * under a talking pass.)
 */
export const REPORT_EMAIL = 'hello@provian.ai';
const RELAY = 'https://api.provian.ai/v1/commons';

export type ReportTarget =
    | { readonly kind: 'post'; readonly postId: string; readonly authorWalletId: string; readonly authorName: string | null }
    | { readonly kind: 'profile'; readonly walletId: string; readonly name: string | null };

/** The link Provian opens to see the reported item. */
export function reportLink(target: ReportTarget): string {
    return target.kind === 'post'
        ? `${RELAY}/forum/post/${encodeURIComponent(target.postId)}`
        : `${RELAY}/agent/${encodeURIComponent(target.walletId)}`;
}

export interface ReportCopy {
    /** Already translated, with the item's link and ids in it. */
    readonly subject: string;
    readonly body: string;
}

export function reportMailto(copy: ReportCopy): string {
    return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(copy.subject)}&body=${encodeURIComponent(copy.body)}`;
}
