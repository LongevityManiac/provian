/**
 * The Connect screen's agent options and the Devices note read the launch switch.
 *
 * Everything live at launch is built now and switches on at the flip with no post-launch edit. The
 * MCP server URL and the npx onboard line need the open `/mcp` and the published @provian SDK; each
 * reads ONE answer, the relay's `PUBLIC_LAUNCH` through `GET /v1/wallet/launch-state`
 * (`core/relay/launchState.ts`), never a hard-coded state. Before the flip those two lines show
 * "Opens at launch" with no copy action; after it they copy. They are the only two lines the switch
 * governs on the screen (the copy simplification of 2026-10-22): the connection code is shown always,
 * with copy, and the fleet row shows the installed script's command (live from the install on) and
 * the MCP tool's name, plain.
 *
 * Supersedes finding 16 / item 5, which pinned the hand-typed hosted register and
 * request-link commands of the removed "step by step" section and refused any npx line outright.
 *
 * RED controls: a screen that renders a launch-time form outside a gated line, gates the code or the
 * fleet lines, shows "Opens at launch" anywhere but a gated line, or a gate mapping / Devices note fixed
 * to one state, fails here (each case below states which).
 */

import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('../../services/RelayAPIService', () => ({ default: { getLaunchState: vi.fn(async () => null) } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
  },
}));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectLaunchGates, devicesRegisterNoteKey, parseLaunchState, loadLaunchState } from '../../core/relay/launchState';
import {
  AGENT_FLEET_CODE_CMD,
  MCP_FLEET_CODE_TOOL,
  NPX_CLI_FLEET_CODE_CMD,
  NPX_SDK_FLEET_CODE_CMD,
  NPX_SDK_ONBOARD_CMD,
} from '../../core/agents/agentShellCommands';

const screenSrc = readFileSync(resolve(__dirname, 'ConnectAgentScreen.tsx'), 'utf8');
const devicesSrc = readFileSync(resolve(__dirname, '../Settings/DeviceManagementScreen.tsx'), 'utf8');

/** The source of one top-level `const Name = (` component, up to the next top-level const. */
function componentSource(name: string): string {
  const start = screenSrc.indexOf(`const ${name} = (`);
  expect(start, name).toBeGreaterThan(0);
  const next = screenSrc.indexOf('\nconst ', start + 1);
  return screenSrc.slice(start, next < 0 ? undefined : next);
}

describe('the gates follow the launch switch, not a hard-coded state', () => {
  it('before the flip: MCP, SDK and the npx / CLI / MCP fleet forms open at launch; the installed script is live', () => {
    expect(connectLaunchGates(false)).toEqual({
      mcp: 'opens_at_launch', sdk: 'opens_at_launch',
      fleetInstalled: 'live', fleetNpx: 'opens_at_launch', fleetCli: 'opens_at_launch', fleetMcp: 'opens_at_launch',
    });
  });

  it('after the flip: every form is live (RED: a mapping fixed to either state fails one of these two cases)', () => {
    expect(connectLaunchGates(true)).toEqual({
      mcp: 'live', sdk: 'live', fleetInstalled: 'live', fleetNpx: 'live', fleetCli: 'live', fleetMcp: 'live',
    });
  });

  it('the Devices note follows the same switch', () => {
    expect(devicesRegisterNoteKey(false)).toBe('devices.registerNotePreLaunch');
    expect(devicesRegisterNoteKey(true)).toBe('devices.registerNoteLaunched');
  });

  it('only a strict boolean from the relay counts; anything else is no answer (unknown = closed)', () => {
    expect(parseLaunchState({ launched: true, mcp_url: 'https://api.provian.ai/mcp' })).toEqual({ launched: true, mcpUrl: 'https://api.provian.ai/mcp' });
    expect(parseLaunchState({ launched: false })).toEqual({ launched: false, mcpUrl: 'https://api.provian.ai/mcp' });
    for (const bad of [null, {}, { launched: 'true' }, { launched: 1 }, 'true']) expect(parseLaunchState(bad)).toBeNull();
  });

  it('reads the relay each time and keeps the last answer when a read fails', async () => {
    expect(await loadLaunchState(async () => ({ launched: true, mcp_url: 'https://api.provian.ai/mcp' }))).toMatchObject({ launched: true });
    expect(await loadLaunchState(async () => null)).toMatchObject({ launched: true });
    expect(await loadLaunchState(async () => ({ launched: false }))).toMatchObject({ launched: false });
  });
});

