/** Bind the cost model to the deployed CLI sizing instead of an independently copied default. */
export function cloudRunSizing(script: string): { vcpus: number; memoryGiB: number; concurrency: number } {
  const cpu = [...script.matchAll(/^\s*--cpu=(\d+(?:\.\d+)?)\s*\\?\s*$/gm)];
  const memory = [...script.matchAll(/^\s*--memory=(\d+(?:\.\d+)?)(Mi|Gi)\s*\\?\s*$/gm)];
  const concurrent = [...script.matchAll(/^\s*--concurrency=(\d+)\s*\\?\s*$/gm)];
  if (concurrent.length !== 1 || cpu.length !== 1 || memory.length !== 1) throw new Error('cloud_run_sizing_not_unique');
  const vcpus = Number(cpu[0][1]), memoryGiB = Number(memory[0][1]) / (memory[0][2] === 'Mi' ? 1024 : 1);
  const concurrency = Number(concurrent[0][1]);
  if (!(concurrency > 0) || !(vcpus > 0) || !(memoryGiB > 0)) throw new Error('cloud_run_sizing_invalid');
  return { vcpus, memoryGiB, concurrency };
}
