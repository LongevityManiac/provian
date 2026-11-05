import type { PEClaim } from './types';

/**
 * Tracks which time windows have been claimed by plugin PEs.
 * Prevents the observer from emitting a redundant compute_session PE
 * when a plugin already emitted a richer PE covering the same window.
 */
export class DeduplicationRegistry {
  private claims: PEClaim[] = [];
  private readonly maxAgeMs = 60 * 60 * 1000;

  claim(start: number, end: number, peId: string, plugin: string): void {
    this.claims.push({ start, end, peId, plugin });
  }

  /**
   * A window is claimed if any existing claim overlaps it.
   * Observer uses this to decide whether to emit a generic compute_session PE.
   */
  isClaimed(start: number, end: number): boolean {
    for (const c of this.claims) {
      if (c.start <= end && c.end >= start) return true;
    }
    return false;
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.maxAgeMs;
    this.claims = this.claims.filter(c => c.end >= cutoff);
  }

  size(): number {
    return this.claims.length;
  }

  all(): readonly PEClaim[] {
    return this.claims;
  }
}
