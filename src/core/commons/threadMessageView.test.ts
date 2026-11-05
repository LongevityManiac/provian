/**
 * a thread shows "verified" only from what the relay holds.
 *
 * RED controls: a FORGED presentation message (client origin, attachment `verdict: 'valid'`) renders
 * no verdict; a forged deliverable renders no deliverable badge; a relay presentation whose request
 * record is not `verified` renders no verdict even when its attachment says `valid`. Before the
 * screen read `attachment.verdict === 'valid'` and rendered "Presentation verified".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewThreadAttachment, viewThreadBody } from './threadMessageView';
import type { ThreadMessage, ThreadPresentationRequest } from './CommonsService';

const ME = 'user_me';
const THEM = 'wallet_aw_them';
const THREAD = 'thr_1';

function msg(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    message_id: 'msg_1', thread_id: THREAD, author_id: THEM, author_kind: 'agent', kind: 'text',
    ciphertexts: {}, content_sha256: null, attachment: null, pe_id: 'pe_1', minted_under_window: false,
    created_at: 1, ...over,
  };
}

function req(over: Partial<ThreadPresentationRequest>): ThreadPresentationRequest {
  return {
    request_id: 'preq_1', requester_id: ME, presenter_id: THEM, thread_id: THREAD, tier: 'reputation',
    status: 'challenged', audience: ME, challenge: 'c'.repeat(64),
    predicates: [{ field: 'work.sealed_count', op: 'gte', threshold: 3 }] as ThreadPresentationRequest['predicates'],
    verdict: null, predicate_results: null, created_at_ms: 1, expires_at_ms: 2, ...over,
  };
}

const forgedAttachment = { request_id: 'preq_1', verdict: 'valid', predicate_results: [{ field: 'x', op: 'gte', result: true }] };

describe('viewThreadAttachment — presentations', () => {
  it('RED: a client-origin presentation with attachment verdict "valid" renders nothing', () => {
    const verified = { preq_1: req({ status: 'verified', verdict: 'valid' }) };
    expect(viewThreadAttachment(msg({ kind: 'presentation', attachment: forgedAttachment }), verified, ME)).toBeNull();
    expect(viewThreadAttachment(msg({ kind: 'presentation', origin: 'client', attachment: forgedAttachment }), verified, ME)).toBeNull();
  });

  it('RED: a relay presentation whose request record is not verified renders no verdict, whatever the attachment says', () => {
    const m = msg({ kind: 'presentation', origin: 'relay', attachment: forgedAttachment });
    expect(viewThreadAttachment(m, {}, ME)).toBeNull();
    expect(viewThreadAttachment(m, { preq_1: req({ status: 'presented' }) }, ME)).toBeNull();
    // A record from ANOTHER thread proves nothing here.
    expect(viewThreadAttachment(m, { preq_1: req({ status: 'verified', verdict: 'valid', thread_id: 'thr_other' }) }, ME)).toBeNull();
  });

  it('the verdict and results come from the relay record — an invalid record renders invalid even if the attachment says valid', () => {
    const m = msg({ kind: 'presentation', origin: 'relay', attachment: forgedAttachment });
    const invalid = viewThreadAttachment(m, { preq_1: req({ status: 'verified', verdict: 'invalid', predicate_results: [{ field: 'work.sealed_count', op: 'gte', result: false }] }) }, ME);
    expect(invalid).toEqual({ kind: 'presentation', outcome: 'invalid', results: [{ field: 'work.sealed_count', op: 'gte', result: false }] });
    const valid = viewThreadAttachment(m, { preq_1: req({ status: 'verified', verdict: 'valid', predicate_results: [] }) }, ME);
    expect(valid).toEqual({ kind: 'presentation', outcome: 'valid', results: [] });
  });
});

describe('viewThreadAttachment — presentation requests', () => {
  it('RED: a client-origin request renders nothing (no Present button on a forged binding)', () => {
    const m = msg({ kind: 'presentation_request', attachment: { request_id: 'preq_1', audience: 'evil', challenge: 'x' } });
    expect(viewThreadAttachment(m, { preq_1: req({}) }, ME)).toBeNull();
  });

  it('a relay request offers Present to the addressed party from the relay record, and shows the recorded verdict', () => {
    const theirs = msg({ kind: 'presentation_request', origin: 'relay', author_id: ME, attachment: { request_id: 'preq_1', predicates: [] } });
    const asPresenter = viewThreadAttachment(theirs, { preq_1: req({}) }, THEM);
    expect(asPresenter).toMatchObject({ kind: 'presentation_request', mine: false, canPresent: true, outcome: null });
    expect(asPresenter && asPresenter.kind === 'presentation_request' ? asPresenter.predicates : []).toHaveLength(1);
    expect(viewThreadAttachment(theirs, { preq_1: req({}) }, ME)).toMatchObject({ mine: true, canPresent: false });
    expect(viewThreadAttachment(theirs, {}, THEM)).toMatchObject({ request: null, canPresent: false, predicates: [] });
    expect(viewThreadAttachment(theirs, { preq_1: req({ status: 'verified', verdict: 'valid' }) }, THEM)).toMatchObject({ outcome: 'valid', canPresent: false });
  });
});

describe('viewThreadAttachment — deliverables', () => {
  const attachment = { deliverable_uri: 'https://evil.example/x', deliverable_sha256: 'a'.repeat(64), delivery_pe_id: 'pe_x' };

  it('RED: a client-origin (or legacy, origin-less) deliverable renders no deliverable badge', () => {
    expect(viewThreadAttachment(msg({ kind: 'deliverable', attachment }), {}, ME)).toBeNull();
    expect(viewThreadAttachment(msg({ kind: 'deliverable', origin: 'client', attachment }), {}, ME)).toBeNull();
  });

  it('a relay deliverable renders its locator and hash', () => {
    expect(viewThreadAttachment(msg({ kind: 'deliverable', origin: 'relay', attachment }), {}, ME))
      .toEqual({ kind: 'deliverable', uri: 'https://evil.example/x', sha256: 'a'.repeat(64) });
  });
});

describe('viewThreadAttachment — plain messages', () => {
  it('an application note is a label; a plain text message renders nothing', () => {
    expect(viewThreadAttachment(msg({ attachment: { application: true } }), {}, ME)).toEqual({ kind: 'application' });
    expect(viewThreadAttachment(msg({}), {}, ME)).toBeNull();
    // A text message whose attachment mimics a verdict is still just text.
    expect(viewThreadAttachment(msg({ attachment: forgedAttachment }), { preq_1: req({ status: 'verified', verdict: 'valid' }) }, ME)).toBeNull();
  });
});

describe('viewThreadBody — "Encrypted for another key" only when true ', () => {
  const sealed = msg({ ciphertexts: { [ME]: 'box_me', [THEM]: 'box_them' } });

  it('an opened box shows its text', () => {
    expect(viewThreadBody(sealed, 'hi the operator', false)).toEqual({ kind: 'text', text: 'hi the operator' });
  });

  it('the key unlocked but the box did not open (or no copy is addressed to me) → another key', () => {
    expect(viewThreadBody(sealed, null, false)).toEqual({ kind: 'other_key' });
  });

  it('RED: the key could not be unlocked, so nothing was tried → "Couldn\'t unlock" with Try again, never "another key"', () => {
    expect(viewThreadBody(sealed, undefined, true)).toEqual({ kind: 'cant_unlock' });
    expect(viewThreadBody(sealed, undefined, true).kind).not.toBe('other_key');
  });

  it('not tried yet shows nothing (no flash of either text); a message with no sealed text shows nothing', () => {
    expect(viewThreadBody(sealed, undefined, false)).toEqual({ kind: 'none' });
    expect(viewThreadBody(msg({ ciphertexts: {} }), undefined, true)).toEqual({ kind: 'none' });
    expect(viewThreadBody(msg({ kind: 'presentation', ciphertexts: { [ME]: 'x' } }), undefined, true)).toEqual({ kind: 'none' });
  });

  it('the thread screen marks a thread read only when its key opened, and renders through viewThreadBody', () => {
    const src = readFileSync(resolve(__dirname, '../../screens/Commons/CommonsThread.tsx'), 'utf8');
    expect(src).toMatch(/if \(unlocked\) \{[\s\S]*?setShownCursor/);
    expect(src).toContain('markThreadRead(threadId, shownCursor)');
    expect(src.match(/markThreadRead\(/g)).toHaveLength(1);
    expect(src).toMatch(/viewThreadBody\(m, plain\[m\.message_id\], keyUnavailable\)/);
    expect(src).toMatch(/commons\.threadCantUnlock/);
  });
});
