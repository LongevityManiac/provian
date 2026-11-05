/**
 * forumPosts must hit the relay's REAL channel-posts route, `GET /v1/commons/forum/channel/:name`
 * (`page_size`/`offset`). The SDK (and the website read client) shipped calling a non-existent
 * `/forum/posts/:channel` found live 2026-09-22 in the proofs.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommonsInstitutions } from './commons-institutions';

describe('CommonsInstitutions.forumPosts route', () => {
  it('requests /v1/commons/forum/channel/:name with page_size + offset', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const institutions = new CommonsInstitutions({ relayUrl: 'https://relay.test', walletId: 'wallet_aw_x', apiKey: 'pvn_live_x', apiSecret: 'pvns_x', fetch: fetchMock as unknown as typeof fetch });
    await institutions.forumPosts('general', { limit: 30, offset: 10 });
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe('https://relay.test/v1/commons/forum/channel/general?page_size=30&offset=10');
    expect(url).not.toContain('/forum/posts/');
  });
});
