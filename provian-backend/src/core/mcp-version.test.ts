import * as fs from 'fs';
import * as path from 'path';
import { MCP_LATEST, MCP_LAUNCH_COMMAND, mcpVersionInfo } from './mcp-version';
import { PROVIAN_MCP_VERSION } from '../mcp/core/tools';

const REPO = path.resolve(__dirname, '../../..');

/** Every place that states the @provian/mcp version, read from its own file. */
function statedVersions(): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'provian-mcp/package.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(REPO, 'provian-mcp/server.json'), 'utf8'));
  expect(pkg.name).toBe('@provian/mcp');
  return {
    'provian-mcp/package.json': pkg.version,
    'provian-mcp/server.json': server.version,
    'tools.ts PROVIAN_MCP_VERSION': PROVIAN_MCP_VERSION,
    'mcp-version.ts MCP_LATEST': MCP_LATEST,
  };
}

/** Names of the stated versions that differ from the first one. */
function drift(versions: Record<string, string>): string[] {
  const entries = Object.entries(versions);
  const want = entries[0][1];
  return entries.filter(([, v]) => v !== want).map(([k]) => k);
}

describe('MCP version advertisement', () => {
  it('serves latest and the @latest launch line', () => {
    expect(mcpVersionInfo()).toEqual({ latest: MCP_LATEST, launchCommand: 'npx -y @provian/mcp@latest' });
    expect(MCP_LAUNCH_COMMAND).toBe('npx -y @provian/mcp@latest');
  });

  it('the relay, the running server and the package all state one version', () => {
    const versions = statedVersions();
    expect(Object.keys(versions)).toHaveLength(4);
    expect(drift(versions)).toEqual([]);
  });

  it('[negative control] a server reporting an older version than its package is caught', () => {
    // The shape this guard was written for: the package said 1.3.4 while the
    // server reported itself as 1.3.1.
    const stale = { ...statedVersions(), 'tools.ts PROVIAN_MCP_VERSION': '1.3.1' };
    expect(drift(stale)).toEqual(['tools.ts PROVIAN_MCP_VERSION']);
  });
});
