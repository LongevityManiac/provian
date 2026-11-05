// Carry a beneficiary-link invitation through installation.

/** Agent invite id (`inv_<uuid>` or `inv_fleet_<hex>`). */
export const AGENT_INVITE_ID = /^inv_[A-Za-z0-9_-]{8,128}$/
/** Agent wallet id (`wallet_aw_<uuid>`). */
export const AGENT_WALLET_ID = /^wallet_aw_[A-Za-z0-9-]{8,128}$/

/** Android package (app.json `android.package`). */
export const ANDROID_PACKAGE = 'com.provian.wallet'
/** The one install-referrer key the app reads. */
export const INSTALL_REFERRER_INVITE_KEY = 'provian_invite'

export function canonicalAgentInviteUrl(inviteId: string, agentWalletId: string): string {
  return `https://provian.ai/invited?invite=${inviteId}&agent_wallet=${agentWalletId}`
}

/** A shape-checked invite carried in a page's query string, or null. */
export type CarriedInvite =
  | { kind: 'agent'; inviteId: string; agentWalletId: string }

/** Read an invite from a query string (`?invite=&agent_wallet=`). Shape-checked only. */
export function readInviteFromSearch(search: string): CarriedInvite | null {
  const params = new URLSearchParams(search)
  const inviteId = params.get('invite') ?? ''
  const agentWalletId = params.get('agent_wallet') ?? ''
  if (AGENT_INVITE_ID.test(inviteId) && AGENT_WALLET_ID.test(agentWalletId)) {
    return { kind: 'agent', inviteId, agentWalletId }
  }
  return null
}

export function canonicalInviteUrl(invite: CarriedInvite): string {
  return canonicalAgentInviteUrl(invite.inviteId, invite.agentWalletId)
}

/** The query that carries an invite to /download (same keys the invite pages use). */
export function inviteQuery(invite: CarriedInvite): string {
  return `?invite=${invite.inviteId}&agent_wallet=${invite.agentWalletId}`
}

/** The Google Play listing, carrying the invite through the install referrer when there is one. */
export function playStoreUrl(invite: CarriedInvite | null): string {
  const base = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`
  if (!invite) return base
  const referrer = `${INSTALL_REFERRER_INVITE_KEY}=${encodeURIComponent(canonicalInviteUrl(invite))}`
  return `${base}&referrer=${encodeURIComponent(referrer)}`
}

/**
 * Copy the invite's canonical URL to the clipboard (inside the user's tap), then go to `href`.
 * A clipboard that refuses or hangs never blocks the navigation.
 */
export async function copyInviteThenGo(invite: CarriedInvite, href: string): Promise<void> {
  const url = canonicalInviteUrl(invite)
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await Promise.race([
        writeInviteToClipboard(url),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ])
    }
  } catch {
    // The clipboard is one of two carriers; the Play referrer and "Open in Provian" remain.
  }
  window.location.assign(href)
}

/**
 * Put the invite on the clipboard as a URL AND as text. On iOS the app checks the
 * clipboard with the prompt-free `UIPasteboard.hasURLs` before it reads anything, and
 * that sees only a URL-typed item: a `text/uri-list` item (WebKit maps it to
 * `public.url`) makes the invite visible to that check; `text/plain` keeps a plain paste
 * working everywhere. Falls back to `writeText` where `ClipboardItem` is unavailable.
 */
async function writeInviteToClipboard(url: string): Promise<void> {
  const clip = navigator.clipboard
  if (typeof ClipboardItem !== 'undefined' && typeof clip.write === 'function') {
    try {
      await clip.write([
        new ClipboardItem({
          'text/uri-list': new Blob([url], { type: 'text/uri-list' }),
          'text/plain': new Blob([url], { type: 'text/plain' }),
        }),
      ])
      return
    } catch {
      // A browser that refuses the uri-list type falls through to plain text.
    }
  }
  await clip.writeText(url)
}
