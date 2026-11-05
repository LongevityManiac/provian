import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

function rotateKeyHandlerSource(): string {
  const source = fs.readFileSync(path.join(__dirname, 'agent-wallet.ts'), 'utf8');
  const marker = "router.post('/:wallet_id/rotate-key'";
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const remainder = source.slice(start + marker.length);
  const routeStarts = ['router.post(', 'router.get(', 'router.put(', 'router.delete(']
    .map((candidate) => remainder.indexOf(candidate))
    .filter((index) => index >= 0);
  const end = routeStarts.length > 0 ? Math.min(...routeStarts) : remainder.length;
  return remainder.slice(0, end);
}

describe('rotate-key handler wires the atomic transition + dual PoP ', () => {
  const handler = rotateKeyHandlerSource();

  test('checks wallet ownership before any identity work', () => {
    expect(handler).toContain('wallet.id !== wallet_id');
  });

  test('verifies BOTH the old-key and new-key proof-of-possession', () => {
    expect(handler).toContain('proof_of_old_key verification failed');
    expect(handler).toContain('proof_of_new_key verification failed');
    // Two dual-PoP checks authorize a new cut; a third current-key check
    // authenticates a replay of that same durable rotation.
    expect((handler.match(/verifyEcdsaSha256\(/g) ?? []).length).toBe(3);
  });

  test('routes the identity cut through the ATOMIC transition machinery, not a raw batch', () => {
    expect(handler).toContain('prepareKeyRotationTransition');
    expect(handler).toContain('executeKeyRotationTransition');
    // The old (deleted) defect was a db.batch() that swapped records and sealed
    // the PE AFTER the transaction (a null-pe_id split). Never reintroduce a
    // non-atomic identity write here.
    expect(handler).not.toContain('.batch(');
    expect(handler).not.toContain('peBuffer.enqueue');
  });

  test('enforces the timestamp tolerance and the 24h rate limit before mutation', () => {
    expect(handler).toContain('ROTATION_TIMESTAMP_TOLERANCE_MS');
    expect(handler).toContain('last_rotated_at');
  });
});
