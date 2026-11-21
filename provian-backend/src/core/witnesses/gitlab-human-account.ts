import { fetchBounded } from '../net/bounded-fetch';
import { guardedFetch } from '../../mcp/core/guarded-fetch';

// Proven GitLab installations are on gitlab.com. The push names the account;
// GitLab's public directory classifies it using the exact login and numeric ID.
export async function gitLabAccountIsHuman(account: { id: number; username: string }): Promise<boolean> {
  const url = new URL('https://gitlab.com/api/v4/users');
  url.searchParams.set('username', account.username);
  url.searchParams.set('humans', 'true');
  const response = await fetchBounded(url.href, {}, { deadlineMs: 3_000, maxBytes: 16_384, fetchImpl: guardedFetch });
  if (!response.ok) throw Error('gitlab_account_lookup_unavailable');
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw Error('gitlab_account_lookup_invalid');
  return rows.some((row: unknown) => {
    if (!row || typeof row !== 'object' || !('id' in row) || !('username' in row)) return false;
    return row.id === account.id && typeof row.username === 'string'
      && row.username.toLowerCase() === account.username.toLowerCase();
  });
}
