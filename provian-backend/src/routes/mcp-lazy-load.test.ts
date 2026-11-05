/**
 * The MCP SDK and the tool core load on the first `/mcp` request, not when the
 * route module loads or the route is mounted. They are about 12 MB of heap, a
 * fifth of the relay's boot heap, and most instances never serve `/mcp`.
 *
 * Each module is registered with a factory that records when it is first
 * required and then returns the real module, so the test observes the load
 * itself and the request is served by the real SDK.
 */
import express from 'express';
import request from 'supertest';
import type { MCPRouteDeps } from './mcp';

const MCP_ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jest', version: '0' } },
};
const WATCHED = ['@modelcontextprotocol/server', '@modelcontextprotocol/node', '../mcp/core/server'] as const;

type MountRoutes = (app: express.Express, deps?: MCPRouteDeps) => void;

function loadRouteWithLoadTracking(): { mount: MountRoutes; loaded: Set<string> } {
  const loaded = new Set<string>();
  let mount: MountRoutes | null = null;
  jest.isolateModules(() => {
    for (const name of WATCHED) {
      jest.doMock(name, () => {
        loaded.add(name);
        return jest.requireActual(name);
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mount = (require('./mcp') as { mountMCPRoutes: MountRoutes }).mountMCPRoutes;
  });
  if (!mount) throw new Error('mcp route module did not load');
  return { mount, loaded };
}

describe('MCP runtime loads on the first /mcp request', () => {
  afterEach(() => {
    delete process.env.PUBLIC_LAUNCH;
    delete process.env.MCP_AGENT_ONBOARDING;
    for (const name of WATCHED) jest.dontMock(name);
  });

  it('loading and mounting the route loads none of the MCP modules', () => {
    const { mount, loaded } = loadRouteWithLoadTracking();
    const app = express();
    app.use(express.json());
    mount(app);
    expect([...loaded]).toEqual([]);
  });

  it('a refused request (closed door) still loads nothing', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'false';
    const { mount, loaded } = loadRouteWithLoadTracking();
    const app = express();
    app.use(express.json());
    mount(app);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request(app).post('/mcp').set('Accept', MCP_ACCEPT).send(INITIALIZE).expect(404);
    } finally {
      warn.mockRestore();
    }
    expect([...loaded]).toEqual([]);
  });

  it('the first admitted request loads all three and is served by the real SDK; the next reuses them', async () => {
    process.env.PUBLIC_LAUNCH = 'false';
    process.env.MCP_AGENT_ONBOARDING = 'true';
    const { mount, loaded } = loadRouteWithLoadTracking();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    mount(app);
    expect(loaded.size).toBe(0);

    const first = await request(app).post('/mcp').set('Accept', MCP_ACCEPT).send(INITIALIZE).expect(200);
    expect([...loaded].sort()).toEqual([...WATCHED].sort());
    const read = (res: request.Response): { result?: { serverInfo?: { name?: string } } } => {
      if (res.type === 'text/event-stream') {
        const line = (res.text ?? '').split('\n').find((l) => l.startsWith('data:'));
        return line ? JSON.parse(line.slice('data:'.length).trim()) : {};
      }
      return res.body;
    };
    expect(read(first).result?.serverInfo?.name).toBe('provian');

    const second = await request(app).post('/mcp').set('Accept', MCP_ACCEPT).send(INITIALIZE).expect(200);
    expect(read(second).result?.serverInfo?.name).toBe('provian');
    expect(loaded.size).toBe(WATCHED.length);
    // Loading the real MCP SDK and tool core takes seconds when the full suite runs in parallel.
  }, 30_000);
});
