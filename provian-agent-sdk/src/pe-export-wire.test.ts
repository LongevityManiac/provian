import { describe, expect, it } from 'vitest';
import { encodePacked, keccak256, toBytes, toHex, concat } from 'viem';
import {
  actRecordOf,
  batchHashOf,
  batchLeafOf,
  buildBatch,
  canonicalJson,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  type PeV2,
} from './meter-wire';
import {
  anchoredLeafOf,
  chainOrderOf,
  decodeGetBatch,
  foldAnchorProof,
  getBatchCalldata,
  inclusionFromBatch,
  meterAnchorBatchIdOf,
  parseExport,
  preMeterRecipeOf,
  PE_EXPORT_ANCHOR_RULES,
  PE_EXPORT_PE_ANCHOR,
  PE_EXPORT_SCHEMA,
  PE_EXPORT_SPEC_URL,
  recordHashOf,
  serializeExport,
  verifyAnchorsOnChain,
  verifyExportOffline,
  type ExportBatchAnchor,
  type ExportBodyLine,
  type ExportHeader,
  type PeV2WithHash,
} from './pe-export-wire';

// ── A REAL anchored batch (Atlas's first meter batch, 2026-10-04; root written on Base in
// tx 0x99b5d3cd…, block 52,185,279). Pins every keccak convention to production, not to this file.
const REAL = {
  device_id: 'dev_79f7e482c6aeda901749e593afa69ff035d1e248c35c934d6a5615e168c22b08',
  actor_id: 'atlas',
  seq: 1,
  batch_hash: 'd3eca260f3c1330dcc50d002083d61e571fac06e17afd1bbbc275b33f712ba66',
  acts_root: '14fcfe14693572c5575dd3f08a129c427c267976f1d26058008c4602dd2fe497',
  batch_leaf: 'f95ac0282e9fcccc43de2ea8024b9e074873e3a6e8cd34b81dd4a8065909b912',
  anchor: {
    day: '2026-10-04',
    anchor_batch_id: '0x1f956c38bd91d125734d2e7566903436eaa5b5b6420d6b6060b692c9d01fd279',
    leaf_hash: '0xdd5a3beae91c41e5b83c91850fd9bdc086de06bbdbfb37dbd98e7d5c4e48c934',
    proof: [
      '0x1779288ef025e360334ae4dfa1d87844472d275df3a3c4972a4f9a8ffa45a5ff',
      '0x8bb55a0f9030bf79509f02565631aca122c364c77ac0fc0d9a4583d1bafd11e5',
      '0x7d9bcd8ef1ca27e7dd5b6044a961bb7ab15c5d5197eb01363910ec0515967479',
      '0x09f9ec1dd5e16d85722e90f7a6910bd717da3d8baaa8590e124b0b346cf9dbf3',
      '0x06ce143e00339851ed3ca50f7652bd87633a3cece931562e86d49656a6c72472',
      '0xd66ddc416f891f4a9d93115686064f4a918d13b2777c9e1fa53e465c90c6f189',
      '0x1223afe2bf6a0bdcc507f8dd791af8690a27a6a8a0b0f2594fb1da0a5c2ee9b9',
    ],
    merkle_root: '0x1b8ac5effbd6b95793f3c7018345f2465c714d1d11354811e953e71f63657292',
  },
};

