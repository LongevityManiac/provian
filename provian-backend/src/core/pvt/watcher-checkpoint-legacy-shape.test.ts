/**
 * M9 — THE LIVE PRODUCTION CHECKPOINT DOCUMENTS ARE THE LEGACY 3-KEY SHAPE.
 *
 * M10 UPDATE — FIXED, AND THIS FILE NOW ASSERTS THE FIX. Until M10 the assertions below pinned
 * the DEFECT: they demanded that parsing each live document throw `watcher_checkpoint_invalid:
 * shape`, and the docstring said so plainly — "NOT FIXED HERE … so the fix has something to turn
 * green." The parser now reads the legacy shape as generation 0, which is the same value it
 * already assigned to an ABSENT document, so those two assertions are inverted here. Nothing else
 * in this file moved: the recorded field sets are still the verbatim production documents, and
 * the refusal cases live in `parse-checkpoint-legacy-shape.test.ts`.
 *
 * Found by execution, not by reading: the first real attempt to create an agent
 * wallet on production returned `503 canonical_agent_wallet_registration_failed`,
 * and the relay log said `watcher_checkpoint_invalid:shape`.
 *
 * `parseCheckpoint` demands EXACTLY four keys. Both live checkpoint documents
 * carry three — `membership_generation` is absent, because they were last
 * written by a build that predates it. Read back from production on
 * 2026-07-27 and reproduced verbatim below.
 *
 * Blast radius, all three from the one document shape:
 * - every `POST /v1/agent/wallet/create` → 503 (the agent onboarding path)
 * - the inbound USDC watcher (`genesis_inbound_checkpoints/8453`)
 * - the outbound USDC watcher (`activity_outbound_checkpoints/8453`),
 * erroring on every 30-minute scan since 2026-07-26T21:00:02Z
 *
 * NOT FIXED HERE. The remedy is a one-field migration of live money-path state
 * (the watcher admission fence), which is the operator’s to authorize — see the M9
 * decision record. This file makes the failure executable so it cannot be
 * rediscovered by a 503, and so the fix has something to turn green.
 */

import {
  parseWatcherCheckpointDocument,
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
} from './watcher-address-admission';

const BASE_CHAIN_ID = 8453;

/**
 * The EXACT field sets read back from production Firestore on 2026-07-27.
 * Declared as the live shape, not as a shape the test invented: the key sets
 * are what the documents actually carry.
 */
const LIVE_PRODUCTION_CHECKPOINTS = [
  {
    collection: INBOUND_WATCHER_CHECKPOINT_COLLECTION, // 'genesis_inbound_checkpoints'
    doc: '8453',
    fields: {
      chain_id: 8453,
      last_processed_block: 49154223,
      updated_at: 1785097805205,
    } as Record<string, unknown>,
  },
  {
    collection: 'activity_outbound_checkpoints',
    doc: '8453',
    fields: {
      chain_id: 8453,
      last_processed_block: 48192123,
      updated_at: 1783173604330,
    } as Record<string, unknown>,
  },
];

describe('M9/M10 · the live watcher checkpoints, and the parser that now accepts them', () => {
  it('the population is the two real documents — not an empty sweep', () => {
    expect(LIVE_PRODUCTION_CHECKPOINTS).toHaveLength(2);
    for (const cp of LIVE_PRODUCTION_CHECKPOINTS) {
      expect(Object.keys(cp.fields).sort()).toEqual(
        ['chain_id', 'last_processed_block', 'updated_at'],
      );
      expect(Object.keys(cp.fields)).not.toContain('membership_generation');
    }
  });

  it.each(LIVE_PRODUCTION_CHECKPOINTS.map((c) => [`${c.collection}/${c.doc}`, c.fields] as const))(
    '%s — parsing the live document now SUCCEEDS at generation 0 (M10; previously threw :shape)',
    (_label, fields) => {
      expect(parseWatcherCheckpointDocument(fields, BASE_CHAIN_ID)).toEqual({
        lastProcessedBlock: fields.last_processed_block,
        membershipGeneration: 0,
        updatedAtMs: fields.updated_at,
      });
    },
  );

  it('the canonical 4-key document parses identically — widening changed nothing for it', () => {
    for (const cp of LIVE_PRODUCTION_CHECKPOINTS) {
      const repaired = { ...cp.fields, membership_generation: 0 };
      expect(parseWatcherCheckpointDocument(repaired, BASE_CHAIN_ID)).toEqual({
        lastProcessedBlock: cp.fields.last_processed_block,
        membershipGeneration: 0,
        updatedAtMs: cp.fields.updated_at,
      });
    }
  });

  it('a MISSING document is admitted at generation 0 — so 0 is the parser\'s own base', () => {
    // This is why the repair value is not an economic choice: `undefined` is
    // exactly the state a fresh chain is in, and the parser answers 0 for it.
    expect(parseWatcherCheckpointDocument(undefined, BASE_CHAIN_ID)).toEqual({
      lastProcessedBlock: null,
      membershipGeneration: 0,
      updatedAtMs: 0,
    });
  });

  it('RED — an EXTRA key is refused too, so the guard is strict in both directions', () => {
    const withExtra = {
      chain_id: 8453,
      last_processed_block: 49154223,
      updated_at: 1785097805205,
      membership_generation: 0,
      generation_fenced_at_registration: 0,
    };
    expect(() => parseWatcherCheckpointDocument(withExtra, BASE_CHAIN_ID))
      .toThrow('watcher_checkpoint_invalid:shape');
  });
});
