# Invited Landing Page

## Overview
Landing page for humans who receive an agent's beneficiary-link invite email, at `provian.ai/invited`. Checked against the source (`src/app/invited/`) and the live site on 2026-10-22.

## URL Structure
```
https://provian.ai/invited?invite=INVITE_ID&agent_wallet=WALLET_ID
```

The relay's invite emails build this URL in `provian-backend/src/email.ts`. The beneficiary-invite email always carries both parameters; the older agent-invite email carries `agent_wallet` only when the caller supplies it.

## Features

### Dynamic Content (with graceful fallback)
- **Agent name**: personalizes the subhead when the invite read returns it.
- **PE count**: shows the Provenance Envelope count badge and the "This invite is real" card copy when returned.
- Falls back to generic copy when either parameter is missing, the read fails, or the invite is expired, accepted, or unknown.

### Download CTAs
1. **Get it on Google Play** links to the [Provian Wallet listing](https://play.google.com/store/apps/details?id=com.provian.wallet) and carries the invitation in the Play install referrer.
2. **Download for iPhone**: links to `/download` (the "Get the app" page, which shows the pending App Store card with a notify-me sign-up). There is no App Store URL in the page yet. When the page's query carries a well-formed agent invite, this link carries the same `?invite=…&agent_wallet=…` query to `/download`.
3. **Open in app** (shown only when both parameters are present): `provian://link?invite={invite}&agent_wallet={wallet}`, handled by the app's `link` deep-link route (`src/navigation/AppNavigator.tsx`).

When the query carries a well-formed agent invite, the Google Play tap also copies the invite's canonical URL to the clipboard (`src/lib/inviteCarry.ts`), so the app picks up the invitation on first launch.

### API Integration (optional)
When both parameters are present, the page fetches invite details client-side from:
```
GET https://api.provian.ai/v1/agent/wallet/invite/{invite}
```
(`provian-backend/src/routes/agent-wallet.ts`, `GET /invite/:invite_id`: public, IP-rate-limited, answers 404/410/409 for unknown/expired/accepted invites.)

Response (200):
```json
{
  "agent_name": "Atlas",
  "pe_count": 1247,
  "signing_bonus_pvt": 0,
  "agent_wallet_id": "…",
  "invite_id": "…"
}
```
The page reads only `agent_name` and `pe_count`. `signing_bonus_pvt` is a compatibility field that is always 0.

## Status (live check, 2026-10-22)

Checked with the site's Basic Auth credentials, and without them.

- **Website:** `/invited/` and the linked public reading pages are reachable without an account.
- **Hero image**: the page renders `<img src="/invited-hero.jpg">` (`public/invited-hero.jpg`), and the live URL answers 200.
- **Android**: the install button opens the [Google Play listing](https://play.google.com/store/apps/details?id=com.provian.wallet).
- **iOS**: `/download/` shows the App Store card as pending. When the App Store listing is approved, point the "Download for iPhone" button in `src/app/invited/page.tsx` at it.
- **Unsubscribe**: the page has no footer unsubscribe link. Invite emails carry their own signed unsubscribe link from the relay (`/v1/unsubscribe?token=…`), and the page has no token to unsubscribe anyone.

## Technical Details

- **Files**: `src/app/invited/page.tsx` (client component), `src/app/invited/layout.tsx` (metadata).
- **Metadata**: `robots: { index: false, follow: false }` — the page is deliberately not indexed.
- **Rendering**: static export; invite details load client-side after the page renders.

## Email Template Reference

Agent invite emails link to:
```
https://provian.ai/invited?invite={{INVITE_ID}}&agent_wallet={{AGENT_WALLET}}
```

Where:
- `INVITE_ID`: the invite id the relay issues
- `AGENT_WALLET`: the agent's wallet id