describe('pe export wire — conventions pinned to a real anchored batch', () => {
  it('rebuilds the batch leaf, the on-chain leaf, the day root and the day batch id', () => {
    expect(batchLeafOf(REAL)).toBe(REAL.batch_leaf);
    expect(anchoredLeafOf(REAL.batch_leaf)).toBe(REAL.anchor.leaf_hash);
    expect(foldAnchorProof(REAL.anchor.leaf_hash, REAL.anchor.proof)).toBe(REAL.anchor.merkle_root);
    expect(meterAnchorBatchIdOf(REAL.anchor.day)).toBe(REAL.anchor.anchor_batch_id);
  });

  it('agrees with an independent keccak implementation (viem)', () => {
    expect(anchoredLeafOf(REAL.batch_leaf)).toBe(keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', `0x${REAL.batch_leaf}`])));
    expect(meterAnchorBatchIdOf('2026-10-04')).toBe(keccak256(concat(['0xff', toHex('provian:daily-pe-anchor:v1:meter:2026-10-04')])));
    expect(getBatchCalldata(REAL.anchor.anchor_batch_id).slice(0, 10)).toBe(keccak256(toBytes('getBatch(bytes32)')).slice(0, 10));
  });

  it('NEGATIVE CONTROL: one flipped sibling or a different day does not reproduce the root / id', () => {
    const bad = [...REAL.anchor.proof];
    bad[3] = bad[3].replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect(foldAnchorProof(REAL.anchor.leaf_hash, bad)).not.toBe(REAL.anchor.merkle_root);
    expect(meterAnchorBatchIdOf('2026-10-05')).not.toBe(REAL.anchor.anchor_batch_id);
  });
});

// ── A synthetic owner: one device chain of 4 PEs in two batches, both anchored in one day tree.

function chainOf(deviceId: string, n: number, withDetail: boolean): { pe: PeV2WithHash; detail?: Record<string, unknown> }[] {
  const out: { pe: PeV2WithHash; detail?: Record<string, unknown> }[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const detail = withDetail ? { envelope_id: `pe_${deviceId}_${i}`, amount: String(i * 10), intent_text: `act ${i}`, signature: 'sig' } : undefined;
    const draft: PeV2 = {
      schema: PE_V2_SCHEMA,
      pe_id: `pe_${deviceId}_${i}`,
      device_id: deviceId,
      prev_hash: prev,
      timestamp: 1_791_100_000_000 + i,
      action_type: 'coding_session',
      description: `act ${i}`,
      ...(detail ? { detail_hash: recordHashOf(detail) } : {}),
    };
    const pe = { ...draft, pe_hash: peHashOf(draft), signature: 'p256sig' } as PeV2WithHash;
    out.push({ pe, ...(detail ? { detail } : {}) });
    prev = pe.pe_hash;
  }
  return out;
}

/** Build a day tree over batch leaves the way the relay does (keccak, 0x00 leaves, 0x01 sorted pairs, zero-padded). */
function dayTree(batchLeaves: string[]): { root: string; proofs: string[][] } {
  let layer = batchLeaves.map((l) => anchoredLeafOf(l));
  let size = 1;
  while (size < layer.length) size *= 2;
  while (layer.length < size) layer.push(keccak256('0x'));
  const layers = [layer];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const [a, b] = layer[i] <= layer[i + 1] ? [layer[i], layer[i + 1]] : [layer[i + 1], layer[i]];
      next.push(keccak256(encodePacked(['bytes1', 'bytes32', 'bytes32'], ['0x01', a as `0x${string}`, b as `0x${string}`])));
    }
    layers.push(next);
    layer = next;
  }
  const proofs = batchLeaves.map((_, idx) => {
    const p: string[] = [];
    let i = idx;
    for (let lv = 0; lv < layers.length - 1; lv++) {
      p.push(layers[lv][i % 2 === 0 ? i + 1 : i - 1]);
      i = Math.floor(i / 2);
    }
    return p;
  });
  return { root: layer[0], proofs };
}

