/**
 * Decision Receipt Tests
 * ======================
 * 
 * Tests verify:
 * 1. Hash canonicalization produces stable hashes
 * 2. Signature verification passes for valid receipts
 * 3. Signature verification fails for tampered receipts
 * 4. Request hash verification works correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import {
  buildCanonicalPayload,
  buildRequestHash,
  buildAndSignReceipt,
  verifyReceipt,
  verifyRequestHash,
  serializeReceipt,
  parseReceipt,
  DecisionReceiptInvalidValueError,
  type RequestPayload,
  type DecisionReceipt,
} from './DecisionReceipt';

// ============================================================================
// Mocks
// ============================================================================

// Create a test wallet for signing
const testWallet = ethers.Wallet.createRandom();

vi.mock('expo-crypto', () => ({
  digestStringAsync: vi.fn(async (_algorithm: string, data: string) => {
    // Use a simple hash for testing - in real code this uses SHA-256
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    let hash = 0;
    for (let i = 0; i < dataBytes.length; i++) {
      hash = ((hash << 5) - hash) + dataBytes[i];
      hash = hash & hash;
    }
    // Convert to hex string
    return Math.abs(hash).toString(16).padStart(64, '0');
  }),
  CryptoDigestAlgorithm: {
    SHA256: 'SHA-256',
  },
}));

vi.mock('../security/KeyManager', () => ({
  default: {
    getPublicKey: vi.fn(async () => testWallet.signingKey.publicKey),
    getAddress: vi.fn(async () => testWallet.address),
    signPayload: vi.fn(async (message: string) => testWallet.signMessage(message)),
    performDeviceAttestation: vi.fn(async () => ({ isValid: true })),
    // [Drift A fix] Mirrors production return shape:
    // { isValid: boolean, recoveredAddress: string | null, error?: string }
    // Uses real secp256k1 ecrecover so tampered receipts naturally fail
    // (any change to the signed message recovers a different address).
    verifySignature: vi.fn(
      async (payload: string, signature: string, expectedAddress?: string) => {
        try {
          const recoveredAddress = ethers.verifyMessage(payload, signature);
          const addressToCheck = expectedAddress ?? testWallet.address;
          const isValid =
            recoveredAddress.toLowerCase() === addressToCheck.toLowerCase();
          return { isValid, recoveredAddress };
        } catch (err) {
          return {
            isValid: false,
            recoveredAddress: null,
            error: err instanceof Error ? err.message : 'Verification failed',
          };
        }
      },
    ),
  },
}));

// ============================================================================
// Test Data
// ============================================================================

const samplePayload: RequestPayload = {
  agentId: 'moltbot',
  actionType: 'purchase',
  amount: 2999,
  currency: 'USD',
  merchant: 'Amazon',
  purpose: 'Buy Clean Code book',
  metadata: { isbn: '978-0132350884', category: 'books' },
};

// ============================================================================
// Canonical Hash Tests
// ============================================================================

describe('Canonical Hashing', () => {
  it('should produce identical hashes for same payload regardless of key order', async () => {
    const payload1: RequestPayload = {
      agentId: 'test-agent',
      actionType: 'purchase',
      amount: 100,
      currency: 'USD',
      merchant: 'Shop',
      purpose: 'Test',
      metadata: { a: 1, b: 2 },
    };
    
    // Same data, different construction order (JS preserves insertion order)
    const payload2 = {
      purpose: 'Test',
      merchant: 'Shop',
      currency: 'USD',
      amount: 100,
      actionType: 'purchase',
      agentId: 'test-agent',
      metadata: { b: 2, a: 1 },
    } as RequestPayload;
    
    const hash1 = await buildRequestHash(payload1);
    const hash2 = await buildRequestHash(payload2);
    
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different amounts', async () => {
    const payload1 = { ...samplePayload, amount: 100 };
    const payload2 = { ...samplePayload, amount: 200 };
    
    const hash1 = await buildRequestHash(payload1);
    const hash2 = await buildRequestHash(payload2);
    
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different merchants', async () => {
    const payload1 = { ...samplePayload, merchant: 'Amazon' };
    const payload2 = { ...samplePayload, merchant: 'eBay' };
    
    const hash1 = await buildRequestHash(payload1);
    const hash2 = await buildRequestHash(payload2);
    
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different metadata', async () => {
    const payload1 = { ...samplePayload, metadata: { key: 'value1' } };
    const payload2 = { ...samplePayload, metadata: { key: 'value2' } };
    
    const hash1 = await buildRequestHash(payload1);
    const hash2 = await buildRequestHash(payload2);
    
    expect(hash1).not.toBe(hash2);
  });

  it('should handle nested metadata with stable ordering', async () => {
    const payload1 = {
      ...samplePayload,
      metadata: { outer: { z: 3, a: 1, m: 2 } },
    };
    
    const payload2 = {
      ...samplePayload,
      metadata: { outer: { a: 1, m: 2, z: 3 } },
    };
    
    const hash1 = await buildRequestHash(payload1);
    const hash2 = await buildRequestHash(payload2);
    
    expect(hash1).toBe(hash2);
  });

  it('should produce deterministic canonical JSON', () => {
    const canonical = buildCanonicalPayload(samplePayload);
    const parsed = JSON.parse(canonical);
    
    // Verify keys are in alphabetical order
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });
});

// ============================================================================
// Receipt Building and Signing Tests
// ============================================================================

describe('Receipt Building', () => {
  it('should build a complete signed receipt', async () => {
    const receipt = await buildAndSignReceipt({
      requestId: 'req-12345',
      walletId: 'wallet-abc',
      decision: 'ALLOW',
      requestPayload: samplePayload,
      reasonCodes: ['BUDGET_OK', 'MERCHANT_ALLOWED'],
      notes: 'Approved by user',
    });
    
    expect(receipt.version).toBe('1.0');
    expect(receipt.requestId).toBe('req-12345');
    expect(receipt.walletId).toBe('wallet-abc');
    expect(receipt.decision).toBe('ALLOW');
    expect(receipt.requestHash).toBeDefined();
    expect(receipt.signature).toBeDefined();
    expect(receipt.signerPublicKey).toBe(testWallet.signingKey.publicKey);
    expect(receipt.signerAddress).toBe(testWallet.address);
    expect(receipt.reasonCodes).toEqual(['BUDGET_OK', 'MERCHANT_ALLOWED']);
    expect(receipt.notes).toBe('Approved by user');
    expect(receipt.decidedAt).toBeDefined();
  });

  it('should build receipt for DENY decision', async () => {
    const receipt = await buildAndSignReceipt({
      requestId: 'req-deny-test',
      walletId: 'wallet-xyz',
      decision: 'DENY',
      requestPayload: samplePayload,
      reasonCodes: ['OVER_BUDGET'],
    });
    
    expect(receipt.decision).toBe('DENY');
    expect(receipt.reasonCodes).toEqual(['OVER_BUDGET']);
  });

  it('should include ISO timestamp', async () => {
    const before = new Date().toISOString();
    
    const receipt = await buildAndSignReceipt({
      requestId: 'req-time',
      walletId: 'wallet-time',
      decision: 'ALLOW',
      requestPayload: samplePayload,
    });
    
    const after = new Date().toISOString();
    
    expect(receipt.decidedAt >= before).toBe(true);
    expect(receipt.decidedAt <= after).toBe(true);
  });
});

// ============================================================================
// Signature Verification Tests
// ============================================================================

describe('Signature Verification', () => {
  let validReceipt: DecisionReceipt;
  
  beforeEach(async () => {
    validReceipt = await buildAndSignReceipt({
      requestId: 'req-verify',
      walletId: 'wallet-verify',
      decision: 'ALLOW',
      requestPayload: samplePayload,
    });
  });

  it('should verify a valid receipt', async () => {
    const result = await verifyReceipt(validReceipt);
    
    expect(result.valid).toBe(true);
    expect(result.recoveredAddress?.toLowerCase()).toBe(testWallet.address.toLowerCase());
    expect(result.error).toBeUndefined();
  });

  it('should verify receipt against expected signer', async () => {
    const result = await verifyReceipt(validReceipt, testWallet.address);
    
    expect(result.valid).toBe(true);
  });

  it('should fail if expected signer does not match', async () => {
    const wrongAddress = '0x1234567890123456789012345678901234567890';
    const result = await verifyReceipt(validReceipt, wrongAddress);
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match expected');
  });

  it('should fail if decision is tampered', async () => {
    const tampered = { ...validReceipt, decision: 'DENY' as const };
    const result = await verifyReceipt(tampered);
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match claimed signer');
  });

  it('should fail if requestId is tampered', async () => {
    const tampered = { ...validReceipt, requestId: 'fake-request-id' };
    const result = await verifyReceipt(tampered);
    
    expect(result.valid).toBe(false);
  });

  it('should fail if amount is tampered (via requestHash)', async () => {
    // Create a receipt, then tamper with the hash
    const tampered = { 
      ...validReceipt, 
      requestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 
    };
    const result = await verifyReceipt(tampered);
    
    expect(result.valid).toBe(false);
  });

  it('should fail if timestamp is tampered', async () => {
    const tampered = { ...validReceipt, decidedAt: '2020-01-01T00:00:00.000Z' };
    const result = await verifyReceipt(tampered);
    
    expect(result.valid).toBe(false);
  });

  it('should fail if signerAddress is tampered', async () => {
    const tampered = { 
      ...validReceipt, 
      signerAddress: '0x0000000000000000000000000000000000000000' 
    };
    const result = await verifyReceipt(tampered);
    
    expect(result.valid).toBe(false);
  });

  it('should fail with invalid signature format', async () => {
    const tampered = { ...validReceipt, signature: 'not-a-valid-signature' };
    const result = await verifyReceipt(tampered);

    // Production: KeyManager.verifySignature catches the ethers parse error
    // and returns { isValid: false, error: <ethers message> }. verifyReceipt
    // surfaces that error verbatim. The previous assertion looked for the
    // string 'Verification failed' which only appeared when the whole
    // verifySignature symbol was undefined (mock drift catch path), not
    // during real signature parse failures.
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ============================================================================
// Request Hash Verification Tests
// ============================================================================

describe('Request Hash Verification', () => {
  it('should verify matching request hash', async () => {
    const receipt = await buildAndSignReceipt({
      requestId: 'req-hash-test',
      walletId: 'wallet-hash',
      decision: 'ALLOW',
      requestPayload: samplePayload,
    });
    
    const matches = await verifyRequestHash(receipt, samplePayload);
    expect(matches).toBe(true);
  });

  it('should reject mismatched request hash', async () => {
    const receipt = await buildAndSignReceipt({
      requestId: 'req-hash-test',
      walletId: 'wallet-hash',
      decision: 'ALLOW',
      requestPayload: samplePayload,
    });
    
    const differentPayload = { ...samplePayload, amount: 9999 };
    const matches = await verifyRequestHash(receipt, differentPayload);
    expect(matches).toBe(false);
  });
});

// ============================================================================
// Serialization Tests
// ============================================================================

describe('Serialization', () => {
  it('should serialize and parse receipt correctly', async () => {
    const original = await buildAndSignReceipt({
      requestId: 'req-serial',
      walletId: 'wallet-serial',
      decision: 'ALLOW',
      requestPayload: samplePayload,
      reasonCodes: ['TEST'],
      notes: 'Test notes',
    });
    
    const serialized = serializeReceipt(original);
    expect(typeof serialized).toBe('string');
    
    const parsed = parseReceipt(serialized);
    expect(parsed.requestId).toBe(original.requestId);
    expect(parsed.decision).toBe(original.decision);
    expect(parsed.signature).toBe(original.signature);
    
    // Verify the parsed receipt is still valid
    const result = await verifyReceipt(parsed);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid receipt format', () => {
    expect(() => parseReceipt('{}')).toThrow('Invalid receipt format');
    expect(() => parseReceipt('{"requestId": "x"}')).toThrow('Invalid receipt format');
  });
});

// ============================================================================
// [M-41] Canonicalization edge types
// ============================================================================

describe('canonicalization edge types', () => {
  const base: Omit<RequestPayload, 'metadata'> = {
    agentId: 'a',
    actionType: 't',
    amount: 1,
    currency: 'USD',
    merchant: 'm',
    purpose: 'p',
  };

  it('serializes Date instances as ISO strings', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const out = buildCanonicalPayload({ ...base, metadata: { d } });
    expect(out).toContain('2026-01-01T00:00:00.000Z');
  });

  it('throws DecisionReceiptInvalidValueError on Symbol values', () => {
    expect(() =>
      buildCanonicalPayload({ ...base, metadata: { s: Symbol('x') as unknown as string } }),
    ).toThrow(DecisionReceiptInvalidValueError);
  });

  it('throws DecisionReceiptInvalidValueError on function values', () => {
    expect(() =>
      buildCanonicalPayload({ ...base, metadata: { f: (() => 1) as unknown as string } }),
    ).toThrow(DecisionReceiptInvalidValueError);
  });

  it('throws DecisionReceiptInvalidValueError on BigInt values', () => {
    expect(() =>
      buildCanonicalPayload({ ...base, metadata: { b: BigInt(1) as unknown as string } }),
    ).toThrow(DecisionReceiptInvalidValueError);
  });

  it('skips undefined values in objects', () => {
    const out = buildCanonicalPayload({
      ...base,
      metadata: { a: 1, b: undefined as unknown as string, c: 2 },
    });
    expect(out).not.toContain('"b"');
    expect(out).toContain('"a":1');
    expect(out).toContain('"c":2');
  });

  it('preserves null values', () => {
    const out = buildCanonicalPayload({ ...base, metadata: { x: null } });
    expect(out).toContain('"x":null');
  });

  it('coerces undefined array elements to null', () => {
    const out = buildCanonicalPayload({
      ...base,
      metadata: { arr: [1, undefined as unknown as number, 3] },
    });
    expect(out).toContain('[1,null,3]');
  });
});
