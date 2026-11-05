/**
 * Crypto shim for React Native
 *
 * Provides minimal crypto API compatibility for packages that import 'crypto'.
 * Uses expo-crypto and react-native-get-random-values for actual crypto operations.
 */

import 'react-native-get-random-values';
import * as ExpoCrypto from 'expo-crypto';

// Web Crypto API is polyfilled by react-native-get-random-values
export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

export function getRandomValues(array) {
  return globalThis.crypto.getRandomValues(array);
}

export function randomUUID() {
  return ExpoCrypto.randomUUID();
}

export function createHash(algorithm) {
  const data = [];
  return {
    update(chunk) {
      if (typeof chunk === 'string') {
        data.push(new TextEncoder().encode(chunk));
      } else {
        data.push(chunk);
      }
      return this;
    },
    async digest(encoding) {
      const combined = new Uint8Array(data.reduce((acc, arr) => acc + arr.length, 0));
      let offset = 0;
      for (const arr of data) {
        combined.set(arr, offset);
        offset += arr.length;
      }

      const algoMap = {
        'sha256': ExpoCrypto.CryptoDigestAlgorithm.SHA256,
        'sha384': ExpoCrypto.CryptoDigestAlgorithm.SHA384,
        'sha512': ExpoCrypto.CryptoDigestAlgorithm.SHA512,
      };

      const hash = await ExpoCrypto.digestStringAsync(
        algoMap[algorithm.toLowerCase()] || ExpoCrypto.CryptoDigestAlgorithm.SHA256,
        Array.from(combined).map(b => String.fromCharCode(b)).join(''),
        { encoding: ExpoCrypto.CryptoEncoding.HEX }
      );

      if (encoding === 'hex') return hash;
      if (encoding === 'base64') return Buffer.from(hash, 'hex').toString('base64');
      return Buffer.from(hash, 'hex');
    }
  };
}

export default {
  webcrypto,
  subtle,
  randomBytes,
  getRandomValues,
  randomUUID,
  createHash,
};
