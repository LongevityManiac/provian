import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { parseNonceJournal, type NonceJournalStore } from './canonicalNonce';

let tail: Promise<void> = Promise.resolve();
const settings = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** Signed recovery bytes stay encrypted on this device; the head commits last. */
export function secureNonceStore(): NonceJournalStore {
  return {
    async transact(key, change) {
      if (!/^[0-9]+_0x[0-9a-f]{40}(?:_[A-Za-z0-9_-]{1,128})?$/.test(key)) throw new Error('nonce_store_key_invalid');
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const prefix = `evm_nonce_${key}`;
        const rawHead = await SecureStore.getItemAsync(prefix, settings);
        const head = rawHead === null ? null : JSON.parse(rawHead) as { generation: string; count: number; digest: string };
        if (head && (!/^[a-f0-9-]+$/i.test(head.generation) || !Number.isSafeInteger(head.count) || head.count < 1
          || typeof head.digest !== 'string')) throw new Error('nonce_store_head_invalid');
        let current = null;
        if (head) {
          let json = '';
          for (let i = 0; i < head.count; i++) {
            const part = await SecureStore.getItemAsync(`${prefix}_${head.generation}_${i}`, settings);
            if (part === null) throw new Error('nonce_store_incomplete');
            json += part;
          }
          if (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, json) !== head.digest) throw new Error('nonce_store_integrity');
          current = parseNonceJournal(JSON.parse(json));
        }
        const next = parseNonceJournal(change(current));
        if (!next) throw new Error('nonce_store_empty_write');
        const json = JSON.stringify(next);
        const generation = Crypto.randomUUID();
        const count = Math.ceil(json.length / 1000);
        for (let i = 0; i < count; i++) {
          await SecureStore.setItemAsync(`${prefix}_${generation}_${i}`, json.slice(i * 1000, (i + 1) * 1000), settings);
        }
        await SecureStore.setItemAsync(prefix, JSON.stringify({ generation, count,
          digest: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, json) }), settings);
        if (head) for (let i = 0; i < head.count; i++) {
          await SecureStore.deleteItemAsync(`${prefix}_${head.generation}_${i}`, settings).catch(() => undefined);
        }
        return next;
      } finally { release(); }
    },
  };
}
