import type { ProtocolDeployment } from './pointer';

/** Overlap a read with live confirmation, never its acceptance or a signature. */
export async function readConfirmedProtocolBalance<T>(
  candidate: () => Promise<ProtocolDeployment | undefined>,
  current: () => Promise<ProtocolDeployment>,
  read: (token: string) => Promise<T>,
): Promise<T> {
  // Reserve this operation's confirmation before yielding to other readers.
  // Otherwise history reads started in the same render can jump ahead while
  // the candidate is loading, adding several complete confirmation cycles.
  const hintPromise = candidate();
  const confirmation = current();
  const speculativeRead = hintPromise.then(hint => hint
    ? Promise.resolve().then(() => read(hint.addresses.kernel.toLowerCase()))
      .then(value => ({ ok: true as const, value }), () => ({ ok: false as const }))
    : undefined);
  const [hint, confirmed, speculative] = await Promise.all([hintPromise, confirmation, speculativeRead]);
  if (!hint || hint.revision !== confirmed.revision || hint.manifestHash !== confirmed.manifestHash
    || hint.pointer !== confirmed.pointer || hint.addresses.kernel !== confirmed.addresses.kernel)
    return read(confirmed.addresses.kernel.toLowerCase());
  if (!speculative?.ok) throw Error('protocol_balance_read_failed');
  return speculative.value;
}
