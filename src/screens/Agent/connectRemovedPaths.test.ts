/**
 * App-only removals : no app route, screen or copy points at a removed path.
 *
 * Removed from the app: the agent card's "step by step" section; "Another computer for your agent"
 * (the Connect mode, the laptop icon in Agent Hub, the agent page's "Set up a device for this agent");
 * both email options ("Email the command to my computer", the agent-device email form); the "PE PROOF
 * SOURCE" badge; and the unused Connect copy (the old GitHub "coming soon" block, the SDK frameworks
 * note, the "coming soon" badge), in all 12 locales. Every relay route, token type, email template and
 * agent-facing tool stays (provian-backend's own tests cover them).
 *
 * RED control: the detector catches every retired reference in a sample of the pre-change source.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');
const localesDir = resolve(SRC, 'i18n/locales');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

function appSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'i18n') appSources(p, out); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** References to a removed app path. */
const RETIRED = [
  /'agentDevice'/,
  /emailConnectCommand/,
  /\/v1\/relay\/connect\/email-command/,
  /connectAgent\.(agentDevice\w*|email\w+|agentAdvancedToggle|stepsTitle|step1|stepDevice|step2|step3|devicePathBadge|comingSoonBadge|frameworksNote|github\w+|deviceOrEmail)\b/,
  /agentHub\.(setupDeviceAccessibility|workingHint)\b/,
  /<AgentDevicePath|<EmailCommandBlock|REGISTER_AGENT_SELF_DEVICE_CMD|REQUEST_LINK_CMD/,
];
const REMOVED_CONNECT_KEYS = [
  'comingSoonBadge', 'devicePathBadge', 'deviceOrEmail', 'agentDeviceTitle', 'agentDeviceIntro', 'agentDevicePickAgent',
  'agentDeviceNoAgents', 'agentDeviceEmailPrompt', 'agentDeviceSend', 'agentDeviceSent', 'agentDeviceLinkedNote',
  'agentDeviceSafetyNote', 'agentAdvancedToggle', 'stepsTitle', 'step1', 'stepDevice', 'step2', 'step3', 'frameworksNote',
  'githubTitle', 'githubIntro', 'githubComingSoonTitle', 'githubComingSoonBody', 'githubWhyTitle', 'githubWhyBody',
  'emailButton', 'emailPrompt', 'emailSend', 'emailSent', 'emailInvalid', 'emailError',
];

describe('no app surface points at a removed path', () => {
  it('RED control: the detector catches each retired reference', () => {
    const sample = [
      "navigation.navigate('ConnectAgent', { mode: 'agentDevice', agentWalletId })",
      'await RelayAPIService.emailConnectCommand(kind, trimmed);',
      "<Text>{t('connectAgent.agentAdvancedToggle')}</Text>",
      "badge={t('connectAgent.devicePathBadge')}",
      "accessibilityLabel={t('agentHub.setupDeviceAccessibility')}",
      "<Text style={styles.workingHint}>{t('agentHub.workingHint')}</Text>",
      '<EmailCommandBlock kind="device" t={t} themeColors={themeColors} />',
    ];
    for (const line of sample) expect(RETIRED.some((re) => re.test(line)), line).toBe(true);
  });

  it('no app source references one (route, screen, service or copy key)', () => {
    const files = appSources(SRC);
    expect(files.length).toBeGreaterThan(200); // not vacuous
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of RETIRED) if (re.test(text)) hits.push(`${f.slice(SRC.length)}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it('the ConnectAgent route takes no device-for-an-agent mode', () => {
    const types = readFileSync(resolve(SRC, 'navigation/types.ts'), 'utf8');
    expect(types).toContain("ConnectAgent: { mode?: 'device' | 'agent' | 'codeHost' } | undefined;");
  });

  it('Agent Hub has no laptop button and the agent page no "set up a device" button', () => {
    const hub = readFileSync(resolve(__dirname, 'AgentHubScreen.tsx'), 'utf8');
    const actions = hub.slice(hub.indexOf('<View style={styles.agentActions}>'), hub.indexOf("navigation.navigate('RecoverAgent'"));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).not.toContain('laptop-outline');
    const detail = readFileSync(resolve(__dirname, 'AgentDetailScreen.tsx'), 'utf8');
    expect(detail).not.toMatch(/navigate\('ConnectAgent'/);
  });

  it('no locale carries a removed key (12 of 12)', () => {
    expect(localeFiles).toHaveLength(12);
    for (const file of localeFiles) {
      const json = JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')) as {
        connectAgent: Record<string, string>; agentHub: Record<string, string>; devices: Record<string, string>;
      };
      for (const k of REMOVED_CONNECT_KEYS) expect(json.connectAgent[k], `${file} connectAgent.${k}`).toBeUndefined();
      expect(json.agentHub.setupDeviceAccessibility, file).toBeUndefined();
      expect(json.agentHub.workingHint, file).toBeUndefined();
      expect(json.devices.registerNote, file).toBeUndefined();
    }
  });

  it('"Your computer" names the card on Connect and on Earn; no badge remains', () => {
    const en = JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8')) as {
      connectAgent: Record<string, string>; earn: { surfaces: Record<string, Record<string, string>> };
    };
    expect(en.connectAgent.devicePathTitle).toBe('Your computer');
    expect(en.earn.surfaces.desktop_daemon.title).toBe('Your computer');
    for (const file of localeFiles) {
      const json = JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')) as {
        connectAgent: Record<string, string>; earn: { surfaces: Record<string, Record<string, string>> };
      };
      expect(json.earn.surfaces.desktop_daemon.title, file).toBe(json.connectAgent.devicePathTitle);
    }
    const screen = readFileSync(resolve(__dirname, 'ConnectAgentScreen.tsx'), 'utf8');
    expect(screen).not.toMatch(/badge=\{/);
  });
});
