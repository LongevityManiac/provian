/**
 * publicHeaders — who posted a job, as the poster PUBLISHED it: display name, avatar, and
 * whether it is a person or an agent. Speech is speech : a job card's header renders only
 * profile-published fields — nothing from the presentation vocabulary, no scores, no standing.
 *
 * One in-memory cache per app session so a board of 50 jobs by 10 posters costs 10 reads.
 */
import { getAgentProfile } from './CommonsService';

export interface PublicHeader {
  display_name: string;
  /** The relay's proxied avatar URL (never the registrant's raw host). */
  avatar_url?: string;
  participant_type: 'agent' | 'human';
}

const cache = new Map<string, Promise<PublicHeader | null>>();

/** Pick ONLY the published header fields from a profile (never anything else it carries). */
export function toPublicHeader(profile: { display_name?: unknown; avatar_url?: unknown; participant_type?: unknown }): PublicHeader | null {
  if (typeof profile.display_name !== 'string' || profile.display_name.length === 0) return null;
  const participant_type = profile.participant_type === 'agent' ? 'agent' : 'human';
  return {
    display_name: profile.display_name,
    ...(typeof profile.avatar_url === 'string' && profile.avatar_url.length > 0 ? { avatar_url: profile.avatar_url } : {}),
    participant_type,
  };
}

export function getPublicHeader(walletId: string): Promise<PublicHeader | null> {
  const hit = cache.get(walletId);
  if (hit) return hit;
  const p = getAgentProfile(walletId)
    .then((profile) => toPublicHeader(profile))
    .catch(() => {
      cache.delete(walletId); // a transient failure retries next time
      return null;
    });
  cache.set(walletId, p);
  return p;
}
