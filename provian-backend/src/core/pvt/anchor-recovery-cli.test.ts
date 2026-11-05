/**
 * anchor-recovery-cli: argument parsing + dry-run default behavior.
 *
 * Coverage:
 *   - default mode is dry-run (no flag, no env)
 *   - legacy execute requests are recognized and then rejected
 *   - --execute=false leaves dry-run on (no opt-in)
 *   - block-range flags pass through to the worker
 *   - CLI never instantiates contracts on its own - buildWorkerDeps is the seam
 */

import { parseCliArgs, runAnchorRecoveryCli } from './anchor-recovery-cli';

describe('parseCliArgs', () => {
  it('defaults to dry-run when no flag and no env var', () => {
    expect(parseCliArgs([], {}).execute).toBe(false);
  });

  it('--execute=true enables execute mode', () => {
    expect(parseCliArgs(['--execute=true'], {}).execute).toBe(true);
  });

  it('--execute=false stays in dry-run', () => {
    expect(parseCliArgs(['--execute=false'], {}).execute).toBe(false);
  });

  it('ANCHOR_RECOVERY_EXECUTE=true alone enables execute mode', () => {
    expect(parseCliArgs([], { ANCHOR_RECOVERY_EXECUTE: 'true' }).execute).toBe(true);
  });

  it('ANCHOR_RECOVERY_EXECUTE other than "true" stays in dry-run', () => {
    expect(parseCliArgs([], { ANCHOR_RECOVERY_EXECUTE: '1' }).execute).toBe(false);
    expect(parseCliArgs([], { ANCHOR_RECOVERY_EXECUTE: 'yes' }).execute).toBe(false);
  });

  it('parses --fromBlock / --toBlock / --confirmations', () => {
    const args = parseCliArgs(['--fromBlock=100', '--toBlock=200', '--confirmations=5'], {});
    expect(args.fromBlock).toBe(100);
    expect(args.toBlock).toBe(200);
    expect(args.confirmations).toBe(5);
  });

  it('ignores non-numeric block values', () => {
    expect(parseCliArgs(['--fromBlock=abc'], {}).fromBlock).toBeUndefined();
  });
});

describe('runAnchorRecoveryCli', () => {
  it('defaults to dry-run and surfaces it in the report', async () => {
    const fakeReport = {
      scanned_from: 0,
      scanned_to: 0,
      events_seen: 0,
      outcomes: {},
      batches: [],
      dry_run: true,
    };
    const buildWorkerDeps = jest.fn(async () => ({
      db: {} as any,
      pvtContract: {} as any,
      peAnchorContract: {} as any,
    }));

    // Stub the worker via spy on the imported module - but since runAnchorRecoveryCli
    // imports runAnchorRecoveryWorker directly, easier path: assert via the deps
    // it builds. Use an in-process worker mock here by replacing module import.
    jest.resetModules();
    jest.doMock('./anchor-recovery-worker', () => ({
      runAnchorRecoveryWorker: jest.fn(async () => fakeReport),
    }));
    const { runAnchorRecoveryCli: cli } = require('./anchor-recovery-cli') as typeof import('./anchor-recovery-cli');

    const logs: string[] = [];
    const report = await cli({
      argv: [],
      env: {},
      buildWorkerDeps,
      log: (m) => logs.push(m),
    });
    expect(report).toBe(fakeReport);
    expect(logs.some((m) => m.includes('READ-ONLY'))).toBe(true);
    expect(logs.some((m) => m.includes('EXECUTE MODE'))).toBe(false);
  });

  it('rejects a legacy execute request before constructing worker dependencies', async () => {
    jest.resetModules();
    jest.doMock('./anchor-recovery-worker', () => ({
      runAnchorRecoveryWorker: jest.fn(),
    }));
    const { runAnchorRecoveryCli: cli } = require('./anchor-recovery-cli') as typeof import('./anchor-recovery-cli');

    const buildWorkerDeps = jest.fn();
    await expect(cli({
      argv: ['--execute=true'],
      env: {},
      buildWorkerDeps,
      log: () => {},
    })).rejects.toThrow('anchor_recovery_execute_retired_use_mint_claim_recovery');
    expect(buildWorkerDeps).not.toHaveBeenCalled();
  });

  it('forwards block-range flags into worker options', async () => {
    const workerMock = jest.fn(async (_deps: unknown, opts: unknown) => {
      return {
        scanned_from: (opts as { fromBlock: number }).fromBlock,
        scanned_to: (opts as { toBlock: number }).toBlock,
        events_seen: 0,
        outcomes: {},
        batches: [],
        dry_run: !(opts as { execute?: boolean }).execute,
      };
    });
    jest.resetModules();
    jest.doMock('./anchor-recovery-worker', () => ({ runAnchorRecoveryWorker: workerMock }));
    const { runAnchorRecoveryCli: cli } = require('./anchor-recovery-cli') as typeof import('./anchor-recovery-cli');

    await cli({
      argv: ['--fromBlock=100', '--toBlock=200', '--confirmations=3'],
      env: {},
      buildWorkerDeps: async () => ({ db: {} as any, pvtContract: {} as any, peAnchorContract: {} as any }),
      log: () => {},
    });
    const passedOpts = workerMock.mock.calls[0][1] as { fromBlock: number; toBlock: number; confirmations: number; execute?: boolean };
    expect(passedOpts.fromBlock).toBe(100);
    expect(passedOpts.toBlock).toBe(200);
    expect(passedOpts.confirmations).toBe(3);
    expect(passedOpts.execute).toBe(false);
  });

  it('does not import firebase-admin at top level (lazy via buildLiveWorkerDeps)', async () => {
    // The CLI must not eagerly initialize firebase-admin on import - that
    // would force CI environments to wire Google credentials just to run unit
    // tests. The seam is buildLiveWorkerDeps, which is only invoked from the
    // require.main === module branch.
    const fs = await import('fs');
    const path = require.resolve('./anchor-recovery-cli');
    const src = fs.readFileSync(path, 'utf8');
    // Top-level import must not exist - only a dynamic await import inside buildLiveWorkerDeps.
    expect(src).not.toMatch(/^import .* from ['"]firebase-admin['"]/m);
    expect(src).toMatch(/await import\(['"]firebase-admin['"]\)/);
  });
});
