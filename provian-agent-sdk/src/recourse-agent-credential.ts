import { withRecoveryMaterial, type AgentKeystore } from './keystore';
import { deriveBoundRecoveryCredential } from './recourse-address-credential';

/** The encrypted random recovery material is a private root. Neither root is
 * published: each address gets independent recovery and signing credentials. */
export async function withBoundRecoveryMaterial<T>(keystore: AgentKeystore, passphrase: string, binding: string,
  use: (secret: Uint8Array, signingSeed: Uint8Array) => Promise<T> | T): Promise<T> {
  return withRecoveryMaterial(keystore, passphrase, async (secret, seed) => {
    const root = new Uint8Array(64); root.set(secret); root.set(seed, 32);
    try {
      const derived = deriveBoundRecoveryCredential(root, binding, '0');
      try { return await use(derived.recoverySecret, derived.signingSeed); }
      finally { derived.recoverySecret.fill(0); derived.signingSeed.fill(0); }
    } finally { root.fill(0); }
  });
}
