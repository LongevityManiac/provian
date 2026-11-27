/**
 * POST /v1/capture/chat-markers — the chat screen's marker verdicts, tallied per provider and
 * account state with nothing about the person.
 *
 * RED controls: a route without auth fails the 401 case; a parser that accepts extra keys fails
 * the "no person data" case; a tally that forgets the earlier unmatched time fails the
 * "matched after unmatched" case.
 */
import { describe, it, expect } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import {
  CHAT_MARKER_HEALTH_COLLECTION,
  applyChatMarkerReport,
  createChatMarkersRouter,
  parseChatMarkerReport,
} from './chat-markers';

const allow: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'unauthorized' }); };
const body = (o: Record<string, unknown> = {}) => ({
  schema: 'chat_markers/v1', provider: 'chatgpt', account: 'signed_in', matched: false, candidate: -1, counts: [0, 0, 0], ...o,
});

function app(auth: RequestHandler = allow, nowMs = 1_000) {
  const db = createFakeFirestore();
  const a = express();
  a.use(express.json());
  a.use('/v1/capture', createChatMarkersRouter({ db: db as unknown as Firestore, authenticate: auth, now: () => nowMs }));
  return { a, db };
}

describe('POST /v1/capture/chat-markers', () => {
  it('requires wallet auth', async () => {
    const { a } = app(deny);
    expect((await request(a).post('/v1/capture/chat-markers').send(body())).status).toBe(401);
  });

  it('tallies an unmatched verdict per provider and account, with no person data', async () => {
    const { a, db } = app();
    const res = await request(a).post('/v1/capture/chat-markers').send(body());
    expect(res.status).toBe(204);
    const snap = await db.collection(CHAT_MARKER_HEALTH_COLLECTION).doc('chatgpt__signed_in').get();
    expect(snap.data()).toEqual({
      schema: 'chat_marker_health/v1', provider: 'chatgpt', account: 'signed_in',
      last_matched_at_ms: null, last_unmatched_at_ms: 1_000, matched_reports: 0, unmatched_reports: 1,
      last_unmatched_counts: [0, 0, 0], last_matched_candidate: null, updated_at_ms: 1_000,
    });
  });

  it('refuses anything beyond the verdict (a wallet id, a URL, text)', async () => {
    const { a } = app();
    for (const extra of [{ wallet_id: 'w1' }, { url: 'https://chatgpt.com/c/x' }, { text: 'hello' }]) {
      expect((await request(a).post('/v1/capture/chat-markers').send(body(extra))).status).toBe(400);
    }
  });
});

describe('parseChatMarkerReport', () => {
  it('accepts a well-formed verdict', () => {
    expect(parseChatMarkerReport(body({ matched: true, candidate: 0, counts: [5, 0, 0] }))).toEqual({
      provider: 'chatgpt', account: 'signed_in', matched: true, candidate: 0, counts: [5, 0, 0],
    });
  });
  it.each([
    ['unknown provider', { provider: 'meta' }],
    ['wrong schema', { schema: 'x' }],
    ['unknown account state', { account: 'admin' }],
    ['matched with no candidate', { matched: true, candidate: -1 }],
    ['unmatched naming a candidate', { matched: false, candidate: 1 }],
    ['non-integer count', { counts: [1.5] }],
    ['too many counts', { counts: new Array(17).fill(0) }],
    ['negative count', { counts: [-1] }],
  ])('refuses %s', (_name, o) => {
    expect(parseChatMarkerReport(body(o))).toBeNull();
  });
});

describe('applyChatMarkerReport', () => {
  const r = (matched: boolean) => ({ provider: 'chatgpt', account: 'signed_in' as const, matched, candidate: matched ? 0 : -1, counts: matched ? [4, 0, 0] : [0, 0, 0] });
  it('a later match keeps the earlier unmatched time, so the operator can see both', () => {
    const a = applyChatMarkerReport(undefined, r(false), 100);
    const b = applyChatMarkerReport(a, r(true), 200);
    expect(b).toMatchObject({ last_unmatched_at_ms: 100, last_matched_at_ms: 200, matched_reports: 1, unmatched_reports: 1, last_matched_candidate: 0 });
    expect(b.last_unmatched_counts).toEqual([0, 0, 0]);
  });
  it('a later unmatched verdict is newer than the last match', () => {
    const a = applyChatMarkerReport(undefined, r(true), 100);
    const b = applyChatMarkerReport(a, r(false), 300);
    expect(b.last_unmatched_at_ms! > b.last_matched_at_ms!).toBe(true);
  });
});
