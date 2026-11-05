#!/usr/bin/env node
/**
 * configure - Opt-in configuration helpers for the observer.
 *
 *   configure --llm-log /path/to/llm.jsonl   (npm: `npx @provian/agent-sdk configure …`;
 *                                               hosted: `"$HOME/.provian/bin/provian" configure …`)
 *
 * Updates the service file (launchd/systemd) with the env var, then restarts
 * the observer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import { getProvianDir } from './credentials';
import { LAUNCHD_LABEL, installService, restartService, isObserverRunning } from '../observer/service';

import { isDirectCliEntry } from './cli-entry';
import { cliCommand } from '../cli-command';

const LAUNCHD_PLIST = path.join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = path.join(homedir(), '.config', 'systemd', 'user', 'provian-observer.service');

function printUsage(): void {
  console.log(`
Usage: ${cliCommand('configure')} [options]

Options:
  --llm-log <path>            Also tail a JSONL inference log (PROVIAN_LLM_LOG) for
                              a runtime that writes one. Not needed for Ollama,
                              LM Studio, or llama.cpp llama-server — the observer
                              detects those on loopback and witnesses their own
                              request logs with no configuration.
  For tool capture, use: ${cliCommand('witness instructions')}
  Describe your program's real session store with witness configure --description.
  --help, -h                  Show this help.
`);
}

function setServiceEnvMacOS(key: string, value: string): boolean {
  if (!fs.existsSync(LAUNCHD_PLIST)) return false;
  let plist = fs.readFileSync(LAUNCHD_PLIST, 'utf-8');
  const entry = `    <key>${key}</key><string>${value}</string>`;
  if (plist.includes(`<key>${key}</key>`)) {
    plist = plist.replace(
      new RegExp(`\\s*<key>${key}</key>\\s*<string>[^<]*</string>`),
      `\n${entry}`,
    );
  } else if (plist.includes('<key>EnvironmentVariables</key>')) {
    plist = plist.replace(
      /(<key>EnvironmentVariables<\/key>\s*<dict>)/,
      `$1\n${entry}`,
    );
  } else {
    plist = plist.replace(
      /(<key>ProgramArguments<\/key>)/,
      `<key>EnvironmentVariables</key>\n  <dict>\n${entry}\n  </dict>\n  $1`,
    );
  }
  fs.writeFileSync(LAUNCHD_PLIST, plist);
  try { execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  execSync(`launchctl load "${LAUNCHD_PLIST}"`, { stdio: 'inherit' });
  return true;
}

function setServiceEnvLinux(key: string, value: string): boolean {
  if (!fs.existsSync(SYSTEMD_UNIT)) return false;
  let unit = fs.readFileSync(SYSTEMD_UNIT, 'utf-8');
  const line = `Environment=${key}=${value}`;
  if (unit.includes(`Environment=${key}=`)) {
    unit = unit.replace(new RegExp(`^Environment=${key}=.*$`, 'm'), line);
  } else {
    unit = unit.replace(/^(\[Service\].*?)$/ms, `$1\n${line}`);
  }
  fs.writeFileSync(SYSTEMD_UNIT, unit);
  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user restart provian-observer.service', { stdio: 'inherit' });
  return true;
}

/** The configure CLI body (the npm bin and the hosted bundle's `configure` verb,). */
export async function runConfigureCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  let llmLog: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--llm-log' && args[i + 1]) { llmLog = path.resolve(args[++i]); }
    else if (a === '--watch-transcripts') throw new Error('Describe the actual session format with provian witness configure --description <local-json-file>');
  }

  if (!llmLog) { printUsage(); process.exit(1); }

  const dir = getProvianDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (llmLog) {
    const p = platform();
    let ok = false;
    if (p === 'darwin') ok = setServiceEnvMacOS('PROVIAN_LLM_LOG', llmLog);
    else if (p === 'linux') ok = setServiceEnvLinux('PROVIAN_LLM_LOG', llmLog);
    if (!ok) {
      console.log('  Service not installed; installing now and writing env var...');
      process.env.PROVIAN_LLM_LOG = llmLog;
      const { ensureInstallerNodeAvailable } = await import('../observer/node-runtime-heal.js');
      await ensureInstallerNodeAvailable();
      installService();
    }
    console.log(`  LLM plugin enabled. Tailing: ${llmLog}`);
  }


}

if (isDirectCliEntry(module)) {
  runConfigureCli().catch(err => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
  });
}
