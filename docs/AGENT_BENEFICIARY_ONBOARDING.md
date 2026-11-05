# Agent Beneficiary Onboarding

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

How an agent wallet links to a human beneficiary so work routes go-forward under the live beneficiary split (sealed at record time, honored at settlement).

> **See also:**
> - `DELEGATION_PE_SPEC.md` - the `agent_work_delegated` record (retired; delegation is now a running total on the human)
> - [`provian-agent-sdk/README.md`](../provian-agent-sdk/README.md) - SDK primitives

---

## The link in one paragraph

An agent wallet can have one optional human beneficiary. For acts of work proven while the relationship is active, the relay seals a beneficiary snapshot and the configured contributor split when it seals the PE. The default gives 20% of the contributor share to the agent and 80% to the linked human; the canonical agent share is an exact integer from 500 through 5000 BPS. An unlinked agent keeps its full contributor share. Linking or changing the agent-share BPS never rewrites a prior PE, moves accrued PVT, or changes a previously sealed recipient. Changing to a different human requires an authorized unlink first; changing only the share uses `PUT /link-human`, which requires the linked human's EIP-191 signature over the new share.

There are three ways to establish the relationship. The default is the connection-code request: the agent files `POST /v1/agent/wallet/:wallet_id/request-link` with the code the human minted in the app (the one-command bootstrap does this for it), and the human taps **Accept** in the app, which is the only step that binds the beneficiary — see [AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md#beneficiary-linking). The other two, below, are a direct human-signed link and an email invite accepted by an already registered canonical human wallet.

---

## Path 1: Direct signed link

Use this path when the human already has a canonical wallet and the agent knows its `human_wallet_id`.

**Endpoint:** `POST /v1/agent/wallet/:wallet_id/link-human` (agent API-key auth)

The human signs a canonical payload with the EVM key controlling the address stored on the human wallet document. The relay verifies the EIP-191 `personal_sign` signature before creating the prospective beneficiary relationship.

### Request body

```json
{
  "human_wallet_id": "wallet_...",
  "signature": "0x<130 hex chars: 65-byte EIP-191 signature>",
  "timestamp": 1712956800000,
  "link_epoch": 1,
  "operational_reserve_bps": 2000
}
```

### Canonical signing payload

The human signs this stable-stringified UTF-8 JSON:

```json
{
  "action": "link_agent",
  "agent_wallet_id": "<the wallet_id being linked>",
  "human_wallet_id": "<human's wallet_id>",
  "link_epoch": <from GET /v1/agent/wallet/:wallet_id/link-epoch>,
  "timestamp": <unix ms>
}
```

- **Every link, unlink and share-change signature is single-use.** `link_epoch` is the agent's beneficiary-relationship epoch, read with `GET /v1/agent/wallet/:wallet_id/link-epoch` (agent API-key auth, own wallet; the SDK's `CommonsInstitutions.readLinkEpoch`). Every link, unlink and share change advances it in the same transaction that writes the change, and the relay consumes each signed payload there. A signature over an older epoch is refused `409 link_epoch_stale`; a payload already consumed `409 link_signature_already_used`; a payload without `link_epoch` `400`. So a signature applies at most once and never after a later state change (no re-link after an unlink, no share revert, no stale unlink after a relink).
- The timestamp must be within **plus or minus five minutes** of relay time (`LINK_TIMESTAMP_TOLERANCE_MS`).
- The recovered address must equal the human wallet document's `address`, case-insensitively.
- `operational_reserve_bps` is optional and defaults to `2000`.
- A supplied value must be an exact integer in `[500, 5000]`; values outside the range or with sub-BPS precision are rejected, not clamped.
- `operational_reserve_ratio` remains a legacy request-compatibility input only. If used, its decimal must convert exactly to the same BPS range; it cannot be combined with `operational_reserve_bps` and is never newly persisted.

### What the relay commits

1. Verifies the canonical payload, timestamp, signature, and wallet identities.
2. Writes the agent-to-human relationship and canonical `agent_share_bps` prospectively.
3. Records an `agent_linked_to_human` PE in the agent's chain.
4. Durably evaluates any badge records unlocked by the link.
5. Invalidates the beneficiary-status cache.

The link changes no prior PE and transfers no previously accrued PVT. The response retains the historical `retroactive_transfer` object only for API compatibility; all three amounts are always zero.

### Response

```json
{
  "wallet_id": "...",
  "linked_human_wallet_id": "wallet_...",
  "operational_reserve_bps": 2000,
  "new_badges": ["linked"],
  "retroactive_transfer": {
    "total_pvt_transferred": 0,
    "agent_retained": 0,
    "human_received": 0
  }
}
```

Badges are display signals and confer no bond discount, pricing multiplier or governance authority.

### Failure modes

- `403` - the authenticated agent does not own `wallet_id`
- `409` - the agent is already linked to a human; changing beneficiary requires an authorized unlink first
- `409 link_epoch_stale` / `409 link_signature_already_used` - the signature names an epoch the relationship has moved past, or was already used
- `400` - a field is missing or malformed, the timestamp is outside tolerance, or the BPS value is non-canonical
- `404` - `human_wallet_id` does not exist
- `400` - the target is not a human wallet or lacks a recorded EVM address
- `401` - signature verification fails or the recovered address does not match

`POST /v1/agent/wallet/:wallet_id/unlink-human` uses the same EIP-191 model with `action: "unlink_agent"` and the same single-use `link_epoch`. Unlinking preserves every prior PE snapshot; future records use unlinked routing until another relationship is established.

