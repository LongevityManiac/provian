import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * Tests for Contract Registry Routes
 *
 * Covers:
 * - Admin auth requirement on POST
 * - Entry validation (address, chain, category, riskTier)
 * - Firestore write + Redis cache invalidation on POST
 * - GET returns entries with signature
 * - GET uses Redis cache when available
 */

import crypto from 'crypto';
import { createContractRegistryRouter, createContractRegistryPublicRouter } from './contract-registry';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Cast each jest.fn() to `any` once. The typed @jest/globals jest.fn signature
// produces UnknownFunction return types that conflict with the dynamic shapes
// we substitute via mockResolvedValue/mockReturnValue in this suite.
const mockFirestoreSet: any = (jest.fn() as any).mockResolvedValue(undefined);
const mockFirestoreDocGet: any = (jest.fn() as any).mockResolvedValue({ exists: false });

const mockDoc: any = (jest.fn() as any).mockReturnValue({
  set: mockFirestoreSet,
  get: mockFirestoreDocGet,
});

const mockCollectionGet: any = (jest.fn() as any).mockResolvedValue({ docs: [] });
const mockCollection: any = (jest.fn() as any).mockReturnValue({
  doc: mockDoc,
  get: mockCollectionGet,
});

const mockCacheGet: any = (jest.fn() as any).mockResolvedValue(null);
const mockCacheSet: any = (jest.fn() as any).mockResolvedValue(undefined);
const mockCacheDel: any = (jest.fn() as any).mockResolvedValue(undefined);

const mockDeps: any = {
  db: { collection: mockCollection },
  cache: { get: mockCacheGet, set: mockCacheSet, del: mockCacheDel },
  peBuffer: {},
  recordPEAccrual: jest.fn(),
};

// Set env vars
process.env.AGENT_BANK_ADMIN_SECRET = 'test-admin-secret';
process.env.REGISTRY_SIGNING_SECRET = 'test-signing-secret';

// ---------------------------------------------------------------------------
// Helper: simulate Express req/res
// ---------------------------------------------------------------------------

function mockReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {},
    body: {},
    params: {},
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = (jest.fn() as any).mockReturnValue(res);
  res.json = (jest.fn() as any).mockReturnValue(res);
  return res;
}

// Extract route handlers from routers
function getRouteHandler(router: any, method: string, path: string): Function {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} found on router`);
  return layer.route.stack[0].handle;
}

const adminRouter = createContractRegistryRouter(mockDeps);
const publicRouter = createContractRegistryPublicRouter(mockDeps);

const postHandler = getRouteHandler(adminRouter, 'post', '/');
const getHandler = getRouteHandler(publicRouter, 'get', '/');

beforeEach(() => {
  jest.clearAllMocks();
  mockFirestoreDocGet.mockResolvedValue({ exists: false });
  mockCollectionGet.mockResolvedValue({ docs: [] });
  mockCacheGet.mockResolvedValue(null);
});

const validEntry = {
  address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
  chain: 'base',
  platform: 'Aave V3',
  category: 'defi_lending',
  riskTier: 'medium',
  description: 'Aave V3 Pool (Base)',
};

// ---------------------------------------------------------------------------
// POST /v1/admin/contract-registry
// ---------------------------------------------------------------------------

describe('POST /v1/admin/contract-registry', () => {
  it('returns 401 without admin auth', async () => {
    const req = mockReq({ body: validEntry });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'admin_auth_failed' });
  });

  it('returns 401 with wrong admin secret', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'wrong' },
      body: validEntry,
    });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('adds entry to Firestore and invalidates Redis cache', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: validEntry,
    });
    const res = mockRes();
    await postHandler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, id: `base:${validEntry.address}` }),
    );

    // Verify Firestore write
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.objectContaining({
        address: validEntry.address,
        chain: 'base',
        platform: 'Aave V3',
        category: 'defi_lending',
      }),
    );

    // Verify Redis cache invalidation
    expect(mockCacheDel).toHaveBeenCalledWith('contract_registry:all');
  });

  it('returns 400 for invalid address format', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: { ...validEntry, address: 'not-an-address' },
    });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for invalid chain', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: { ...validEntry, chain: 'solana' },
    });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for invalid category', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: { ...validEntry, category: 'not_a_category' },
    });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for missing required fields', async () => {
    const req = mockReq({
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: { address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5' },
    });
    const res = mockRes();
    await postHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/contract-registry
// ---------------------------------------------------------------------------

describe('GET /v1/contract-registry', () => {
  const sampleEntries = [
    {
      address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
      chain: 'base',
      platform: 'Aave V3',
      category: 'defi_lending',
      riskTier: 'medium',
      description: 'Aave V3 Pool (Base)',
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  ];

  it('returns entries from Redis cache when available', async () => {
    const payload = JSON.stringify(sampleEntries);
    // Signature scheme is HMAC-SHA256 over JSON.stringify(entries) (C-12).
    const signature = crypto.createHmac('sha256', 'test-signing-secret')
      .update(payload)
      .digest('hex');
    mockCacheGet.mockResolvedValueOnce({ entries: sampleEntries, signature });

    const req = mockReq();
    const res = mockRes();
    await getHandler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ entries: sampleEntries, signature }),
    );
    // Should not hit Firestore
    expect(mockCollectionGet).not.toHaveBeenCalled();
  });

  it('falls back to Firestore on Redis miss and caches result', async () => {
    mockCollectionGet.mockResolvedValueOnce({
      docs: sampleEntries.map((e) => ({ data: () => e })),
    });

    const req = mockReq();
    const res = mockRes();
    await getHandler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.entries).toEqual(sampleEntries);
    expect(response.signature).toBeTruthy();

    // Verify HMAC-SHA256 signature (C-12: forgery-resistant vs raw SHA-256).
    const expectedSig = crypto.createHmac('sha256', 'test-signing-secret')
      .update(JSON.stringify(sampleEntries))
      .digest('hex');
    expect(response.signature).toBe(expectedSig);

    // Verify Redis cache was populated
    expect(mockCacheSet).toHaveBeenCalledWith(
      'contract_registry:all',
      expect.objectContaining({ entries: sampleEntries }),
      300,
    );
  });

  it('returns empty entries when no contracts exist', async () => {
    const req = mockReq();
    const res = mockRes();
    await getHandler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.entries).toEqual([]);
  });
});
