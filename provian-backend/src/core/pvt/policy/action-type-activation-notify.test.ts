import {setPolicyRuling} from '../__test-helpers__/policy-ruling-fixture';
/**
 * Phase 4 — submitter activation notice (item 05). The fan-out dispatches
 * the webhook once per live type and pushes each distinct human submitter once,
 * idempotently; the job only touches live rulings not yet fanned out. Each
 * positive assertion ships with its RED control.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  fanOutOneActionTypeActivation,
  runActionTypeActivationNotify,
  type ActivationWebhookDispatcher,
} from './action-type-activation-notify';
import { markPolicyRulingLive, getPolicyRuling } from './policy-rulings';

const NOW = Date.UTC(2026, 8, 8, 12);

function db(): Firestore {
  return createFakeFirestore() as unknown as Firestore;
}

function pushCapture() {
  const calls: Array<{ userId: string; data?: Record<string, string> }> = [];
  const push: any = async (_db: Firestore, userId: string, message: { data?: Record<string, string> }) => {
    calls.push({ userId, data: message.data });
    return { successCount: 1, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 1, hadTokens: true };
  };
  return { push, calls };
}

function webhookCapture(): { dispatch: ActivationWebhookDispatcher; calls: Array<{ event: string; payload: Record<string, unknown> }> } {
  const calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return { calls, dispatch: async (event, payload) => { calls.push({ event, payload }); } };
}

/** PE METER: a submitter is known by its act's 31-day act key (top-level `action_type` + `actor_id`). */
async function seedPe(d: Firestore, id: string, actionType: string, userId: string): Promise<void> {
  await d.collection('meter_act_keys_v1').doc(id).set({ relay_pe_id: id, action_type: actionType, actor_id: userId, timestamp: NOW });
}

async function setEffectiveAt(d: Firestore, ms: number): Promise<void> {
  await d.collection('system_status').doc('monetary_activation').set({ effective_at_ms: ms, digest_match: true });
}

describe('fanOutOneActionTypeActivation', () => {
  it('dispatches the webhook once and pushes each distinct human submitter once', async () => {
    const d = db();
    await seedPe(d, 'pe1', 'wallet_created', 'user_a');
    await seedPe(d, 'pe2', 'wallet_created', 'user_a'); // same submitter twice → one push
    await seedPe(d, 'pe3', 'wallet_created', 'user_b');
    await seedPe(d, 'pe4', 'other_type', 'user_c');     // different type → ignored
    const { push, calls: pushCalls } = pushCapture();
    const { dispatch, calls: whCalls } = webhookCapture();

    const res = await fanOutOneActionTypeActivation(
      d, 'wallet_created', { effectiveAtMs: 1785715200000, weightBps: 100000 },
      { now: NOW, pushToUser: push, dispatchWebhook: dispatch, env: {} },
    );
    expect(res.webhook_dispatched).toBe(true);
    expect(res.humans_seen).toBe(2);
    expect(res.humans_notified).toBe(2);
    expect(whCalls).toHaveLength(1);
    expect(whCalls[0].event).toBe('action_type_activated');
    expect(whCalls[0].payload.action_type).toBe('wallet_created');
    expect(new Set(pushCalls.map((c) => c.userId))).toEqual(new Set(['user_a', 'user_b']));
    expect(pushCalls[0].data?.type).toBe('action_type_activated');
    expect(pushCalls[0].data?.url).toContain('/proposals/wallet_created');
  });

  it('RED CONTROL (PE meter) — a legacy pe_history row is not a submitter source', async () => {
    const d = db();
    await d.collection('pe_history').doc('pe_old').set({ peId: 'pe_old', actionType: 'wallet_created', userId: 'user_legacy', timestamp: NOW });
    const { push, calls: pushCalls } = pushCapture();
    const res = await fanOutOneActionTypeActivation(
      d, 'wallet_created', { effectiveAtMs: 1, weightBps: 1 },
      { now: NOW, pushToUser: push, env: {} },
    );
    expect(res.humans_seen).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });

  it('RED CONTROL — a second fan-out is idempotent: no second webhook, no re-push', async () => {
    const d = db();
    await seedPe(d, 'pe1', 'wallet_created', 'user_a');
    const { push, calls: pushCalls } = pushCapture();
    const { dispatch, calls: whCalls } = webhookCapture();
    const deps = { now: NOW, pushToUser: push, dispatchWebhook: dispatch, env: {} };
    await fanOutOneActionTypeActivation(d, 'wallet_created', { effectiveAtMs: 1, weightBps: 1 }, deps);
    const second = await fanOutOneActionTypeActivation(d, 'wallet_created', { effectiveAtMs: 1, weightBps: 1 }, deps);
    expect(second.webhook_dispatched).toBe(false);
    expect(second.humans_notified).toBe(0);
    expect(whCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
  });
});

describe('runActionTypeActivationNotify', () => {
  it('fans out live rulings not yet fanned, then marks them complete', async () => {
    const d = db();
    await setEffectiveAt(d, 1785715200000);
    await seedPe(d, 'pe1', 'wallet_created', 'user_a');
    await setPolicyRuling(d, { actionType: 'wallet_created', ruling: 'building', issueUrl: 'https://g/i', operatorId: 'op:1', now: NOW });
    await markPolicyRulingLive(d, 'wallet_created', NOW);

    const { push, calls: pushCalls } = pushCapture();
    const { dispatch, calls: whCalls } = webhookCapture();
    const first = await runActionTypeActivationNotify(d, { now: NOW, pushToUser: push, dispatchWebhook: dispatch, env: {} });
    expect(first.examined).toBe(1);
    expect(first.fanned_out[0].action_type).toBe('wallet_created');
    expect(whCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
    expect((await getPolicyRuling(d, 'wallet_created'))?.activation_fanout_at).toBe(NOW);

    // idempotent: a second run finds nothing pending (fanout_at set)
    const second = await runActionTypeActivationNotify(d, { now: NOW + 1000, pushToUser: push, dispatchWebhook: dispatch, env: {} });
    expect(second.examined).toBe(0);
    expect(whCalls).toHaveLength(1);
  });

  it('RED CONTROL — a building ruling that is NOT live is never fanned out', async () => {
    const d = db();
    await setEffectiveAt(d, 1785715200000);
    await seedPe(d, 'pe1', 'wallet_created', 'user_a');
    await setPolicyRuling(d, { actionType: 'wallet_created', ruling: 'building', issueUrl: 'https://g/i', operatorId: 'op:1', now: NOW });
    // NOT marked live
    const { push, calls: pushCalls } = pushCapture();
    const { dispatch, calls: whCalls } = webhookCapture();
    const res = await runActionTypeActivationNotify(d, { now: NOW, pushToUser: push, dispatchWebhook: dispatch, env: {} });
    expect(res.examined).toBe(0);
    expect(whCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });
});
