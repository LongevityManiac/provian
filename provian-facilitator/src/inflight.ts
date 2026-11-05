/**
 * One settlement per payer at a time (per instance; the service runs as a single instance — see
 * DEPLOY.md). A buyer cannot race two payments that each simulate fine but cannot both land, which
 * would leave the facilitator paying gas for the one that fails.
 */
export class InFlight {
  private readonly held = new Set<string>();

  tryAcquire(key: string): boolean {
    if (this.held.has(key)) return false;
    this.held.add(key);
    return true;
  }

  release(key: string): void {
    this.held.delete(key);
  }
}
