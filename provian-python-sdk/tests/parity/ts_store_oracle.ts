/**
 * Cross-language store oracle: the REAL TypeScript FsPeStore (the observer daemon's) opens a store
 * the Python SDK wrote, reads every PE, appends one PE of its own (built by the SDK's buildPeV2),
 * and reports what it saw. The Python suite then reads the TS-written PE back.
 *
 * stdin: {"root": "<store root>", "device_id": "<dev_…>"}
 * stdout: {"head_before": {count, last_pe_hash}, "pe_ids": [...], "appended": {pe_id, pe_hash, prev_hash}}
 *
 * Run from provian-backend (tsx lives there):
 *   npx tsx ../provian-python-sdk/tests/parity/ts_store_oracle.ts < input.json
 */
import { FsPeStore } from '../../../provian-agent-sdk/src/meter/pe-store';
import { buildPeV2, newPeId } from '../../../provian-agent-sdk/src/meter/pe-builder';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  void (async () => {
    const input = JSON.parse(raw) as { root: string; device_id: string };
    const store = new FsPeStore(input.device_id, input.root);
    const head = await store.head();
    const rows = await store.readPes(0, 1000);
    const pe = await buildPeV2({
      content: {
        action_type: 'compute_session',
        description: 'written by the TypeScript store',
        metadata: { tool: 'ts-oracle', network_calls: 2 },
        compute: null, geo: null, execution_env: null, parent_goal_pe_id: null,
      },
      deviceId: input.device_id,
      prevHash: head.last_pe_hash,
      timestampMs: 1_790_000_100_000,
      peId: newPeId(),
    });
    const appended = await store.append(pe);
    if (!appended.ok) throw new Error(`TS append refused: ${JSON.stringify(appended)}`);
    process.stdout.write(JSON.stringify({
      head_before: { count: head.count, last_pe_hash: head.last_pe_hash },
      pe_ids: rows.map((r) => r.pe.pe_id),
      appended: { pe_id: pe.pe_id, pe_hash: pe.pe_hash, prev_hash: pe.prev_hash },
    }));
  })().catch((err: unknown) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err));
    process.exit(1);
  });
});