function fixture() {
  const dev = 'dev_test_export';
  const chain = chainOf(dev, 4, true);
  const DAY = '2026-10-04';
  const groups = [[0, 2], [2, 2]];
  const batches = groups.map(([first, count], k) => {
    const b = buildBatch({
      device_id: dev,
      seq: k + 1,
      prev_batch_hash: METER_GENESIS_PREV_HASH,
      created_at_ms: 1_791_100_000_100 + k,
      pes: chain.slice(first, first + count).map((c) => c.pe),
    });
    const batch_hash = batchHashOf(b);
    const batch_leaf = batchLeafOf({ device_id: dev, actor_id: 'actor_x', seq: k + 1, batch_hash, acts_root: b.acts_root });
    return { first, count, seq: k + 1, batch_hash, acts_root: b.acts_root, batch_leaf };
  });
  // A relay-authored one-act batch sealed to the owner (received).
  const relayChain = chainOf('relay:owner', 1, false);
  const rb = buildBatch({ device_id: 'relay:owner', seq: 1, prev_batch_hash: METER_GENESIS_PREV_HASH, created_at_ms: 1, pes: [relayChain[0].pe] });
  const rHash = batchHashOf(rb);
  const rLeaf = batchLeafOf({ device_id: 'relay:owner', actor_id: 'actor_x', seq: 1, batch_hash: rHash, acts_root: rb.acts_root });
  const tree = dayTree([...batches.map((b) => b.batch_leaf), rLeaf, 'aa'.repeat(32)]);
  const anchorOf = (i: number): ExportBatchAnchor => ({
    day: DAY,
    anchor_batch_id: meterAnchorBatchIdOf(DAY),
    leaf_index: i,
    leaf_count: 4,
    leaf_hash: anchoredLeafOf(i < 2 ? batches[i].batch_leaf : rLeaf),
    proof: tree.proofs[i],
    merkle_root: tree.root,
    tx_hash: '0x' + '11'.repeat(32),
  });
  const header: ExportHeader = {
    type: 'header',
    schema: PE_EXPORT_SCHEMA,
    spec: PE_EXPORT_SPEC_URL,
    exported_at_ms: 1_791_200_000_000,
    producer: { kind: 'sdk', version: 'test' },
    owner: { kind: 'agent', wallet_id: 'wallet_aw_test', address: null },
    anchor: PE_EXPORT_ANCHOR_RULES,
    devices: [dev],
    archive: { state: 'off', days: [] },
  };
  const body: ExportBodyLine[] = [];
  chain.forEach((c, index) => {
    const bi = index < 2 ? 0 : 1;
    const b = batches[bi];
    const built = inclusionFromBatch({
      pes: chain.slice(b.first, b.first + b.count).map((x) => x.pe), at: index - b.first,
      device_id: dev, actor_id: 'actor_x', seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root, anchor: anchorOf(bi),
    });
    if (!built.ok) throw new Error('fixture');
    body.push({ type: 'pe', source: 'device', device_id: dev, index, pe: c.pe, ...(c.detail ? { detail: c.detail } : {}), status: 'anchored', inclusion: built.inclusion });
  });
  batches.forEach((b, k) => {
    body.push({
      type: 'batch', device_id: dev, seq: b.seq, batch_hash: b.batch_hash, prev_batch_hash: k === 0 ? METER_GENESIS_PREV_HASH : batches[k - 1].batch_hash,
      acts_root: b.acts_root, actor_id: 'actor_x', first_index: b.first, count: b.count, last_pe_hash: chain[b.first + b.count - 1].pe.pe_hash,
      created_at_ms: 1, accepted_at_ms: 2, adopted: false, batch_leaf: b.batch_leaf,
      receipt: { acts: chain.slice(b.first, b.first + b.count).map((c) => ({ pe_id: c.pe.pe_id, pe_hash: c.pe.pe_hash })) },
      anchor: anchorOf(k),
    });
  });
  const rIncl = inclusionFromBatch({
    pes: [relayChain[0].pe], at: 0, device_id: 'relay:owner', actor_id: 'actor_x', seq: 1, batch_hash: rHash, acts_root: rb.acts_root, anchor: anchorOf(2),
  });
  if (!rIncl.ok) throw new Error('fixture');
  body.push({
    type: 'received', source: 'device', mailbox_id: 'mp_1.0', from_actor: 'actor_x', from_device: 'relay:owner', batch_hash: rHash,
    received_at_ms: 3, pe: relayChain[0].pe, status: 'anchored', inclusion: rIncl.inclusion,
  });
  const legacyRecord = { envelope_id: 'env_old', action_type: 'send', prev_envelope_hash: 'x', signature: 's' };
  body.push({ type: 'legacy', source: 'device_history', id: 'env_old', hash: recordHashOf(legacyRecord), record: legacyRecord, status: 'pre_meter' });
  return { header, body, root: tree.root, dayId: meterAnchorBatchIdOf(DAY) };
}

function rpcReturning(root: string, exists = true) {
  const calls: { to: string; data: string }[] = [];
  const ethCall = async (to: string, data: string): Promise<string> => {
    calls.push({ to, data });
    return '0x' + root.slice(2) + '0'.repeat(63) + '4' + '0'.repeat(64) + '0'.repeat(64) + '0'.repeat(63) + (exists ? '1' : '0');
  };
  return { ethCall, calls };
}

