/**
 * Intra-day anchor SEGMENTS (: a PE sealed today must be presentable today).
 *
 * A segment anchors the open day's accepted-but-unanchored batches under `<day>:<n>`; each proof
 * carries `segment: n`; the verifier derives the on-chain batch id from (day, segment). RED controls:
 * the same proof without its segment resolves to the DAY id and is NOT anchored; a non-positive
 * segment never names an anchor.
 */
import { meterAnchorBatchId } from './meter-anchor';
import { meterAnchorBatchIdPreimage } from './meter-constants';
import { parseMeterFactInclusion, proveMeterFactInclusion } from './meter-fact-proof';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import {
  actLeafOf, actRecordOf, batchLeafOf, merkleRootOf, peHashOf, PE_V2_SCHEMA, METER_GENESIS_PREV_HASH, type PeV2,
} from './meter-wire';

const DAY = '2026-10-10';
// Cross-package pins (the SDK's `pe-export-wire.test.ts` carries the same three): keccak(0xff ‖ preimage).
const DAY_ID = '0x7c86b962ca245134a69fe2f6849dc83a5913dd0a79447d4c64a821cfc68a8e04';
const SEG1_ID = '0xbd232966c285fc66c749c2fa33a2317608311115a5e060a5837f7910426782ce';
const SEG2_ID = '0xb5be385fbf9d16e58e1a9c13c2441f368cbf8ebd6ed9b8f0b0684eaf5f2fcac5';

describe('anchor segment batch ids', () => {
  it('GREEN: the day id is unchanged and each segment has its own id', () => {
    expect(meterAnchorBatchIdPreimage(DAY)).toBe('provian:daily-pe-anchor:v1:meter:2026-10-10');
    expect(meterAnchorBatchIdPreimage(DAY, 1)).toBe('provian:daily-pe-anchor:v1:meter:2026-10-10:1');
    expect(meterAnchorBatchId(DAY)).toBe(DAY_ID);
    expect(meterAnchorBatchId(DAY, 1)).toBe(SEG1_ID);
    expect(meterAnchorBatchId(DAY, 2)).toBe(SEG2_ID);
    expect(new Set([DAY_ID, SEG1_ID, SEG2_ID]).size).toBe(3);
  });
  it('RED: 0, a negative or a fractional segment never names an anchor', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => meterAnchorBatchId(DAY, bad)).toThrow('invalid_anchor_segment');
  });
});

function onePe(): PeV2 {
  return {
    schema: PE_V2_SCHEMA, pe_id: 'pe_seg_1', device_id: 'dev_seg', prev_hash: METER_GENESIS_PREV_HASH, timestamp: 1791606000000,
    action_type: 'coding_session', metadata: { commit_sha: 'a'.repeat(40) },
  } as unknown as PeV2;
}

describe('a segment proof verifies against the segment id, never the day id', () => {
  const pe = onePe();
  const peHash = peHashOf(pe);
  const actLeaf = actLeafOf(actRecordOf(pe));
  const actsRoot = merkleRootOf([actLeaf]);
  const batch = { device_id: 'dev_seg', actor_id: 'actor_seg', seq: 1, batch_hash: 'b'.repeat(64) };
  const batchLeaf = batchLeafOf({ ...batch, acts_root: actsRoot });
  const anchoredLeaf = hashEnvelopeHashLeaf(batchLeaf);
  const inclusion = (segment?: number) => ({
    act_index: 0, act_proof: [], acts_root: actsRoot, batch,
    anchor: { day: DAY, proof: [], ...(segment !== undefined ? { segment } : {}) },
  });
  /** A chain that anchored ONLY segment 1 of the day (one-leaf tree: root == leaf). */
  const contract = {
    calls: [] as string[],
    async verifyPE(batchId: string, leaf: string, proof: string[]): Promise<boolean> {
      contract.calls.push(batchId);
      return batchId.toLowerCase() === SEG1_ID && leaf.toLowerCase() === anchoredLeaf.toLowerCase() && proof.length === 0;
    },
  };
  const claim = { pe_id: pe.pe_id, envelope_hash: peHash };

  it('parses a positive segment and refuses 0 / a string', () => {
    expect(parseMeterFactInclusion(inclusion(1))?.anchor.segment).toBe(1);
    expect(parseMeterFactInclusion(inclusion())?.anchor.segment).toBeUndefined();
    expect(parseMeterFactInclusion(inclusion(0))).toBeNull();
    expect(parseMeterFactInclusion({ ...inclusion(), anchor: { day: DAY, proof: [], segment: '1' } })).toBeNull();
  });
  it('GREEN: the proof carrying segment 1 is proven, against the segment id', async () => {
    contract.calls.length = 0;
    const r = await proveMeterFactInclusion({ pe, inclusion: inclusion(1), claim, anchorContract: contract });
    expect(r.status).toBe('proven');
    expect(contract.calls).toEqual([SEG1_ID]);
    if (r.status === 'proven') expect(r.proof.anchor).toMatchObject({ batch_id: SEG1_ID, day: DAY, segment: 1 });
  });
  it('RED: the same proof without its segment asks the chain for the DAY id and is not anchored', async () => {
    contract.calls.length = 0;
    const r = await proveMeterFactInclusion({ pe, inclusion: inclusion(), claim, anchorContract: contract });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.reason).toBe('pe_not_anchored');
    expect(contract.calls).toEqual([DAY_ID]);
  });
  it('RED: a wrong segment number is not anchored either', async () => {
    const r = await proveMeterFactInclusion({ pe, inclusion: inclusion(2), claim, anchorContract: contract });
    expect(r.status).toBe('refused');
  });
});
