import { createHash, randomUUID as nodeRandomUUID, randomBytes } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(byteCount));
}

export async function digestStringAsync(algo: string, data: string) {
  // Map Expo algorithm names to Node.js crypto names
  const algoMap: Record<string, string> = {
    'SHA-256': 'sha256',
    'SHA256': 'sha256',
    'SHA-384': 'sha384',
    'SHA384': 'sha384',
    'SHA-512': 'sha512',
    'SHA512': 'sha512',
    'MD5': 'md5',
  };

  const nodeAlgo = algoMap[algo] || 'sha256';
  const hash = createHash(nodeAlgo);
  hash.update(data);
  return hash.digest('hex');
}

export const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
  SHA384: 'SHA-384',
  SHA512: 'SHA-512',
  MD5: 'MD5',
};
