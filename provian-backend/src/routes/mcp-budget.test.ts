import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import type { Request, Response } from 'express';
import { mcpBatchBudget, MCP_MAX_BATCH_ELEMENTS } from './mcp-budget';
const rateLimit = jest.fn(async (..._args: unknown[]) => ({ allowed: true }));
const buildServer = jest.fn();
jest.mock('../cache', () => ({ cache: { checkRateLimit: (...args: unknown[]) => rateLimit(...args) } }));
jest.mock('../mcp/core/server', () => ({ buildProvianMcpServer: (...args: unknown[]) => buildServer(...args) }));
import { mountMCPRoutes } from './mcp';

beforeEach(() => { process.env.MCP_AGENT_ONBOARDING = 'true'; rateLimit.mockClear(); buildServer.mockClear(); });
afterAll(() => { delete process.env.MCP_AGENT_ONBOARDING; });
function app() { const app = express(); app.use(express.json({ limit: '220kb' })); mountMCPRoutes(app); return app; }
const list = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
it.each([200, 800])('rejects original %i-element amplification before any server/reply construction', async count => {
  const res = await request(app()).post('/mcp').send(Array.from({length:count}, (_,id)=>list(id)));
  expect(res.status).toBe(413);
  expect(Buffer.byteLength(res.text)).toBeLessThan(512);
  expect(buildServer).not.toHaveBeenCalled();
  expect(rateLimit).not.toHaveBeenCalled();
});
it('admits any method mix up to the element cap without inspecting tool arguments or reserving replies', () => {
  expect(mcpBatchBudget(Array.from({length:MCP_MAX_BATCH_ELEMENTS}, (_,id)=>list(id))).allowed).toBe(true);
  expect(mcpBatchBudget(Array.from({length:MCP_MAX_BATCH_ELEMENTS}, (_,id)=>({id,method:'tools/call'}))).allowed).toBe(true);
  expect(mcpBatchBudget(Array.from({length:MCP_MAX_BATCH_ELEMENTS+1}, (_,id)=>list(id))).allowed).toBe(false);
});
it('charges every element, including notifications, before constructing a reply', async () => {
  rateLimit.mockResolvedValueOnce({ allowed: false });
  const res = await request(app()).post('/mcp').send([list(1), {jsonrpc:'2.0',method:'notifications/initialized'}]);
  expect(res.status).toBe(429);
  expect(rateLimit.mock.calls[0][3]).toBe(2);
  expect(buildServer).not.toHaveBeenCalled();
});
it('an aborted fallback upload is handled without an escaped rejection', async () => {
  let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
  const fakeApp = { post(_path: string, fn: typeof handler) {handler=fn;}, get() {}, delete() {} };
  mountMCPRoutes(fakeApp as unknown as express.Express);
  const input = new Readable({read() {this.destroy(new Error('aborted'));}});
  const req = Object.assign(input,{headers:{},query:{},socket:{remoteAddress:'127.0.0.1'}}) as unknown as Request;
  const res = {headersSent:false,destroyed:false,status:jest.fn().mockReturnThis(),json:jest.fn()};
  await expect(handler!(req,res as unknown as Response)).resolves.toBeUndefined();
  expect(res.status).toHaveBeenCalledWith(400);expect(buildServer).not.toHaveBeenCalled();
});

it('refuses deeply nested but valid JSON without escaping the handler', async () => {
  const text='{"x":'.repeat(10_000)+'0'+'}'.repeat(10_000);
  const res=await request(app()).post('/mcp').set('Content-Type','application/json').send(text);
  expect(res.status).toBe(400);expect(buildServer).not.toHaveBeenCalled();
  expect((await request(app()).post('/mcp').send(Array.from({length:200},(_,id)=>list(id)))).status).toBe(413);
});
