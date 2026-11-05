/**
 * Cross-language PE Archive drop oracle : the REAL TypeScript FsPeStore (the observer
 * daemon's) drops the given PEs of a Python-written store — exactly what the daemon does once their
 * day is confirmed in the PE Archive — so the Python suite can prove it still reads the store.
 *
 * stdin: {"root", "device_id", "day", "wallet", "pes": [{index, pe_id, pe_hash}]}
 * stdout: {"dropped": n}
 */
import { FsPeStore } from '../../../provian-agent-sdk/src/meter/pe-store';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  void (async () => {
    const input = JSON.parse(raw) as {
      root: string; device_id: string; day: string; wallet: string;
      pes: { index: number; pe_id: string; pe_hash: string }[];
    };
    const store = new FsPeStore(input.device_id, input.root);
    const r = await store.dropArchivedDay({ day: input.day, wallet: input.wallet, pes: input.pes, part_sha256s: ['a'.repeat(64)] });
    process.stdout.write(JSON.stringify({ dropped: r.dropped }));
  })().catch((err: unknown) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err));
    process.exit(1);
  });
});
