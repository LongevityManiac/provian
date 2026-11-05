/**
 * `POST /v1/commons/artifacts/:id/invoke` records no PE.
 *
 * The relay does not perform or observe an artifact invocation: the invoker tells the relay it
 * invoked the artifact, and that is all the relay has. An actor's own claim about its work is
 * never a PE, so the invocation is still recorded as a Commons invocation
 * (the invocation doc and the artifact's counters) but NO `commons_artifact_invoked` PE is
 * generated.
 *
 * RED control: against the pre- recordInvocation (which called generatePE with
 * actionType 'commons_artifact_invoked'), the `not.toHaveBeenCalled` assertion fails.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../agent-bank/pe-utils', () => ({
  generatePE: jest.fn(async () => ({ peId: 'pe_should_not_exist', peHash: 'h', prevHash: 'p' })),
}));

import { recordInvocation } from './artifacts';
import { generatePE } from '../agent-bank/pe-utils';
import { COMMONS_COLLECTIONS } from './types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';

const generatePEMock = generatePE as jest.MockedFunction<typeof generatePE>;

describe('recordInvocation : an invoker\'s own claim is not a PE', () => {
  beforeEach(() => { generatePEMock.mockClear(); });

  it('records the invocation and counters, and generates NO PE', async () => {
    const db = createFakeFirestore();
    await db.collection(COMMONS_COLLECTIONS.ARTIFACTS).doc('art_1').set({
      artifact_id: 'art_1', name: 'parser', deprecated: false,
      invocation_count: 0, unique_invoker_count: 0, human_attestation_count: 0, stake_pvt: 0,
    });
    const deps = { db, cache: {}, peBuffer: { enqueue: jest.fn() }, recordPEAccrual: jest.fn() } as never;

    const out = await recordInvocation(deps, 'art_1', 'wallet_aw_1', 'agent_1', '0xabc', { source_pe_id: 'pe_src' });

    expect(out.invocation_id).toMatch(/^inv_/);
    expect(generatePEMock).not.toHaveBeenCalled();
    const inv = await db.collection(COMMONS_COLLECTIONS.ARTIFACT_INVOCATIONS).doc(out.invocation_id).get();
    expect(inv.exists).toBe(true);
    const art = (await db.collection(COMMONS_COLLECTIONS.ARTIFACTS).doc('art_1').get()).data() as { invocation_count: number };
    expect(art.invocation_count).toBe(1);
  });
});