describe('pe export wire — a complete export verifies, and every tamper is caught', () => {
  it('round-trips and verifies to the day root, then on chain', async () => {
    const f = fixture();
    const text = serializeExport(f.header, f.body, []);
    const parsed = parseExport(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = verifyExportOffline(parsed.body);
    expect(report.failures).toEqual([]);
    expect(report.gaps).toEqual([]);
    // Not an empty population: every kind of line was evaluated.
    expect(report.counts.pe).toEqual({ total: 4, proven_to_root: 4, pending: 0 });
    expect(report.counts.batch.proven_to_root).toBe(2);
    expect(report.counts.received.proven_to_root).toBe(1);
    expect(report.counts.legacy).toEqual({ total: 1, hash_checked: 1, hash_unverifiable: 0, unanchorable: 1 });
    expect(report.anchors).toHaveLength(1);
    expect(report.anchors[0].lines).toBe(7);
    const rpc = rpcReturning(f.root);
    const checks = await verifyAnchorsOnChain(report.anchors, rpc.ethCall);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(rpc.calls).toEqual([{ to: PE_EXPORT_PE_ANCHOR, data: getBatchCalldata(f.dayId) }]);
  });

  const tamper = (mut: (body: ExportBodyLine[]) => void): ReturnType<typeof verifyExportOffline> => {
    const f = fixture();
    mut(f.body);
    const parsed = parseExport(serializeExport(f.header, f.body, []));
    if (!parsed.ok) throw new Error(parsed.error);
    return verifyExportOffline(parsed.body);
  };
  const reasons = (r: ReturnType<typeof verifyExportOffline>): string[] => r.failures.map((x) => x.reason);

  it('NEGATIVE CONTROL: an edited PE fails its own hash', () => {
    expect(reasons(tamper((b) => {
      const l = b[1] as Extract<ExportBodyLine, { type: 'pe' }>;
      b[1] = { ...l, pe: { ...l.pe, description: 'edited' } };
    }))).toContain('pe_hash_mismatch');
  });

  it('NEGATIVE CONTROL: an edited private detail fails its commitment', () => {
    expect(reasons(tamper((b) => {
      const l = b[0] as Extract<ExportBodyLine, { type: 'pe' }>;
      b[0] = { ...l, detail: { ...l.detail, amount: '999' } };
    }))).toContain('detail_hash_mismatch');
  });

  it('NEGATIVE CONTROL: a PE swapped for another of the same batch fails the act path', () => {
    expect(reasons(tamper((b) => {
      const l0 = b[0] as Extract<ExportBodyLine, { type: 'pe' }>;
      const l1 = b[1] as Extract<ExportBodyLine, { type: 'pe' }>;
      b[0] = { ...l0, inclusion: l1.inclusion };
    }))).toContain('act_not_in_batch');
  });

  it('NEGATIVE CONTROL: a forged anchor proof, day, or contract is refused', () => {
    expect(reasons(tamper((b) => {
      const l = b[2] as Extract<ExportBodyLine, { type: 'pe' }>;
      const a = l.inclusion!.anchor!;
      b[2] = { ...l, inclusion: { ...l.inclusion!, anchor: { ...a, proof: [...a.proof.slice(1), a.proof[0]] } } };
    }))).toContain('anchor_proof_mismatch');
    expect(reasons(tamper((b) => {
      const l = b[2] as Extract<ExportBodyLine, { type: 'pe' }>;
      b[2] = { ...l, inclusion: { ...l.inclusion!, anchor: { ...l.inclusion!.anchor!, day: '2026-10-05' } } };
    }))).toContain('anchor_batch_id_mismatch');
    expect(reasons(tamper((b) => {
      const l = b[2] as Extract<ExportBodyLine, { type: 'pe' }>;
      b[2] = { ...l, inclusion: { ...l.inclusion!, anchor: { ...l.inclusion!.anchor!, contract: '0x' + '22'.repeat(20) } } };
    }))).toContain('anchor_contract_untrusted');
  });

  it('NEGATIVE CONTROL: a missing PE is reported as a chain gap', () => {
    const r = tamper((b) => {
      b.splice(1, 1);
    });
    expect(r.gaps).toEqual([{ device_id: 'dev_test_export', from: 1, before: 2 }]);
    expect(reasons(r)).toEqual([]); // the gap is reported as a gap; every PE that IS here still verifies
  });

  it('NEGATIVE CONTROL: a batch whose receipt names other PEs is refused', () => {
    expect(reasons(tamper((b) => {
      const l = b[4] as Extract<ExportBodyLine, { type: 'batch' }>;
      b[4] = { ...l, receipt: { acts: [{ pe_hash: 'ab'.repeat(32) }, { pe_hash: 'cd'.repeat(32) }] } };
    }))).toContain('receipt_does_not_match_pes');
  });

  it('NEGATIVE CONTROL: an edited legacy record fails its hash', () => {
    expect(reasons(tamper((b) => {
      const l = b[7] as Extract<ExportBodyLine, { type: 'legacy' }>;
      b[7] = { ...l, record: { ...l.record, action_type: 'receive' } };
    }))).toContain('record_hash_mismatch');
  });

  it('NEGATIVE CONTROL: an edited, re-ordered or truncated file fails parsing', () => {
    const f = fixture();
    const text = serializeExport(f.header, f.body, []);
    const lines = text.trimEnd().split('\n');
    const edited = [...lines];
    edited[2] = edited[2].replace('coding_session', 'coding_sessioX');
    expect(parseExport(edited.join('\n'))).toMatchObject({ ok: false, error: 'chain_mismatch' });
    expect(parseExport(lines.slice(0, -1).join('\n'))).toMatchObject({ ok: false, error: 'no_end' });
    expect(parseExport(lines.slice(0, -2).concat(lines.slice(-1)).join('\n'))).toMatchObject({ ok: false, error: 'end_count_mismatch' });
    const nonCanonical = [...lines];
    nonCanonical[1] = JSON.stringify(JSON.parse(lines[1]), null, 1).replace(/\n/g, '');
    expect(parseExport(nonCanonical.join('\n'))).toMatchObject({ ok: false, error: 'line_not_canonical' });
  });

  it('NEGATIVE CONTROL: a root Base does not hold is refused on chain', async () => {
    const f = fixture();
    const report = verifyExportOffline(f.body);
    const other = await verifyAnchorsOnChain(report.anchors, rpcReturning('0x' + '33'.repeat(32)).ethCall);
    expect(other[0]).toMatchObject({ ok: false, reason: 'onchain_root_differs' });
    const missing = await verifyAnchorsOnChain(report.anchors, rpcReturning(f.root, false).ethCall);
    expect(missing[0]).toMatchObject({ ok: false, reason: 'day_not_anchored_on_chain' });
    const failing = await verifyAnchorsOnChain(report.anchors, async () => {
      throw new Error('down');
    });
    expect(failing[0]).toMatchObject({ ok: false, reason: 'rpc_error:down' });
  });

  it('a pending (not yet anchored) PE is reported pending, never as verified', () => {
    const r = tamper((b) => {
      const l = b[3] as Extract<ExportBodyLine, { type: 'pe' }>;
      const { anchor: _a, ...hop1 } = l.inclusion!;
      void _a;
      b[3] = { ...l, status: 'not_anchored_yet', inclusion: hop1 };
    });
    expect(r.failures).toEqual([]);
    expect(r.counts.pe).toEqual({ total: 4, proven_to_root: 3, pending: 1 });
    expect(r.pending[0]).toMatchObject({ status: 'not_anchored_yet' });
  });
});

describe('pe export wire — helpers', () => {
  it('chainOrderOf orders a recipient\'s copies by their links, and refuses a broken run', () => {
    const c = chainOf('d', 3, false).map((x) => ({ pe: x.pe }));
    expect(chainOrderOf([c[2], c[0], c[1]])?.map((x) => x.pe.pe_id)).toEqual(c.map((x) => x.pe.pe_id));
    expect(chainOrderOf([c[0], c[2]])).toBeNull();
  });

  it('decodeGetBatch reads the 5-word return; a short result is refused', () => {
    expect(decodeGetBatch('0x' + '00'.repeat(64))).toBeNull();
    const d = decodeGetBatch('0x' + 'ab'.repeat(32) + '0'.repeat(62) + '72' + '0'.repeat(64) + '0'.repeat(64) + '0'.repeat(63) + '1');
    expect(d).toMatchObject({ merkle_root: '0x' + 'ab'.repeat(32), pe_count: '114', exists: true });
  });

  it('the act record a verifier rebuilds is the one the relay priced', () => {
    const [x] = chainOf('d', 1, false);
    expect(canonicalJson(actRecordOf(x.pe))).toContain('"pe_hash"');
  });
});

// ─── pre-meter records handed back by the relay ──────────────────────────────────

/**
 * Two REAL pre-meter records of Atlas's, verbatim from the relay's hand-back (as its export carries
 * them): a device-submitted PE and the agent's first PE (written by the canonical agent chain, whose
 * stored doc names no integration_source). Their python3=/opt/homebrew/bin/python3 values were written by the retired relay; the
 * recipes must reproduce them — the hash is never recomputed here.
 */
const ATLAS_DEVICE_PE: Record<string, unknown> = {"action_type": "agent_tool_orchestration", "actor_address": "0xb9bd30d6a975801a489cf99108ae856ec9867c85", "attestation_type": "software", "cited_pe_ids": null, "compute": {"cpu_seconds": null, "duration_ms": 1672, "energy_joules": null, "framework": "openai", "gpu_seconds": null, "hardware_class": null, "memory_peak_mb": null, "model_parameters": null, "output_cardinality": null, "records_processed": null, "tokens_processed": 94433}, "counterparty_address": null, "counterparty_type": null, "created_at": 1789932744350, "description": "openai grok-4.6 turn — 1 tool call(s)", "durability": "final", "execution_env": {"container": null, "environment_class": "bare_metal", "os": "darwin", "os_version": "25.5.0", "runtime": "node", "runtime_version": "26.5.0", "tee_type": null, "tee_version": null}, "geo": null, "hash": "3f8a64c0637a80bbb4176bb10dfe43b474551a23185e4315284ca171d5ed8318", "id": "pe_0316b333-412f-4651-9b7a-31200670290a", "integration_source": "device_pe_submit", "intent_text": "openai grok-4.6 turn — 1 tool call(s)", "metadata": {"attribution_model": "device_owner", "model": "grok-4.6", "owner_type": "agent", "provider": "openai", "response_id": "5001080c-4981-9bb9-8858-48c0440ffac8", "source": "model_proxy", "source_device_id": "dev_79f7e482c6aeda901749e593afa69ff035d1e248c35c934d6a5615e168c22b08", "source_device_name": "Atlass-Mac-mini.local", "source_tool": "provian:model_proxy", "streamed": true, "success": true, "tool": "provian:model_proxy", "tool_count": 1, "tool_names": ["process"], "turn_id": "tc:d5f8820d3054b48d7493f03093432e173afc5d61c0c2baf0ad1c3995ac8df229"}, "output_digests": [{"hash": "sha256:c4b19a7955c25c0f7a9cfa7adc6e665968e550bec09b6c1be8eadbd6c69e5436", "kind": "response"}], "parent_goal_pe_id": null, "policy_action_type": "agent_tool_orchestration", "prev_hash": "c4898bbd155657412635a1ca98107f8ba3fafa10ecc93e02ea4755df9b43e2d1", "self_referencing": false, "session_lineage": null, "timestamp": 1789932744350, "trust_level_at_creation": null, "user_id": "atlas", "wallet_id": "wallet_aw_6c5e74b0-5202-414a-96d6-818d0a126ac5", "witness_class": "device_tier", "witnessed_at_ms": 1789932744226};
const ATLAS_FIRST_PE: Record<string, unknown> = {"action_type": "agent_wallet_created", "actor_address": "0x314542408614eb72b9a7078ff32e38e59f97c488", "agent_id": "atlas", "attestation_type": "software", "counterparty_address": null, "counterparty_type": null, "created_at": 1775791572976, "hash": "328be491dd771fd6e7bab542615a73811e7451603b12d19f173c430f2cadb93d", "id": "pe_5ad8e6df-f678-48b0-b840-2ae6eaa630c8", "metadata": {"badges": ["genesis_agent"], "chains": ["base"], "governance_score": 0, "platform": "openclaw", "public_key": "f172e12d9df760651cae38ae17af9bedf615d1772cb7bb1f85ccbc1af9d5b09aae0a6dd55985bcb2f1223cdc909da2158aff2b33cb6e3807f565beed0bf9a9ec", "wallet_type": "agent_self_signup"}, "prev_hash": "genesis", "self_referencing": false, "session_lineage": null, "timestamp": 1775791572976, "trust_level_at_creation": null, "user_id": "atlas", "wallet_id": "wallet_aw_293053ab-b8cf-44f2-87ca-c224dc34786d"};

describe('pre-meter records: each handed-back record is checked against the recipe of its writer', () => {
  it('reproduces the relay-written hash of both real records', () => {
    expect(preMeterRecipeOf(ATLAS_DEVICE_PE)).toBe('device_pe_submit');
    expect(preMeterRecipeOf(ATLAS_FIRST_PE)).toBe('agent_bank_generate_pe');
  });

  it('a storage field (never hashed) does not change the check', () => {
    expect(preMeterRecipeOf({ ...ATLAS_DEVICE_PE, user_id: 'someone_else', durability: 'provisional' })).toBe('device_pe_submit');
  });

  it('RED: a hashed field changed makes the record unverifiable', () => {
    expect(preMeterRecipeOf({ ...ATLAS_DEVICE_PE, description: 'edited' })).toBeNull();
    expect(preMeterRecipeOf({ ...ATLAS_FIRST_PE, metadata: { ...(ATLAS_FIRST_PE.metadata as object), platform: 'other' } })).toBeNull();
    expect(preMeterRecipeOf({ ...ATLAS_FIRST_PE, hash: 'f'.repeat(64) })).toBeNull();
  });

  it('the verifier counts recomputed records as hash_checked and the rest as hash_unverifiable — never a pass on the hash field alone', () => {
    const tampered: Record<string, unknown> = { ...ATLAS_DEVICE_PE, description: 'edited' };
    const lines: ExportBodyLine[] = [ATLAS_DEVICE_PE, ATLAS_FIRST_PE, tampered].map((record, i) => ({
      type: 'legacy', source: 'handed_back', id: `legacy_${i}`, hash: record.hash as string, record, status: 'pre_meter',
    }));
    const report = verifyExportOffline(lines);
    expect(report.counts.legacy).toEqual({ total: 3, hash_checked: 2, hash_unverifiable: 1, unanchorable: 3 });
    expect(report.failures).toEqual([]);
    // A line whose hash disagrees with its record's own hash field is a failure.
    const lying = verifyExportOffline([{ ...(lines[0] as Extract<ExportBodyLine, { type: 'legacy' }>), hash: 'e'.repeat(64) }]);
    expect(lying.failures.map((f) => f.reason)).toEqual(['record_hash_mismatch']);
  });
});

describe('anchor SEGMENTS (2026-10-10): `<day>:<n>` has its own batch id; the day id is unchanged', () => {
  // Cross-package pins (the relay's `meter-anchor-segment.test.ts` carries the same three).
  it('GREEN: pinned ids for the day, segment 1 and segment 2', () => {
    expect(meterAnchorBatchIdOf('2026-10-10')).toBe('0x7c86b962ca245134a69fe2f6849dc83a5913dd0a79447d4c64a821cfc68a8e04');
    expect(meterAnchorBatchIdOf('2026-10-10', 1)).toBe('0xbd232966c285fc66c749c2fa33a2317608311115a5e060a5837f7910426782ce');
    expect(meterAnchorBatchIdOf('2026-10-10', 2)).toBe('0xb5be385fbf9d16e58e1a9c13c2441f368cbf8ebd6ed9b8f0b0684eaf5f2fcac5');
  });
  it('RED: 0, a negative or a fractional segment never names an anchor', () => {
    for (const bad of [0, -3, 2.5]) expect(() => meterAnchorBatchIdOf('2026-10-10', bad)).toThrow('invalid_anchor_segment');
  });
});
