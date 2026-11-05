/**
 * New-type intake A4 — the per-AGENT-submitter activation notice.
 *
 * Before: an agent that submitted a type heard of its activation only through the broadcast
 * `action_type_activated` webhook, and only if it had subscribed. Now each agent submitter (an act
 * key whose `actor_id` resolves to an agent wallet) gets an inbox event (the pull channel, no
 * webhook endpoint needed) plus a TARGETED webhook to its own subscription; humans keep the push.
 * Each is sent once per (type, submitter) — a re-run sends nothing. RED controls: an id that does
 * not resolve to an agent wallet is pushed as a human and gets no inbox event; a second fan-out
 * sends nothing on any channel.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  fanOutOneActionTypeActivation,
  runActionTypeActivationNotify,
  type ActivationTargetedWebhookDispatcher,
} from './action-type-activation-notify';
import { getPolicyRuling, markPolicyRulingLive } from './policy-rulings';
import { observePendingPolicyAction } from './pending-policy-queue';
import { setPolicyRuling } from '../__test-helpers__/policy-ruling-fixture';

const NOW = Date.UTC(2026, 9, 22, 12);
const TYPE = ['kiln', 'cycle', 'completed'].join('_');

async function seedActKey(d: FakeFirestore, id: string, actorId: string): Promise<void> {
  await d.collection('meter_act_keys_v1').doc(id).set({ relay_pe_id: id, action_type: TYPE, actor_id: actorId, timestamp: NOW });
}

function captures() {
  const pushes: string[] = [];
  const targeted: Array<{ recipients: string[]; data?: Record<string, unknown> }> = [];
  const broadcasts: string[] = [];
  const push = (async (_db: Firestore, userId: string) => {
    pushes.push(userId);
    return { successCount: 1, failureCount: 0, invalidTokens: [], expoCount: 0, fcmCount: 1, hadTokens: true };
  }) as never;
  const dispatchTargetedWebhook: ActivationTargetedWebhookDispatcher = async (args) => {
    targeted.push({ recipients: args.recipients, data: args.data });
  };
  return {
    pushes, targeted, broadcasts,
    deps: {
      now: NOW, env: {}, pushToUser: push, dispatchTargetedWebhook,
      dispatchWebhook: async (event: string) => { broadcasts.push(event); },
    },
  };
}

function inboxEvents(d: FakeFirestore, walletId: string): Array<Record<string, unknown>> {
  return [...d.store.entries()]
    .filter(([k]) => k.startsWith(`agent_wallets/${walletId}/inbox_v1/`))
    .map(([, v]) => v);
}

describe('per-agent-submitter activation notice', () => {
  it('an agent submitter gets ONE inbox event + ONE targeted webhook (no push); a human gets ONE push', async () => {
    const d = createFakeFirestore();
    await d.collection('agent_wallets').doc('wallet_a1').set({ id: 'wallet_a1', agent_id: 'agent_a1', status: 'active' });
    await seedActKey(d, 'pe1', 'agent_a1');
    await seedActKey(d, 'pe2', 'agent_a1'); // same agent twice → one notice
    await seedActKey(d, 'pe3', 'human_h1');
    const c = captures();

    const res = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 10_000 }, c.deps);
    expect(res).toMatchObject({ agents_seen: 1, agents_notified: 1, humans_seen: 1, humans_notified: 1, webhook_dispatched: true });
    expect(c.pushes).toEqual(['human_h1']);
    expect(c.targeted).toHaveLength(1);
    expect(c.targeted[0].recipients).toEqual(['wallet_a1']);
    expect(c.targeted[0].data).toMatchObject({ action_type: TYPE, effective_at_ms: NOW, weight_bps: 10_000 });
    const events = inboxEvents(d, 'wallet_a1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'action_type_activated', entity_id: TYPE, entity_type: 'action_type' });
    expect(String((events[0].data as Record<string, unknown>).public_url)).toContain(`/proposals/${TYPE}`);
  });

  it('an agent keyed by its wallet doc id resolves too', async () => {
    const d = createFakeFirestore();
    await d.collection('agent_wallets').doc('wallet_b2').set({ id: 'wallet_b2', agent_id: 'agent_b2', status: 'active' });
    await seedActKey(d, 'pe1', 'wallet_b2');
    const c = captures();
    const res = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(res.agents_notified).toBe(1);
    expect(inboxEvents(d, 'wallet_b2')).toHaveLength(1);
    expect(c.pushes).toEqual([]);
  });

  it('RED — a second fan-out sends nothing on any channel (per-(type, submitter) markers)', async () => {
    const d = createFakeFirestore();
    await d.collection('agent_wallets').doc('wallet_a1').set({ id: 'wallet_a1', agent_id: 'agent_a1', status: 'active' });
    await seedActKey(d, 'pe1', 'agent_a1');
    await seedActKey(d, 'pe2', 'human_h1');
    const c = captures();
    await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    const second = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(second).toMatchObject({ webhook_dispatched: false, agents_notified: 0, humans_notified: 0 });
    expect(c.pushes).toHaveLength(1);
    expect(c.targeted).toHaveLength(1);
    expect(c.broadcasts).toHaveLength(1);
    expect(inboxEvents(d, 'wallet_a1')).toHaveLength(1);
  });

  it('RED — an id that resolves to no agent wallet is a human: pushed, no inbox event, no targeted webhook', async () => {
    const d = createFakeFirestore();
    await seedActKey(d, 'pe1', 'agent_without_wallet');
    const c = captures();
    const res = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(res).toMatchObject({ agents_seen: 0, humans_seen: 1 });
    expect(c.pushes).toEqual(['agent_without_wallet']);
    expect(c.targeted).toEqual([]);
    expect(inboxEvents(d, 'agent_without_wallet')).toEqual([]);
  });

  it('REVIEW FIX 4 — a failing inbox write writes NO marker and reports incomplete; the next run delivers it once', async () => {
    const d = createFakeFirestore();
    await d.collection('agent_wallets').doc('wallet_a1').set({ id: 'wallet_a1', agent_id: 'agent_a1', status: 'active' });
    await seedActKey(d, 'pe1', 'agent_a1');
    const c = captures();
    const failed = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, {
      ...c.deps, writeInbox: async () => { throw new Error('inbox down'); },
    });
    expect(failed).toMatchObject({ agents_notified: 0, complete: false });
    expect(c.targeted).toEqual([]); // nothing half-sent
    const retry = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(retry).toMatchObject({ agents_notified: 1, complete: true });
    expect(inboxEvents(d, 'wallet_a1')).toHaveLength(1);
    expect(c.targeted).toHaveLength(1);
  });

  it('REVIEW FIX 4 — an agent_wallets lookup failure neither pushes the submitter as a human nor marks it', async () => {
    const d = createFakeFirestore();
    await seedActKey(d, 'pe1', 'agent_a1');
    const c = captures();
    // The lookup throws for this run only.
    const failing = new Proxy(d, {
      get(target, prop, receiver) {
        if (prop === 'collection') {
          return (name: string) => {
            if (name === 'agent_wallets') throw new Error('agent_wallets unavailable');
            return target.collection(name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const res = await fanOutOneActionTypeActivation(failing as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(res).toMatchObject({ humans_seen: 0, agents_seen: 0, complete: false });
    expect(c.pushes).toEqual([]); // RED: the pre-fix code pushed 'agent_a1' as a human here
    expect([...d.store.keys()].filter((k) => k.startsWith('pvt_action_type_activation_notify_v1/') && !k.includes('/wh__'))).toEqual([]);
    // Once the lookup works the agent is told.
    await d.collection('agent_wallets').doc('wallet_a1').set({ id: 'wallet_a1', agent_id: 'agent_a1', status: 'active' });
    const retry = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
    expect(retry).toMatchObject({ agents_notified: 1, complete: true });
    expect(c.pushes).toEqual([]);
  });

  it('REVIEW FIX 4 — runActionTypeActivationNotify leaves the ruling\'s fan-out OPEN while a submitter is unreached, then closes it', async () => {
    const d = createFakeFirestore();
    await d.collection('system_status').doc('monetary_activation').set({ effective_at_ms: NOW, digest_match: true });
    await d.collection('agent_wallets').doc('wallet_a1').set({ id: 'wallet_a1', agent_id: 'agent_a1', status: 'active' });
    await seedActKey(d, 'pe1', 'agent_a1');
    await setPolicyRuling(d as unknown as Firestore, { actionType: TYPE, ruling: 'building', issueUrl: 'https://g/i', operatorId: 'op:1', now: NOW });
    await markPolicyRulingLive(d as unknown as Firestore, TYPE, NOW);
    const c = captures();
    const first = await runActionTypeActivationNotify(d as unknown as Firestore, { ...c.deps, writeInbox: async () => { throw new Error('inbox down'); } });
    expect(first.examined).toBe(1);
    expect((await getPolicyRuling(d as unknown as Firestore, TYPE))?.activation_fanout_at).toBeNull();
    const second = await runActionTypeActivationNotify(d as unknown as Firestore, c.deps);
    expect(second.examined).toBe(1);
    expect(second.fanned_out[0]).toMatchObject({ agents_notified: 1, complete: true });
    expect((await getPolicyRuling(d as unknown as Firestore, TYPE))?.activation_fanout_at).toBe(NOW);
    expect((await runActionTypeActivationNotify(d as unknown as Firestore, c.deps)).examined).toBe(0);
    expect(inboxEvents(d, 'wallet_a1')).toHaveLength(1);
    expect(c.broadcasts).toHaveLength(1);
  });

  describe(' , C — every submitter is told, however long review takes', () => {
    /** The queue observation the accrual writes (through the REAL writer), carrying the submitter. */
    async function observe(d: FakeFirestore, peId: string, actorId: string | null): Promise<void> {
      await observePendingPolicyAction(d as unknown as Firestore, {
        actionType: TYPE, peId, integrationSource: 'device_gateway_observer', actorId, now: NOW,
      });
    }

    it('the observation records its submitter as actor_id (and omits it when there is none)', async () => {
      const d = createFakeFirestore();
      await observe(d, 'pe_obs_1', 'human_h9');
      await observe(d, 'pe_obs_2', null);
      const rows = [...d.store.entries()].filter(([k]) => k.startsWith('pvt_pending_policy_observations/')).map(([, v]) => v);
      expect(rows.map((r) => r.actor_id ?? null).sort()).toEqual(['human_h9', null]);
    });

    it('a submitter with NO act key (its act aged out of the 31-day window) is reached through its observation — agent and human', async () => {
      const d = createFakeFirestore();
      await d.collection('agent_wallets').doc('wallet_old').set({ id: 'wallet_old', agent_id: 'agent_old', status: 'active' });
      await observe(d, 'pe_old_agent', 'agent_old');
      await observe(d, 'pe_old_human', 'human_old');
      expect([...d.store.keys()].some((k) => k.startsWith('meter_act_keys_v1/'))).toBe(false);
      const c = captures();
      const res = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, c.deps);
      expect(res).toMatchObject({ agents_seen: 1, agents_notified: 1, humans_seen: 1, humans_notified: 1, complete: true });
      expect(c.pushes).toEqual(['human_old']);
      expect(inboxEvents(d, 'wallet_old')).toHaveLength(1);
    });

    it('observations and act keys are UNITED (one notice per submitter) and paged to the end — RED: the page size is never a cap', async () => {
      const d = createFakeFirestore();
      const humans = Array.from({ length: 7 }, (_, i) => `human_p${i}`);
      for (const [i, h] of humans.entries()) {
        if (i % 2 === 0) await observe(d, `pe_o${i}`, h);
        else await seedActKey(d, `pe_k${i}`, h);
      }
      await observe(d, 'pe_dup', humans[1]); // also has an act key: still one notice
      const c = captures();
      const res = await fanOutOneActionTypeActivation(d as unknown as Firestore, TYPE, { effectiveAtMs: NOW, weightBps: 1 }, { ...c.deps, peScanLimit: 2 });
      expect(res).toMatchObject({ humans_seen: 7, humans_notified: 7, complete: true });
      expect([...c.pushes].sort()).toEqual([...humans].sort());
    });
  });
});
