/**
 * threadMessageView — what a thread message may SHOW as verified.
 *
 * A thread message's `attachment` is data its author sent; before a party could post
 * `{kind:'presentation', attachment:{verdict:'valid'}}` and this screen rendered "Presentation
 * verified" from it. Two facts are the relay's alone, and only they drive a badge here:
 *
 * - `origin === 'relay'` set by the relay on every message it composes itself (a request it
 * signed, a verdict it computed, a delivery it recorded). The relay refuses those kinds from a
 * client, and no client field can set `origin`. A message without it is a client message.
 * - the relay-held PRESENTATION REQUEST record (`GET /v1/threads/:id/presentation-requests`) — its
 * `status` / `verdict` / `predicate_results`, and its audience / challenge / signed envelope for
 * the Present action. The message attachment is never read for any of these.
 *
 * Pure (no React Native), so the rule is testable under Vitest.
 */
import type { ChallengePredicate, ThreadMessage, ThreadPresentationRequest } from './CommonsService';

export type PresentationOutcome = 'valid' | 'invalid';

export type ThreadAttachmentView =
  | {
    kind: 'presentation_request';
    mine: boolean;
    /** The relay-held request (null when the relay list has no such request for this thread). */
    request: ThreadPresentationRequest | null;
    predicates: ChallengePredicate[];
    /** The relay's verdict, only once the request record reads `verified`. */
    outcome: PresentationOutcome | null;
    /** The addressed party may present while the relay record is `challenged`. */
    canPresent: boolean;
  }
  | {
    kind: 'presentation';
    outcome: PresentationOutcome;
    results: Array<{ field: string; op: string; result: boolean }>;
  }
  | { kind: 'deliverable'; uri: string | null; sha256: string | null }
  | { kind: 'application' }
  | null;

/** Whether the relay composed this message (the only origin whose kind means anything). */
export function isRelayOriginated(m: Pick<ThreadMessage, 'origin'>): boolean {
  return m.origin === 'relay';
}

function requestFor(
  m: ThreadMessage,
  requests: Readonly<Record<string, ThreadPresentationRequest>>,
): ThreadPresentationRequest | null {
  const id = (m.attachment as { request_id?: unknown } | null)?.request_id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const r = requests[id];
  if (!r || r.request_id !== id) return null;
  // The record must belong to this thread (a request id from another thread proves nothing here).
  if (r.thread_id !== m.thread_id) return null;
  return r;
}

function verifiedOutcome(r: ThreadPresentationRequest | null): PresentationOutcome | null {
  if (!r || r.status !== 'verified') return null;
  return r.verdict === 'valid' || r.verdict === 'invalid' ? r.verdict : null;
}

/** The view of one message's attachment; `null` renders nothing beyond the message bubble. */
export function viewThreadAttachment(
  m: ThreadMessage,
  requests: Readonly<Record<string, ThreadPresentationRequest>>,
  myId: string | null,
): ThreadAttachmentView {
  const relay = isRelayOriginated(m);
  if (m.kind === 'presentation_request') {
    if (!relay) return null;
    const request = requestFor(m, requests);
    const mine = m.author_id === myId;
    return {
      kind: 'presentation_request',
      mine,
      request,
      predicates: Array.isArray(request?.predicates) ? request.predicates : [],
      outcome: verifiedOutcome(request),
      canPresent: !mine && request !== null && request.status === 'challenged'
        && typeof request.audience === 'string' && typeof request.challenge === 'string',
    };
  }
  if (m.kind === 'presentation') {
    if (!relay) return null;
    const request = requestFor(m, requests);
    const outcome = verifiedOutcome(request);
    if (outcome === null) return null;
    const results = Array.isArray(request?.predicate_results) ? request.predicate_results : [];
    return { kind: 'presentation', outcome, results };
  }
  if (m.kind === 'deliverable') {
    if (!relay) return null;
    const a = (m.attachment ?? {}) as Record<string, unknown>;
    return {
      kind: 'deliverable',
      uri: typeof a.deliverable_uri === 'string' && a.deliverable_uri.length > 0 ? a.deliverable_uri : null,
      sha256: typeof a.deliverable_sha256 === 'string' ? a.deliverable_sha256 : null,
    };
  }
  // A job application note is a label, not a verification claim.
  if ((m.attachment as { application?: unknown } | null)?.application === true) return { kind: 'application' };
  return null;
}

/**
 * What a message's text area shows (, item 2). "Encrypted for another key"
 * only when it is true: the box was tried with this person's key and did not open, or no copy was
 * sealed to them. When the key itself could not be unlocked (Face ID declined or failed), nothing was
 * tried, so the screen says so and offers Try again — the 9/22 bubble was this case.
 *
 * `opened` the text when the box opened, `null` when this key was tried and it did not open (or no
 * copy is addressed to this person), `undefined` when not tried yet.
 */
export type ThreadBodyView =
  | { kind: 'text'; text: string }
  | { kind: 'cant_unlock' }
  | { kind: 'other_key' }
  | { kind: 'none' };

export function viewThreadBody(
  m: Pick<ThreadMessage, 'kind' | 'ciphertexts'>,
  opened: string | null | undefined,
  keyUnavailable: boolean,
): ThreadBodyView {
  if (typeof opened === 'string') return { kind: 'text', text: opened };
  if (m.kind !== 'text' || Object.keys(m.ciphertexts ?? {}).length === 0) return { kind: 'none' };
  if (opened === null) return { kind: 'other_key' };
  return keyUnavailable ? { kind: 'cant_unlock' } : { kind: 'none' };
}
