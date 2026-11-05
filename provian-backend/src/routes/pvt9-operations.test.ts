/**
 * the PVT9 settlement route now has TWO ways in, on purpose:
 * (1) SCHEDULER auth → automatic REAL settlement (daily since), no body token.
 * (2) ADMIN auth → the unchanged manual route: real run STILL needs the arming
 * token echoed in the body; dry-run is a keyless read.
 *
 * These tests bind to that split with paired controls : the scheduler path
 * fires a real run, and — the safety-preservation control — the ADMIN path is
 * exactly as strict as before (a real hand run with NO token is still refused, so
 * the automation did not quietly loosen the manual gate).
 *
 * `runSettlement` is mocked: it is the one function that would mint, so the route
 * test asserts WHICH way in reaches it and with WHAT dryRun — never a real mint.
 */
import express from 'express';
import request from 'supertest';

const runSettlementMock = jest.fn();
jest.mock('../core/pvt/wp4/operator-runtime', () => {
  const actual = jest.requireActual('../core/pvt/wp4/operator-runtime');
  return {
    ...actual,
    runSettlement: (...args: unknown[]) => runSettlementMock(...args),
    summarizeSettlementRun: () => ({ dryRun: false, settlement: null }),
    runEpochKeeperRuntime: jest.fn(),
  };
});

import { createPvt9OperationsRouter, SETTLEMENT_RUN_PATH } from './pvt9-operations';
import { ARMING_TOKEN } from '../core/pvt/wp4/operator-runtime';

const ADMIN_KEY = 'test-admin-key';

function buildApp(schedulerAuthed: boolean) {
  const app = express();
  app.use(express.json());
  const router = createPvt9OperationsRouter({
    db: {} as never,
    authenticateScheduler: async () => schedulerAuthed,
  });
  app.use(router);
  return app;
}

describe(`POST ${SETTLEMENT_RUN_PATH} — scheduler-or-admin auth `, () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    runSettlementMock.mockReset();
    runSettlementMock.mockResolvedValue({ dryRun: false, settlement: null });
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  // ── (1) the scheduled automatic path ──────────────────────────────────────────
  it('SCHEDULER auth fires a REAL settlement (dryRun:false) with NO admin key and NO body token', async () => {
    const res = await request(buildApp(true)).post(SETTLEMENT_RUN_PATH).send({});
    expect(res.status).toBe(200);
    expect(runSettlementMock).toHaveBeenCalledTimes(1);
    expect(runSettlementMock.mock.calls[0][0]).toMatchObject({ dryRun: false });
  });

  // ── (2) the manual admin path — UNCHANGED, and its strictness preserved ─────
  it('SAFETY CONTROL: ADMIN auth + real run + NO body token is STILL refused (400), no settlement', async () => {
    const res = await request(buildApp(false))
      .post(SETTLEMENT_RUN_PATH).set('x-admin-key', ADMIN_KEY).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('confirmation_required');
    expect(runSettlementMock).not.toHaveBeenCalled();
  });

  it('ADMIN auth + body token fires a REAL settlement (dryRun:false)', async () => {
    const res = await request(buildApp(false))
      .post(SETTLEMENT_RUN_PATH).set('x-admin-key', ADMIN_KEY).send({ confirm: ARMING_TOKEN });
    expect(res.status).toBe(200);
    expect(runSettlementMock.mock.calls[0][0]).toMatchObject({ dryRun: false });
  });

  it('ADMIN auth + dryRun is a keyless read (dryRun:true, no token needed)', async () => {
    const res = await request(buildApp(false))
      .post(SETTLEMENT_RUN_PATH).set('x-admin-key', ADMIN_KEY).send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(runSettlementMock.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  // ── negative control: no way in ────────────────────────────────────────────
  it('RED: NEITHER scheduler NOR admin auth → 401, and settlement never runs', async () => {
    const res = await request(buildApp(false)).post(SETTLEMENT_RUN_PATH).send({ confirm: ARMING_TOKEN });
    expect(res.status).toBe(401);
    expect(runSettlementMock).not.toHaveBeenCalled();
  });
});
