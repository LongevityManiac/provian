import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import http from 'http';
import type { NextFunction, Request, Response } from 'express';
import { bodyDeadline, FIRESTORE_PROBE_DEADLINE_MS, InstanceHealth, requestDeadline } from './instance-health';
import { RELAY_FIRESTORE_SETTINGS } from './firestore-settings';
import { GITHUB_TASK_PATH } from './core/witnesses/github-task-queue';

afterEach(() => jest.useRealTimers());

it('performs a fresh shared-client round trip for every completed probe', async () => {
  const read = jest.fn(async () => undefined);
  const health = new InstanceHealth(read);
  health.started = true;
  const app = express().get('/health', health.liveness);
  expect((await request(app).get('/health')).status).toBe(200);
  expect((await request(app).get('/health')).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(2);
});

it('a working event loop cannot make a stuck dependency healthy; late success never clears retirement', async () => {
  jest.useFakeTimers();
  let complete!: () => void;
  const read = jest.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const health = new InstanceHealth(read);
  health.started = true;
  const first = health.check();
  const concurrent = health.check();
  await jest.advanceTimersByTimeAsync(FIRESTORE_PROBE_DEADLINE_MS - 1);
  expect(health.healthy).toBe(true);
  await jest.advanceTimersByTimeAsync(1);
  expect(await first).toBe(false);
  expect(await concurrent).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  complete();
  await Promise.resolve();
  expect(await health.check()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
});

it('refuses handler work after a failed read, and startup stays unavailable until completed', async () => {
  const health = new InstanceHealth(async () => { throw new Error('UNAVAILABLE'); });
  const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
  const app = express().get('/startup', health.startup).get('/health', health.liveness)
    .use(health.admit).get('/work', handler);
  expect((await request(app).get('/startup')).status).toBe(503);
  expect((await request(app).get('/work')).status).toBe(503);
  health.started = true;
  expect((await request(app).get('/health')).status).toBe(503);
  const rejected = await request(app).get('/work');
  expect(rejected.status).toBe(503);
  expect(rejected.headers['retry-after']).toBe('5');
  expect(handler).not.toHaveBeenCalled();
});

function response(): Response {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
  }) as unknown as Response;
}

it('does not stop a real 75-second scheduled job and clears its deadline on finish', async () => {
  jest.useFakeTimers();
  const terminate = jest.fn<never, []>(() => { throw new Error('terminated'); });
  const res = response();
  requestDeadline(terminate)({ method: 'POST', path: '/scheduler/chain-record' } as Request, res, jest.fn() as NextFunction);
  await jest.advanceTimersByTimeAsync(75_000);
  expect(terminate).not.toHaveBeenCalled();
  res.emit('finish');
  await jest.advanceTimersByTimeAsync(900_000);
  expect(terminate).not.toHaveBeenCalled();
});

it('terminates overdue handlers even after the client disconnects (negative control)', async () => {
  jest.useFakeTimers();
  const terminate = jest.fn<never, []>(() => { throw new Error('terminated'); });
  const res = response();
  requestDeadline(terminate, 100)({ method: 'GET', path: '/work' } as Request, res, jest.fn() as NextFunction);
  res.emit('close');
  expect(() => jest.advanceTimersByTime(100)).toThrow('terminated');
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(503);
});

it('covers the observed 872-second job, while ordinary requests terminate at three minutes', async () => {
  jest.useFakeTimers();
  const stopJob = jest.fn<never, []>(() => { throw new Error('job_terminated'); });
  const job = response();
  requestDeadline(stopJob)({ method: 'POST', path: '/v1/internal/scheduler/chain-record' } as Request, job, jest.fn());
  jest.advanceTimersByTime(872_000);
  expect(stopJob).not.toHaveBeenCalled();
  job.emit('finish');
  const stopOrdinary = jest.fn<never, []>(() => { throw new Error('ordinary_terminated'); });
  requestDeadline(stopOrdinary)({ method: 'GET', path: '/v1/threads/unread' } as Request, response(), jest.fn());
  expect(() => jest.advanceTimersByTime(180_000)).toThrow('ordinary_terminated');
  expect(stopOrdinary).toHaveBeenCalledTimes(1);
});

it.each([
  '/v1/internal/scheduler/chain-record',
  '/v1/internal/settlement/pvt9-run',
  '/V1/INTERNAL/SCHEDULER/chain-record',
  '/V1/INTERNAL/SETTLEMENT/pvt9-genesis-run',
  GITHUB_TASK_PATH,
  GITHUB_TASK_PATH.toUpperCase() + '/',
])('bounds the long job at twenty minutes for %s', (routePath) => {
  jest.useFakeTimers();
  const stop = jest.fn<never, []>(() => { throw new Error('scheduled_terminated'); });
  requestDeadline(stop)({ method: 'POST', path: routePath } as Request, response(), jest.fn());
  jest.advanceTimersByTime(1_199_999);
  expect(stop).not.toHaveBeenCalled();
  expect(() => jest.advanceTimersByTime(1)).toThrow('scheduled_terminated');
});

it.each([GITHUB_TASK_PATH + '-foreign', GITHUB_TASK_PATH + '/foreign'])('RED: %s does not inherit the durable worker deadline', routePath => {
  jest.useFakeTimers();
  const stop = jest.fn<never, []>(() => { throw new Error('ordinary_terminated'); });
  requestDeadline(stop)({ method: 'POST', path: routePath } as Request, response(), jest.fn());
  expect(() => jest.advanceTimersByTime(180_000)).toThrow('ordinary_terminated');
  expect(stop).toHaveBeenCalledTimes(1);
});

it('retires channels when idle and never pings without calls', () => {
  expect(RELAY_FIRESTORE_SETTINGS.maxIdleChannels).toBe(0);
  expect(RELAY_FIRESTORE_SETTINGS['grpc.keepalive_permit_without_calls']).toBe(0);
});

it('real process death prevents even a queued microtask write; a completing handler can write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-watchdog-'));
  try {
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'instance-health.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const marker = path.join(dir, 'late-write');
    const body = `
      const fs = require('fs'), {EventEmitter} = require('events');
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, status() { return this; },
        json() { queueMicrotask(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late')); }
      });
      exports.requestDeadline(undefined, 30)({method:'GET',path:'/stuck'}, res, () => {});
    `;
    const dead = spawnSync(process.execPath, ['-e', code + body + 'setTimeout(() => {}, 100);']);
    expect(dead.status).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
    // Negative control: the same actual middleware must allow completed work.
    const done = spawnSync(process.execPath, ['-e', code + body + `
      setTimeout(() => { res.emit('finish'); fs.writeFileSync(${JSON.stringify(marker)}, 'completed'); }, 5);
    `]);
    expect(done.status).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('completed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('a real slow JSON upload expires its own connection without retiring other work', async () => {
  const stop = jest.fn<never, []>(() => { throw new Error('instance_killed'); });
  const handler = jest.fn((_req: Request, res: Response) => res.json({ ok: true }));
  const app = express().use(bodyDeadline(40)).use(express.json())
    .use(requestDeadline(stop, 60)).post('/work', handler).get('/ok', handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_not_listening');
  try {
    const outcome = await new Promise<number | string>((resolve) => {
      const incoming = http.request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/work',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' } }, (res) => {
        res.resume(); resolve(res.statusCode ?? 0);
      });
      incoming.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      incoming.write('{'); // Leave the declared body incomplete.
    });
    expect([408, 'ECONNRESET']).toContain(outcome);
    expect(stop).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect((await request(server).get('/ok')).status).toBe(200);
    expect(stop).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
