import type { ProtocolDeployment } from './pointer';

/** Overlap a read with live confirmation, never its acceptance or a signature. */
export async function readConfirmedProtocolBalance<T>(
  candidate: () => Promise<ProtocolDeployment | undefined>,
  current: () => Promise<ProtocolDeployment>,
  read: (token: string) => Promise<T>,
): Promise<T> {
  const hint = await candidate();
  if (!hint) return read((await current()).addresses.kernel.toLowerCase());
  const [confirmed, speculative] = await Promise.all([
    current(),
    Promise.resolve().then(() => read(hint.addresses.kernel.toLowerCase())).then(value => ({ ok: true as const, value }),
      () => ({ ok: false as const })),
  ]);
  if (hint.revision !== confirmed.revision || hint.manifestHash !== confirmed.manifestHash
    || hint.pointer !== confirmed.pointer || hint.addresses.kernel !== confirmed.addresses.kernel)
    return read(confirmed.addresses.kernel.toLowerCase());
  if (!speculative.ok) throw Error('protocol_balance_read_failed');
  return speculative.value;
}
