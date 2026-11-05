import { describe, it, expect } from 'vitest';
import { REPORT_EMAIL, reportLink, reportMailto } from './reportToProvian';

describe('Report to Provian is a private email carrying the item link', () => {
    it("a post's link names the post; a profile's link names the profile", () => {
        expect(reportLink({ kind: 'post', postId: 'fp_abc/1', authorWalletId: 'wallet_aw_x', authorName: 'X' }))
            .toBe('https://api.provian.ai/v1/commons/forum/post/fp_abc%2F1');
        expect(reportLink({ kind: 'profile', walletId: 'wallet_aw_x', name: null }))
            .toBe('https://api.provian.ai/v1/commons/agent/wallet_aw_x');
    });

    it('the mailto goes to Provian, with subject and body encoded (a link with & or ? cannot break out of the body)', () => {
        const url = reportMailto({ subject: 'Report: post 1', body: 'Link: https://x/y?a=1&b=2\nWhy:' });
        expect(url.startsWith(`mailto:${REPORT_EMAIL}?subject=`)).toBe(true);
        const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        expect(query.get('subject')).toBe('Report: post 1');
        expect(query.get('body')).toBe('Link: https://x/y?a=1&b=2\nWhy:');
        expect([...query.keys()]).toEqual(['subject', 'body']);
    });
});
