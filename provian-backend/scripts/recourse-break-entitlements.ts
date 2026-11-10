#!/usr/bin/env tsx
import { readFile } from 'fs/promises';
import { scriptDb } from './lib/script-db';
import { BREAK_ENTITLEMENTS, breakEntitlementId, checkStoredBreakEntitlement } from '../src/core/recourse/break-entitlement-store';
import { parseBreakEntitlement } from '../src/core/recourse/break-entitlement';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('recourse-break-entitlements SNAPSHOT_JSON BREAK_ORIGIN [--execute]\nAuthenticates every owner proof against the current immutable break root. Without --execute, performs no writes.\n'); return;
  }
  const [file, origin] = process.argv.slice(2);
  if (!file || !origin) throw Error('break_entitlement_arguments_required');
  const snapshot: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!snapshot || typeof snapshot !== 'object' || !('format' in snapshot) || snapshot.format !== 'provian-break-ownership-snapshot'
    || !('entries' in snapshot) || !Array.isArray(snapshot.entries)) throw Error('break_entitlement_snapshot_invalid');
  const owners = snapshot.entries.filter((row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object'
    && 'kind' in row && row.kind === 'owner');
  if (!owners.length) throw Error('break_entitlement_empty_population');
  const entitlements = owners.map(row => parseBreakEntitlement({ identity:row.identity, amount:row.amount, commitment:row.commitment, proof:row.proof }));
  if (new Set(entitlements.map(e => e.identity)).size !== entitlements.length) throw Error('break_entitlement_duplicate_identity');
  // Validate the complete population before the first write. Each row is also
  // rechecked immediately before its idempotent transaction.
  for (const e of entitlements) await checkStoredBreakEntitlement(origin,e.identity,e);
  if (process.argv.includes('--execute')) {
    const db = scriptDb();
    for (const e of entitlements) {
      await checkStoredBreakEntitlement(origin,e.identity,e);
      const ref = db.collection(BREAK_ENTITLEMENTS).doc(breakEntitlementId(origin,e.identity));
      await db.runTransaction(async tx => {
        const previous = await tx.get(ref);
        if (previous.exists && JSON.stringify(parseBreakEntitlement(previous.data())) !== JSON.stringify(e)) throw Error('break_entitlement_existing_conflict');
        if (!previous.exists) tx.create(ref,e);
      });
    }
  }
  process.stdout.write(JSON.stringify({ owners:entitlements.length, written:process.argv.includes('--execute') })+'\n');
}
main().catch(() => { process.stderr.write('Break entitlement publication refused; no snapshot data or provider details logged.\n'); process.exitCode=1; });