The linked human can also end the link **alone**: `POST /v1/agent/wallet/:wallet_id/human-unlink` under the human's own wallet auth (the app's "End link" control on the agent's detail screen, biometric-gated). Only the linked human may call it (`403 not_your_linked_agent` otherwise). The agent's wallet, agent id, API credentials, registration, and PE chain are untouched — one record-only `agent_unlinked_from_human` PE (`ended_by: "linked_human"`) is appended — and every sealed beneficiary snapshot still settles as sealed. The agent sees `linked_human_wallet_id: null` on `GET /v1/agent/wallet/:wallet_id` and a notify-only `beneficiary_link_ended` event in its inbox and on any webhook subscribed to it. There is no agent-alone unlink.

---

## Path 2: Email invite

Use an invite when the agent knows the human's email. An invite is a consent and discovery path, not an earning event: no signing bonus is paid and the compatibility `signing_bonus_pvt` field is zero.

| Endpoint | Rate limit | Acceptance window | Email template |
|----------|-----------|-------------------|----------------|
| `POST /v1/agent/wallet/:wallet_id/invite` | 5/day per wallet | 7 days | `sendAgentInvite` |
| `POST /v1/agent/wallet/:wallet_id/invite-human` | 3/day per wallet plus 1/7 days per email | 30 days | `sendBeneficiaryInvite` |

Each invite carries its own `expires_at`; a legacy invite without that field falls back to seven days from `created_at`.

Both endpoints:

- Require agent API-key authentication.
- Refuse a repeat invite to the same email (`/invite`: `409` while an active pending invite exists; `/invite-human`: `429` within seven days).
- Attempt email delivery asynchronously; a delivery failure does not mutate economic policy.
- Record an `agent_invite_sent` PE with the email represented by a hash rather than plaintext metadata.

### Email destinations

- **Web:** `https://provian.ai/invited?invite={inviteId}`
- **App deep link for beneficiary invites:** `provian://link?invite={inviteId}&agent_wallet={walletId}`

### Acceptance

**Endpoint:** `POST /v1/agent/wallet/accept-invite` (human wallet auth)

Body:

```json
{ "invite_id": "inv_..." }
```

Acceptance requires exactly one canonical `wallets/` document with `type == 'human'` for the authenticated user. The relay never fabricates or selects a human wallet during acceptance:

- No canonical human wallet returns `409 canonical_human_wallet_registration_required`; the user must complete wallet registration and retry.
- More than one candidate returns `409 canonical_human_wallet_registration_ambiguous`; the relay will not choose one arbitrarily.
- An expired invite returns `410`.
- An agent already linked to a different human returns `409`. An invite already accepted by a different user or wallet returns `409 beneficiary_link_identity_invalid`; a repeat acceptance by the same human and wallet succeeds without a second link or PE (it finishes an interrupted acceptance).

On success, the relay uses the same prospective bind path as direct linking, marks the invite accepted, and returns a zero `signing_bonus_pvt` compatibility value. It neither transfers accrued PVT nor auto-creates a wallet document.

---

## Default and configurable split

`operational_reserve_bps` is the request field for the agent's share. The
committed relationship and sealed record-time routing snapshot use
`agent_share_bps`:

| Agent-share BPS | Agent share | Linked-human share |
|-----------------|-------------|--------------------|
| `500` (floor) | 5% | 95% |
| `2000` (default) | 20% | 80% |
| `5000` (ceiling) | 50% | 50% |

The 20/80 default is neither immutable nor universal. The `PUT /v1/agent/wallet/:wallet_id/link-human` endpoint changes `operational_reserve_bps` only for later records and accepts exact integers within the existing 500-5000 BPS agent-share bounds. The agent's API key only scopes the call to its own wallet; the change is authorized by the linked human's EIP-191 signature over the stable-stringified payload `{ action: "update_beneficiary_share", agent_wallet_id, human_wallet_id, link_epoch, operational_reserve_bps, timestamp }` (same five-minute timestamp tolerance; single-use through `link_epoch`,), so an agent can never change its own share alone. Unlink/re-link is unnecessary for a share-only change. The legacy ratio field is accepted only for exact-decimal request compatibility and never becomes the stored representation.

Genesis fixed grants are a separate lifecycle: their approved 75/75/25 (75 PVT per new human wallet, 75 PVT per agent on creating its wallet, 25 PVT per registered device; no taper) and 500-PVT wallet ceiling are gross contract inputs, they bypass linked-human beneficiary routing, and they still receive the immutable treasury split. Genesis is armed and admitting through December 31, 2026 (the live kernel was armed on chain 2026-09-26).

---

## PEs generated along the way

| Trigger | PE action type | Chain |
|---------|---------------|-------|
| Invite succeeds | `agent_invite_sent` | Agent |
| Direct link or invite acceptance succeeds | `agent_linked_to_human` | Agent |
| Invite acceptance succeeds | `invite_accepted` (zero PVT) | Human |
| Link qualifies a badge record | `badge_earned` (zero PVT) | Agent |

Qualifying future agent work while linked is credited to the human as a running delegation total (`human_delegation_totals_v1`); the separate `agent_work_delegated` PE is retired. It does not rewrite the agent's earlier records. The human’s running delegation total is derived by `core/pvt/delegation-pe.ts`.

---

## Practical recipes

**The agent knows the human wallet ID.** Have the human sign the canonical payload with [`signLinkPayload`](../provian-agent-sdk/src/link-signing.ts), then call `POST /link-human`.

**The agent knows only an email.** Send `/invite-human`. The human must install or open Provian, complete canonical wallet registration if needed, and then accept before expiry.

**Change only the future split.** Read the current `link_epoch`, have the linked human sign the `update_beneficiary_share` payload, then call `PUT /link-human` with the new exact `operational_reserve_bps`, the signature, the timestamp and the `link_epoch`. Prior snapshots stay unchanged.

**Change the human beneficiary.** Obtain the current human's signed unlink authorization, unlink, and then establish the new link. Prior snapshots still stay unchanged.
