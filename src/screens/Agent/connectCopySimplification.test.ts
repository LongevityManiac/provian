/**
 * Connect / agent-onboarding copy simplification .
 *
 * On every Connect screen the one thing the person must do is visible in the fewest words, and
 * everything explanatory sits behind a "Details" tap, closed by default:
 * - Chooser: no intro, three cards with one short line each, no "let an agent invite you" card.
 * - Agent path, visible top to bottom: the one command, one line under it, the connection code
 * (always, with copy) with one sentence, one line about hosted agents, the closing card.
 * - Device path, visible: the capture disclosure, the command, one "that's it" line.
 * - Earn: one-line descriptions and a two-step how-to that points at Connect.
 * - Agent Hub empty state: one sentence. Link Accept: two plain lines.
 * Every removed string is gone from all 12 locales (and the narrative overlay); every new string is
 * in all 12, translated. The only pre-launch wording anywhere is the launch switch's "Opens at launch".
 *
 * RED control: the detectors below catch a sample of the pre-change screen and copy.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');
const localesDir = resolve(SRC, 'i18n/locales');
const narrativeDir = resolve(SRC, 'i18n/narrative');
const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const locale = (file: string): Json => JSON.parse(readFileSync(resolve(localesDir, file), 'utf8')) as Json;
const screenSrc = readFileSync(resolve(__dirname, 'ConnectAgentScreen.tsx'), 'utf8');
const linkAcceptSrc = readFileSync(resolve(__dirname, 'LinkAcceptScreen.tsx'), 'utf8');
const hubSrc = readFileSync(resolve(__dirname, 'AgentHubScreen.tsx'), 'utf8');
const registrySrc = readFileSync(resolve(SRC, 'core/earn/EarningSurfaceRegistry.ts'), 'utf8');

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const sentences = (s: string): number => s.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;

/** connectAgent keys retired by the simplification. */
const REMOVED_CONNECT = [
  'intro', 'otherPathTitle', 'otherPathBody',
  'agentIntro', 'agentPrimaryLead', 'agentRunWhere', 'agentAcceptLine',
  'otherWaysIntro', 'mcpOptionBody', 'sdkOptionBody', 'otherWaysPreLaunch',
  'fleetNpxLabel', 'fleetCliLabel', 'fleetNewAgentLine',
  'deviceIntro', 'deviceStepsTitle', 'deviceStep1', 'deviceStep2',
];
/** connectAgent keys the simplification added. */
const ADDED_CONNECT = [
  'agentSendLine', 'agentHostedLine', 'detailsTitle', 'otherWaysBody', 'recoveryTitle',
  'deviceCommandLabel', 'deviceDoneLine', 'deviceToolCallsTitle', 'deviceToolCallsBody', 'deviceEachTitle', 'deviceEachBody',
];
const REMOVED_LINK_ACCEPT = [
  'bulletTrustFactorPre', 'bulletTrustFactorBold', 'bulletTrustFactorPost', 'bulletBeneficiarySplit',
  'bulletProspective', 'bulletSplitDefault', 'provianDescription',
];
const ADDED_LINK_ACCEPT = ['linkMeansWhat', 'linkMeansSplit'];

/** Pre-launch wording the run forbids everywhere but the switch's own badge. */
const PRE_LAUNCH = /coming soon|not yet|until launch|before launch|at launch|later\b/i;

function appSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'i18n') appSources(p, out); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The source of one top-level `const Name = (` component, up to the next top-level const. */
function componentSource(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = (`);
  expect(start, name).toBeGreaterThan(0);
  const next = src.indexOf('\nconst ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

/** Chooser violations in a Connect screen source: an intro, a fourth card, the invite footnote. */
export function chooserViolations(src: string): string[] {
  const block = src.slice(src.indexOf("{mode === 'choose' && ("), src.indexOf("{mode === 'codeHost' && ("));
  const out: string[] = [];
  if (block.length === 0) out.push('chooser block not found');
  if (/connectAgent\.intro\b/.test(block)) out.push('chooser: intro paragraph');
  if (/otherPath/.test(block) || /altCard/.test(block)) out.push('chooser: "let an agent invite you" card');
  const cards = (block.match(/<PathCard\b/g) ?? []).length;
  if (cards !== 3) out.push(`chooser: ${cards} cards (expected 3)`);
  return out;
}

/** Order violations on the agent path: command → send line → code → hosted line → closing card → Details. */
export function agentPathViolations(src: string): string[] {
  const path = componentSource(src, 'AgentPath');
  const ready = path.indexOf("state === 'ready' && token && !isExpired");
  const order = [
    "t('connectAgent.oneCommandLabel')", "t('connectAgent.agentSendLine')", "t('connectAgent.yourCode')",
    "t('connectAgent.agentCodeHint')", "t('connectAgent.agentHostedLine')", "t('connectAgent.waitingTitle')", '<DetailsSection',
  ];
  const out: string[] = [];
  let last = ready;
  for (const marker of order) {
    const at = path.indexOf(marker, last);
    if (at < 0) { out.push(`agent path: ${marker} missing or out of order`); continue; }
    last = at;
  }
  for (const stale of ['AgentSetupSummary', 'agentPrimaryLead', 'agentRunWhere', 'agentAcceptLine', 'agentIntro', 'OtherWaysCard', 'WhatEarnsCard', 'FleetCard']) {
    if (path.includes(stale)) out.push(`agent path: ${stale} is visible copy, not Details`);
  }
  return out;
}

describe('Connect copy simplification ', () => {
  it('RED control: the detectors catch the pre-change screen', () => {
    const planted = `
      {mode === 'choose' && (
        <>
          <Text>{t('connectAgent.intro')}</Text>
          <PathCard hero title={t('connectAgent.agentPathTitle')} />
          <PathCard title={t('connectAgent.devicePathTitle')} />
          <PathCard title={t('connectAgent.codeHostPathTitle')} />
          <View style={styles.altCard}><Text>{t('connectAgent.otherPathTitle')}</Text></View>
        </>
      )}
      {mode === 'codeHost' && (<></>)}
      const AgentPath = () => (
        <>
          <Text>{t('connectAgent.agentIntro')}</Text>
          <AgentSetupSummary />
          {state === 'ready' && token && !isExpired && (
            <Text>{t('connectAgent.oneCommandLabel')}</Text>
            <Text>{t('connectAgent.agentPrimaryLead')}</Text>
            <OtherWaysCard />
            <WhatEarnsCard />
            <Text>{t('connectAgent.waitingTitle')}</Text>
          )}
          <FleetCard />
        </>
      );
      const LoadingBlock = () => null;
    `;
    expect(chooserViolations(planted)).toEqual(['chooser: intro paragraph', 'chooser: "let an agent invite you" card']);
    const agent = agentPathViolations(planted);
    expect(agent.some((v) => v.includes('agentSendLine'))).toBe(true);
    expect(agent.some((v) => v.includes('<DetailsSection'))).toBe(true);
    expect(agent).toContain('agent path: AgentSetupSummary is visible copy, not Details');
  });

  it('the chooser is three cards and nothing else', () => {
    expect(chooserViolations(screenSrc)).toEqual([]);
  });

  it('the agent path shows the command, the one line, the code with its sentence, the hosted line, the closing card, then Details', () => {
    expect(agentPathViolations(screenSrc)).toEqual([]);
  });

  it('Details and each of its rows start closed', () => {
    expect(componentSource(screenSrc, 'DetailsSection')).toContain('useState(false)');
    expect(componentSource(screenSrc, 'DetailsRow')).toContain('useState(false)');
    const details = componentSource(screenSrc, 'AgentPath').slice(componentSource(screenSrc, 'AgentPath').indexOf('<DetailsSection'));
    for (const row of ['agentSetupTitle', 'whatEarnsTitle', 'otherWaysTitle', 'fleetTitle', 'recoveryTitle']) {
      expect(details).toContain(`<DetailsRow title={t('connectAgent.${row}')}`);
    }
  });

  it('the device path shows the disclosure, the command and the done line; the rest is under Details', () => {
    const device = componentSource(screenSrc, 'DevicePath');
    const disclosure = device.indexOf('<CaptureDisclosure');
    const command = device.indexOf("t('connectAgent.deviceCommandLabel')");
    const done = device.indexOf("t('connectAgent.deviceDoneLine')");
    const details = device.indexOf('<DetailsSection');
    expect(disclosure).toBeGreaterThan(0);
    expect(command).toBeGreaterThan(disclosure);
    expect(done).toBeGreaterThan(command);
    expect(details).toBeGreaterThan(done);
    for (const row of ['deviceWhatTitle', 'deviceToolCallsTitle', 'deviceAgentMachineTitle', 'deviceEachTitle']) {
      expect(device.slice(details)).toContain(`<DetailsRow title={t('connectAgent.${row}')}`);
    }
    expect(device).not.toMatch(/deviceIntro|deviceStep|<Step\b/);
  });

  it('no app source references a removed string', () => {
    const files = appSources(SRC);
    expect(files.length).toBeGreaterThan(200);
    const retired = new RegExp(`connectAgent\\.(${REMOVED_CONNECT.join('|')})\\b|linkAccept\\.(${REMOVED_LINK_ACCEPT.join('|')})\\b`);
    const hits: string[] = [];
    for (const f of files) if (retired.test(readFileSync(f, 'utf8'))) hits.push(f.slice(SRC.length));
    expect(hits).toEqual([]);
  });

  it('every removed string is gone and every added string is translated, in all 12 locales', () => {
    expect(localeFiles).toHaveLength(12);
    const en = locale('en.json');
    for (const file of localeFiles) {
      const j = locale(file);
      for (const k of REMOVED_CONNECT) expect(j.connectAgent[k], `${file} connectAgent.${k}`).toBeUndefined();
      for (const k of REMOVED_LINK_ACCEPT) expect(j.linkAccept[k], `${file} linkAccept.${k}`).toBeUndefined();
      for (const k of ADDED_CONNECT) {
        expect(typeof j.connectAgent[k], `${file} connectAgent.${k}`).toBe('string');
        if (file !== 'en.json') expect(j.connectAgent[k], `${file} connectAgent.${k} untranslated`).not.toBe(en.connectAgent[k]);
      }
      for (const k of ADDED_LINK_ACCEPT) {
        expect(typeof j.linkAccept[k], `${file} linkAccept.${k}`).toBe('string');
        if (file !== 'en.json') expect(j.linkAccept[k], `${file} linkAccept.${k} untranslated`).not.toBe(en.linkAccept[k]);
      }
      // The same key set everywhere.
      expect(Object.keys(j.connectAgent).sort(), file).toEqual(Object.keys(en.connectAgent).sort());
      // The narrative overlay no longer carries the removed card's copy.
      const narrative = JSON.parse(readFileSync(resolve(narrativeDir, file), 'utf8')) as Record<string, string>;
      expect(Object.keys(narrative).filter((k) => k.startsWith('connectAgent.')), file).toEqual([]);
    }
  });

  it('English word budget: short card lines, roughly forty words of visible agent copy, one-sentence explanations', () => {
    const ca = locale('en.json').connectAgent;
    for (const k of ['agentPathBody', 'devicePathBody', 'codeHostPathBody']) expect(words(ca[k]), k).toBeLessThanOrEqual(20);
    expect(words(ca.agentSendLine) + words(ca.agentCodeHint) + words(ca.agentHostedLine)).toBeLessThanOrEqual(60);
    expect(ca.agentSendLine).toBe('Send this to your agent, or run it where your agent lives. When it asks to link, tap Accept.');
    expect(ca.agentCodeHint).toBe('Agent can’t run commands? Give it this code instead — it works over MCP or the SDK.');
    expect(ca.agentHostedLine).toBe('Some hosted agents can’t run commands or hold a wallet yet — give yours the command and see.');
    expect(ca.deviceDoneLine).toBe('The observer starts and turns your commits and AI sessions into proof you own.');
    for (const k of ['agentSetupWalletBody', 'agentSetupLinkBody', 'agentSetupControlBody', 'agentSetupProofBody']) {
      expect(sentences(ca[k]), k).toBe(1);
      expect(words(ca[k]), k).toBeLessThanOrEqual(24);
    }
    for (const k of ['whatEarns1', 'whatEarns2', 'whatEarns3', 'whatEarns4', 'whatEarns5']) expect(words(ca[k]), k).toBeLessThanOrEqual(26);
    expect(ca.otherWaysBody).not.toMatch(/wallet_challenge|wallet_create|request_link/);
    expect(sentences(ca.fleetBody)).toBe(1);
  });

  it('connection copy reads as launch-day state', () => {
    const en = locale('en.json');
    const texts: Array<[string, string]> = [
      ...Object.entries(en.connectAgent as Record<string, string>).map(([k, v]): [string, string] => [`connectAgent.${k}`, v]),
      ...Object.entries(en.earn.surfaces.connected_agents as Record<string, string>).map(([k, v]): [string, string] => [`earn.connected_agents.${k}`, v]),
      ...Object.entries(en.earn.surfaces.desktop_daemon as Record<string, string>).map(([k, v]): [string, string] => [`earn.desktop_daemon.${k}`, v]),
      ...Object.entries(en.linkAccept as Record<string, string>).map(([k, v]): [string, string] => [`linkAccept.${k}`, v]),
      ['agentHub.noAgentsDesc', en.agentHub.noAgentsDesc],
    ];
    const hits = texts.filter(([, v]) => PRE_LAUNCH.test(v)).map(([k]) => k);
    expect(hits).toEqual([]);
    expect(en.connectAgent.opensAtLaunch).toBe('Connect an agent');
  });

  it('Earn: one-line descriptions and a two-step how-to on both surfaces, in all 12 locales', () => {
    expect(registrySrc).toMatch(/id: 'desktop_daemon',[\s\S]*?stepCount: 2,/);
    expect(registrySrc).toMatch(/id: 'connected_agents',[\s\S]*?stepCount: 2,/);
    const en = locale('en.json');
    for (const id of ['connected_agents', 'desktop_daemon']) {
      expect(sentences(en.earn.surfaces[id].description), id).toBe(1);
      expect(en.earn.surfaces[id].step1, id).toMatch(/^Tap Connect/);
    }
    for (const file of localeFiles) {
      const j = locale(file);
      for (const id of ['connected_agents', 'desktop_daemon']) {
        const s = j.earn.surfaces[id];
        expect(typeof s.step1, `${file} ${id}.step1`).toBe('string');
        expect(typeof s.step2, `${file} ${id}.step2`).toBe('string');
        expect(s.step3, `${file} ${id}.step3`).toBeUndefined();
        if (file !== 'en.json') expect(s.description, `${file} ${id}.description untranslated`).not.toBe(en.earn.surfaces[id].description);
      }
    }
  });

  it('Agent Hub empty state is one sentence plus the Connect button; Link Accept is two plain lines', () => {
    const en = locale('en.json');
    expect(sentences(en.agentHub.noAgentsDesc)).toBe(1);
    expect(hubSrc).toContain("t('agentHub.noAgentsDesc')");
    expect(hubSrc).toContain("t('agentHub.connectToolOrAgent')");
    expect(linkAcceptSrc).toContain("t('linkAccept.linkMeansWhat')");
    expect(linkAcceptSrc).toContain("t('linkAccept.linkMeansSplit')");
    expect(linkAcceptSrc).not.toMatch(/bulletTrustFactor|bulletSplitDefault|provianDescription|bulletProspective/);
    expect(en.linkAccept.linkMeansSplit).toMatch(/80%.*20%/);
    for (const [k, v] of Object.entries(en.linkAccept as Record<string, string>)) {
      expect(v, k).not.toMatch(/2x|attestation|5–50%|5-50%/);
    }
  });
});