describe('the screens read the switch', () => {
  it('Connect derives every gate from useLaunchState() through connectLaunchGates(launch.launched)', () => {
    expect(screenSrc).toContain('const launch = useLaunchState();');
    expect(screenSrc).toContain('connectLaunchGates(launch.launched)');
    // No literal launch state on the screen.
    expect(screenSrc).not.toMatch(/connectLaunchGates\((true|false)\)|launched:\s*(true|false)/);
  });

  it('exactly two lines are gated, each through a gated line with its own gate: the MCP server URL and the npx onboard line', () => {
    const gated: Array<[string, string]> = [
      ['NPX_SDK_ONBOARD_CMD', 'gates.sdk'],
      ['launch?.mcpUrl', 'gates.mcp'],
    ];
    for (const [value, gate] of gated) {
      const at = screenSrc.indexOf(`value={${value}`);
      expect(at, value).toBeGreaterThan(0);
      const line = screenSrc.slice(screenSrc.lastIndexOf('<GatedLine', at), screenSrc.indexOf('/>', at));
      expect(line, value).toContain(`gate={${gate}}`);
    }
    // Two <GatedLine …/> uses on the screen, no more (RED: a third gated line fails here).
    expect((screenSrc.match(/<GatedLine\b/g) ?? []).length).toBe(2);
    // RED: the package commands never appear as a literal (an ungated copy row would need one).
    expect(screenSrc).not.toContain('npx @provian');
    expect(screenSrc).not.toContain("'issue_fleet_code'");
  });

  it('"Opens at launch" renders only through the gated line\'s badge (RED: any other use fails)', () => {
    expect((screenSrc.match(/t\('connectAgent\.opensAtLaunch'\)/g) ?? []).length).toBe(1);
    expect((screenSrc.match(/<LaunchBadge t=\{t\} \/>/g) ?? []).length).toBe(1);
    expect(componentSource('GatedLine')).toContain('<LaunchBadge t={t} />');
    // No other pre-launch wording anywhere on the screen or in its English copy.
    expect(screenSrc).not.toMatch(/otherWaysPreLaunch|coming soon|until launch|not yet/i);
  });

  it('the fleet row drops the npx and CLI lines; the installed script copies and the MCP tool shows as a plain name', () => {
    expect(screenSrc).not.toContain('NPX_SDK_FLEET_CODE_CMD');
    expect(screenSrc).not.toContain('NPX_CLI_FLEET_CODE_CMD');
    const fleet = componentSource('FleetBody');
    expect(fleet).toContain('cmd={AGENT_FLEET_CODE_CMD}');
    expect(fleet).toContain('{MCP_FLEET_CODE_TOOL}</Text>');
    // RED: neither fleet line is gated (no "Opens at launch", no gate prop).
    expect(fleet).not.toContain('<GatedLine');
    expect(fleet).not.toContain('gate=');
    expect(fleet).not.toContain('gatesOf');
  });

  it('the commands are the real ones each package ships', () => {
    expect(NPX_SDK_ONBOARD_CMD).toBe('npx @provian/agent-sdk onboard');
    expect(NPX_SDK_FLEET_CODE_CMD).toBe('npx @provian/agent-sdk fleet-code');
    expect(NPX_CLI_FLEET_CODE_CMD).toBe('npx @provian/cli fleet-code');
    expect(MCP_FLEET_CODE_TOOL).toBe('issue_fleet_code');
    expect(AGENT_FLEET_CODE_CMD).toBe('"$HOME/.provian/bin/provian" fleet-code');
    const sdkPkg = JSON.parse(readFileSync(resolve(__dirname, '../../../provian-agent-sdk/package.json'), 'utf8')) as { name: string; bin: Record<string, string> };
    expect(sdkPkg.name).toBe('@provian/agent-sdk');
    expect(sdkPkg.bin.onboard).toBeDefined();
    expect(sdkPkg.bin['fleet-code']).toBeDefined();
    const cliPkg = JSON.parse(readFileSync(resolve(__dirname, '../../../provian-cli/package.json'), 'utf8')) as { name: string; bin: Record<string, string> };
    expect(cliPkg.name).toBe('@provian/cli');
    expect(Object.keys(cliPkg.bin)).toEqual(['provian']);
    expect(readFileSync(resolve(__dirname, '../../../provian-cli/src/cli/commands.ts'), 'utf8')).toContain("case 'fleet-code':");
    expect(readFileSync(resolve(__dirname, '../../../provian-mcp/src/core/tools.ts'), 'utf8')).toContain("name: 'issue_fleet_code'");
  });

  it('the connection code is shown always, with copy, independent of the switch (RED: the retired codeLive gate fails)', () => {
    expect(screenSrc).not.toContain('codeLive');
    const agentPath = componentSource('AgentPath');
    const code = agentPath.indexOf("t('connectAgent.yourCode')", agentPath.indexOf("t('connectAgent.oneCommandLabel')"));
    expect(code).toBeGreaterThan(0);
    const card = agentPath.slice(code, agentPath.indexOf("t('connectAgent.agentCodeHint')", code));
    expect(card).toContain('{token.token}');
    expect(card).toContain("copy(token.token, 'token')");
    expect(card).not.toMatch(/gates|launch/);
  });

  it('the Devices note reads the switch, and shows before the launch state loads (RED: the retired fixed key is gone)', () => {
    expect(devicesSrc).toContain('const launch = useLaunchState();');
    expect(devicesSrc).toContain('t(devicesRegisterNoteKey(launch?.launched ?? true))');
    expect(devicesSrc).not.toContain("t('devices.registerNote')");
  });

  it('RED (addendum 3): never hands the agent the retired session channel', () => {
    expect(screenSrc).not.toContain('/v1/relay/agent/connect');
    expect(screenSrc).not.toContain('kind="agent"');
  });
});
