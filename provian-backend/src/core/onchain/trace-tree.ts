export interface TraceTreeNode {
  readonly key: string; readonly parent: string | null; readonly index: number;
  readonly children: number; readonly block: number; readonly blockHash: string;
}
export function assertCompleteTraceTrees(nodes: readonly TraceTreeNode[]): void {
  const tree = new Map<string, TraceTreeNode>(), children = new Map<string, number>();
  for (const node of nodes) {
    if (tree.has(node.key)) throw new Error('compact_discovery_trace_tree_duplicate');
    tree.set(node.key, node);
    if (node.parent !== null) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  }
  for (const node of nodes) {
    if ((children.get(node.key) ?? 0) !== node.children) throw new Error('compact_discovery_trace_tree_incomplete');
    if (node.parent !== null) {
      const parent = tree.get(node.parent);
      if (!parent || node.index >= parent.children || node.block !== parent.block || node.blockHash !== parent.blockHash) {
        throw new Error('compact_discovery_trace_tree_incomplete');
      }
    }
  }
}
export function traceChildCount(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(raw) ? Number(BigInt(raw)) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('economic_discovery_trace_invalid:subtraces');
  return value;
}
