/** Admit the complete batch before constructing any MCP server or reply. */
export const MCP_MAX_BATCH_ELEMENTS = 16;
export function mcpBatchBudget(body: unknown): { allowed: boolean; elements: number } {
  const elements = Array.isArray(body) ? body.length : 1;
  // Tool work and response sizes belong to the REST handlers. A transport
  // reservation cannot predict either, especially after a write has committed.
  return { allowed: elements > 0 && elements <= MCP_MAX_BATCH_ELEMENTS, elements };
}
