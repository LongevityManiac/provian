import { describe, it, expect } from 'vitest';
import { DeduplicationRegistry } from './DeduplicationRegistry';

describe('DeduplicationRegistry', () => {
  it('returns false for unclaimed windows', () => {
    const r = new DeduplicationRegistry();
    expect(r.isClaimed(100, 200)).toBe(false);
  });

  it('returns true for exact match', () => {
    const r = new DeduplicationRegistry();
    r.claim(100, 200, 'pe_1', 'git');
    expect(r.isClaimed(100, 200)).toBe(true);
  });

  it('detects overlap from either side', () => {
    const r = new DeduplicationRegistry();
    r.claim(100, 200, 'pe_1', 'git');
    expect(r.isClaimed(50, 150)).toBe(true);
    expect(r.isClaimed(150, 250)).toBe(true);
    expect(r.isClaimed(120, 180)).toBe(true);
    expect(r.isClaimed(100, 100)).toBe(true);
  });

  it('reports non-overlapping windows as unclaimed', () => {
    const r = new DeduplicationRegistry();
    r.claim(100, 200, 'pe_1', 'git');
    expect(r.isClaimed(201, 300)).toBe(false);
    expect(r.isClaimed(0, 99)).toBe(false);
  });

  it('prunes claims older than one hour', () => {
    const r = new DeduplicationRegistry();
    const now = Date.now();
    r.claim(0, 1000, 'pe_old', 'git');
    r.claim(now - 1000, now, 'pe_new', 'git');
    expect(r.size()).toBe(2);
    r.prune(now);
    expect(r.size()).toBe(1);
    expect(r.isClaimed(500, 600)).toBe(false);
    expect(r.isClaimed(now - 500, now)).toBe(true);
  });
});
