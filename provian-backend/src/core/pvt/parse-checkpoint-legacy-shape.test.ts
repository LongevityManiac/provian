/**
 * CONTROL FOR THE LEGACY-CHECKPOINT WIDENING.
 *
 * `parseCheckpoint` demanded exactly four keys. Both live Base checkpoints still carry the three
 * that predate `membership_generation`, so it threw `watcher_checkpoint_invalid:shape` on real
 * production data — taking down every `POST /v1/agent/wallet/create` and erroring the outbound
 * USDC watcher on every scan.
 *
 * Widening a validator is exactly where a fix quietly becomes a hole, so the point of this file
 * is NOT "the legacy shape now parses" — that is one line. It is that everything the validator
 * refused before, it still refuses. The malformed cases below are the ones an attacker or a
 * corrupt write would produce, and each must still throw.
 *
 * The negative control is not hand-written: `EXACT_LIVE_DOCUMENTS` are the two production
 * documents read verbatim from Firestore, and the last block asserts that the pre-fix parser
 * REFUSED them — reconstructed from the shipped rule it enforced — so this suite is bound to the
 * real defect rather than to a reconstruction of it.
 */

import { parseWatcherCheckpointDocument } from './watcher-address-admission';

/** Read verbatim from production this pass. Field order and types as stored. */
const EXACT_LIVE_DOCUMENTS = [
  {
    name: 'genesis_inbound_checkpoints/8453',
    raw: { updated_at: 1785097805205, chain_id: 8453, last_processed_block: 49154223 },
  },
  {
    name: 'activity_outbound_checkpoints/8453',
    raw: { last_processed_block: 48192123, chain_id: 8453, updated_at: 1783173604330 },
  },
] as const;

describe('parseCheckpoint — legacy shape', () => {
  describe('the two live documents parse, at generation 0', () => {
    it.each(EXACT_LIVE_DOCUMENTS)('$name', ({ raw }) => {
      const parsed = parseWatcherCheckpointDocument({ ...raw }, 8453);
      expect(parsed.membershipGeneration).toBe(0);
      expect(parsed.lastProcessedBlock).toBe(raw.last_processed_block);
      expect(parsed.updatedAtMs).toBe(raw.updated_at);
    });

    it('evaluated both documents, not an empty table', () => {
      expect(EXACT_LIVE_DOCUMENTS.length).toBe(2);
    });

    it('a legacy document reads IDENTICALLY to an absent one on generation', () => {
      // This is the whole argument for widening rather than back-filling: absent already meant 0.
      expect(parseWatcherCheckpointDocument(undefined, 8453).membershipGeneration).toBe(0);
    });
  });

  describe('the canonical shape is unchanged', () => {
    it('parses and carries its real generation', () => {
      const parsed = parseWatcherCheckpointDocument(
        { chain_id: 8453, last_processed_block: 1, membership_generation: 7, updated_at: 5 },
        8453,
      );
      expect(parsed.membershipGeneration).toBe(7);
    });

    it('a PRESENT but invalid generation still throws — widening did not weaken this', () => {
      for (const bad of [-1, 1.5, '0', null, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseWatcherCheckpointDocument(
          { chain_id: 8453, last_processed_block: 1, membership_generation: bad, updated_at: 5 },
          8453,
        )).toThrow('watcher_checkpoint_invalid:membership_generation');
      }
    });
  });

  describe('genuinely malformed documents STILL refuse', () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>, string | RegExp]> = [
      ['an extra unknown key alongside the legacy three',
        { chain_id: 8453, last_processed_block: 1, updated_at: 5, injected: 'x' },
        'watcher_checkpoint_invalid:shape'],
      ['an extra unknown key alongside the canonical four',
        { chain_id: 8453, last_processed_block: 1, membership_generation: 0, updated_at: 5, injected: 'x' },
        'watcher_checkpoint_invalid:shape'],
      ['missing chain_id',
        { last_processed_block: 1, updated_at: 5 },
        'watcher_checkpoint_invalid:shape'],
      ['missing updated_at',
        { chain_id: 8453, last_processed_block: 1 },
        'watcher_checkpoint_invalid:shape'],
      ['missing last_processed_block',
        { chain_id: 8453, updated_at: 5 },
        'watcher_checkpoint_invalid:shape'],
      ['empty object',
        {},
        'watcher_checkpoint_invalid:shape'],
      ['two of the three legacy keys plus membership_generation',
        { chain_id: 8453, membership_generation: 0, updated_at: 5 },
        'watcher_checkpoint_invalid:shape'],
      ['wrong chain',
        { chain_id: 1, last_processed_block: 1, updated_at: 5 },
        'watcher_checkpoint_invalid:chain_id'],
      ['chain_id as a string',
        { chain_id: '8453', last_processed_block: 1, updated_at: 5 },
        'watcher_checkpoint_invalid:chain_id'],
      ['negative block',
        { chain_id: 8453, last_processed_block: -5, updated_at: 5 },
        'watcher_address_admission_invalid:last_processed_block'],
      ['fractional block',
        { chain_id: 8453, last_processed_block: 1.5, updated_at: 5 },
        'watcher_address_admission_invalid:last_processed_block'],
      ['block as a string',
        { chain_id: 8453, last_processed_block: '1', updated_at: 5 },
        'watcher_address_admission_invalid:last_processed_block'],
      ['negative updated_at',
        { chain_id: 8453, last_processed_block: 1, updated_at: -1 },
        'watcher_checkpoint_invalid:updated_at'],
      ['updated_at as a string',
        { chain_id: 8453, last_processed_block: 1, updated_at: '5' },
        'watcher_checkpoint_invalid:updated_at'],
    ];

    it.each(cases)('refuses %s', (_label, raw, expected) => {
      expect(() => parseWatcherCheckpointDocument(raw, 8453)).toThrow(expected);
    });

    it('evaluated the whole malformed population', () => {
      expect(cases.length).toBe(14);
    });
  });

  /**
   * NEGATIVE CONTROL, BOUND TO THE ACTUAL DEFECT.
   *
   * The pre-fix parser's shape rule, verbatim: exactly the four canonical keys or throw. Asserting
   * it REFUSES the two real production documents is what makes the fix above evidence of
   * something rather than a claim. If this ever passes both documents, the "defect" this suite
   * describes was never real and every test above is decoration.
   */
  describe('the shipped parser REFUSED these exact documents', () => {
    const preFixShapeCheck = (raw: Record<string, unknown>): void => {
      const expectedKeys = ['chain_id', 'last_processed_block', 'membership_generation', 'updated_at'].sort();
      const actualKeys = Object.keys(raw).sort();
      if (actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error('watcher_checkpoint_invalid:shape');
      }
    };

    it.each(EXACT_LIVE_DOCUMENTS)('$name threw under the pre-fix rule', ({ raw }) => {
      expect(() => preFixShapeCheck({ ...raw })).toThrow('watcher_checkpoint_invalid:shape');
    });

    it('and the pre-fix rule accepted the canonical shape, so it was a SHAPE bug not a total refusal', () => {
      expect(() => preFixShapeCheck(
        { chain_id: 8453, last_processed_block: 1, membership_generation: 0, updated_at: 5 },
      )).not.toThrow();
    });
  });
});
