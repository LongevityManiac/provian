// Keccak256 implementation. Clean-room from FIPS 202 spec.
// Constants RC, ROTC, PI are FIPS 202 mathematical values
// (public domain). No upstream library code derived.
// No attribution required.
/**
 * Minimal keccak256 (SHA-3) implementation for EVM address derivation.
 *
 * Self-contained - no npm dependencies. Implements the Keccak-f[1600]
 * permutation with rate=1088, capacity=512 (keccak256).
 *
 * Used exclusively by the SDK wallet module to derive EVM addresses
 * from secp256k1 public keys.
 */

/* Keccak-f[1600] round constants */
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/* Rotation offsets */
const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

/* Pi lane indices */
const PI = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

const MASK64 = (1n << 64n) - 1n;

function rotl64(x: bigint, n: number): bigint {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}

/** Keccak-f[1600] permutation on a 25-element state array of 64-bit lanes */
function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ step
    const C = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) {
        state[x + y] = (state[x + y] ^ D) & MASK64;
      }
    }

    // ρ and π steps
    let last = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const temp = state[j];
      state[j] = rotl64(last, ROTC[i]);
      last = temp;
    }

    // χ step
    for (let y = 0; y < 25; y += 5) {
      const t0 = state[y];
      const t1 = state[y + 1];
      const t2 = state[y + 2];
      const t3 = state[y + 3];
      const t4 = state[y + 4];
      state[y] = (t0 ^ (~t1 & t2)) & MASK64;
      state[y + 1] = (t1 ^ (~t2 & t3)) & MASK64;
      state[y + 2] = (t2 ^ (~t3 & t4)) & MASK64;
      state[y + 3] = (t3 ^ (~t4 & t0)) & MASK64;
      state[y + 4] = (t4 ^ (~t0 & t1)) & MASK64;
    }

    // ι step
    state[0] = (state[0] ^ RC[round]) & MASK64;
  }
}

/**
 * Compute keccak256 hash of a Buffer.
 * Returns a 32-byte Buffer.
 */
export function keccak256(input: Buffer): Buffer {
  const rate = 136; // 1088 bits / 8 = 136 bytes (keccak256 rate)
  const state = new Array<bigint>(25).fill(0n);

  // Absorb phase with padding (keccak uses 0x01 suffix, NOT SHA-3's 0x06)
  const padded = Buffer.alloc(Math.ceil((input.length + 1) / rate) * rate);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    // XOR block into state (little-endian 64-bit lanes)
    for (let i = 0; i < rate && i + 7 < rate; i += 8) {
      const laneIdx = i / 8;
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[offset + i + b]) << BigInt(b * 8);
      }
      state[laneIdx] ^= lane;
    }
    keccakF(state);
  }

  // Squeeze phase - extract 32 bytes (256 bits)
  const output = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    const lane = state[i];
    for (let b = 0; b < 8; b++) {
      output[i * 8 + b] = Number((lane >> BigInt(b * 8)) & 0xFFn);
    }
  }

  return output;
}
