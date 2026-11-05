/** Firestore gRPC status 6 / canonical string code for create() collisions. */
export function isFirestoreAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown };
  return candidate.code === 6
    || candidate.code === 'already-exists'
    || candidate.code === 'ALREADY_EXISTS';
}
