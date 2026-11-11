export function merkle(leaves: readonly string[]): { root: string; proofs: string[][] };
export function verifyProof(leaf: string, proof: readonly string[], root: string): boolean;
