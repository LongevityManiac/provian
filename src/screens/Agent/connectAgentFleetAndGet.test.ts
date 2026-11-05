/**
 * items 6 + 9 on the Connect screen.
 *
 * Item 9: the install line is a GET with the code in the x-provian-token header.
 * A body-less POST with no Content-Length is refused 411 by Google Front End
 * before it reaches the relay, so the screen must never hand out the
 * `-X POST` / `-Method Post` form again.
 *
 * Item 6, fleet (; supersedes 's removal of the fleet lines): fleet is a
 * working instruction on the agent path. A linked agent brings your other agents by running
 * fleet-code and giving the code to the new agent, which connects with it. Since the copy
 * simplification of 2026-10-22 it is a Details row: one sentence, the installed agent script's
 * command (live from the install on), and the MCP tool's name. The npx and CLI forms are not shown.
 * 's promise-only lines stay retired.
 *
 * RED baseline: against the pre-change screen the GET pins fail (it shipped
 * `curl -sSL -X POST -H 'x-provian-token: …'`), and the fleet pins fail against
 * the screen (no fleet row, no fleet copy in any locale).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const screenSrc = readFileSync(resolve(__dirname, 'ConnectAgentScreen.tsx'), 'utf8');
const localesDir = resolve(__dirname, '../../i18n/locales');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

describe('Connect screen install line is a GET (item 9)', () => {
  it('agent + device lines carry the code in the header of a GET', () => {
    expect(screenSrc).toContain("`curl -sSL -H 'x-provian-token: ${token}' \"${relayUrl}/v1/bootstrap/agent\" | sh`");
    expect(screenSrc).toContain("`irm -Headers @{'x-provian-token'='${token}';'x-provian-platform'='windows'} \"${relayUrl}/v1/bootstrap/agent\" | iex`");
    expect(screenSrc).toContain("`curl -sSL -H 'x-provian-token: ${token}' \"${relayUrl}/v1/bootstrap/device\" | sh`");
  });

  it('RED: never the body-less POST form GFE refuses with 411', () => {
    expect(screenSrc).not.toContain("-X POST -H 'x-provian-token");
    expect(screenSrc).not.toContain("irm -Method Post -Headers @{'x-provian-token'");
  });
});

describe('Connect screen offers fleet as a working instruction ', () => {
  const FLEET_KEYS = ['fleetTitle', 'fleetBody', 'fleetInstalledLabel', 'fleetMcpLabel'];
  const RETIRED_FLEET_KEYS = ['agentFleetLine', 'agentFleetGenesisLine', 'fleetNpxLabel', 'fleetCliLabel', 'fleetNewAgentLine'];

  it('the agent path carries the fleet row under Details, in every state, with the installed command and the MCP tool name', () => {
    const agentPath = screenSrc.slice(screenSrc.indexOf('const AgentPath = ('), screenSrc.indexOf('// ─── Shared building blocks'));
    const details = agentPath.slice(agentPath.indexOf('<DetailsSection'));
    expect(details).toContain("t('connectAgent.fleetTitle')");
    expect(details).toContain('<FleetBody');
    // Outside the ready-state block, so it renders whatever the code's state is.
    expect(agentPath.indexOf('<DetailsSection')).toBeGreaterThan(agentPath.lastIndexOf("state === 'ready' && token && !isExpired"));
    const row = screenSrc.slice(screenSrc.indexOf('const FleetBody = ('), screenSrc.indexOf('const LoadingBlock = ('));
    expect(row).toContain('cmd={AGENT_FLEET_CODE_CMD}');
    expect(row).toContain('{MCP_FLEET_CODE_TOOL}');
    for (const k of ['fleetBody', 'fleetInstalledLabel', 'fleetMcpLabel']) expect(row).toContain(`t('connectAgent.${k}')`);
    // RED: the npx and CLI forms are not shown.
    for (const v of ['NPX_SDK_FLEET_CODE_CMD', 'NPX_CLI_FLEET_CODE_CMD']) expect(screenSrc).not.toContain(v);
  });

  it('every locale carries the fleet copy, translated, and none of the retired lines (12 of 12)', () => {
    expect(localeFiles).toHaveLength(12);
    const en = (JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8')) as { connectAgent: Record<string, string> }).connectAgent;
    expect(en.fleetBody).toContain('fleet-code');
    for (const file of localeFiles) {
      const json = JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')) as { connectAgent: Record<string, string> };
      for (const k of FLEET_KEYS) expect(json.connectAgent[k], `${file} ${k}`).toBeTruthy();
      if (file !== 'en.json') expect(json.connectAgent.fleetBody, file).not.toBe(en.fleetBody);
      for (const k of RETIRED_FLEET_KEYS) expect(json.connectAgent[k], `${file} ${k}`).toBeUndefined();
    }
  });
});
