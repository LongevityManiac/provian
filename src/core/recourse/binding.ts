export interface RecourseBinding {
  readonly identity: string;
  readonly address: string;
  readonly recoveryCommitment: string;
  readonly signingRoot: string;
  readonly kernel: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
}
export function recourseBindingMessage(binding: RecourseBinding): string {
  if (!/^0x[0-9a-f]{64}$/.test(binding.identity) || !/^0x[0-9a-f]{40}$/.test(binding.address)
    || !/^0x[0-9a-f]{64}$/.test(binding.signingRoot) || !/^0x[0-9a-f]{64}$/.test(binding.recoveryCommitment) || !/^0x[0-9a-f]{40}$/.test(binding.kernel)
    || /^0x0{40}$/.test(binding.address) || /^0x0{40}$/.test(binding.kernel)
    || !/^0x[0-9a-f]{64}$/.test(binding.nonce) || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs <= 0) throw new Error('recourse_binding_invalid');
  return ['Provian ownership binding', 'chain:8453', `kernel:${binding.kernel}`, `identity:${binding.identity}`,
    `address:${binding.address}`, `recovery:${binding.recoveryCommitment}`, `hash-authority:${binding.signingRoot}`, `nonce:${binding.nonce}`,
    `expires:${binding.expiresAtMs}`].join('\n');
}
