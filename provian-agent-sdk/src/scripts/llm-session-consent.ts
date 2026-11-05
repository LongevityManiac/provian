/**
 * Consent flow for the desktop LLM session capture (Phase 2b).
 *
 * Responsibilities:
 *   - Read `capture.llm_session_enabled` from `~/.provian/config.json`.
 *   - If present, pin the prior decision and return without prompting.
 *   - If absent and interactive, show the consent screen and write the
 *     user's decision.
 *   - If absent and non-interactive:
 *       * `--skip-llm-session-consent` → auto-accept (CI path).
 *       * otherwise → fail-closed (write false) and log a pointer to the
 *         flag or to setting `capture.llm_session_enabled: true` in ~/.provian/config.json.
 *   - Print macOS permission deep-links (as OSC-8 hyperlinks) after
 *     acceptance. Never auto-open.
 *
 * Factored out of register-device so unit tests can drive it with a mocked
 * readline interface, a writable stream stub, and injected file paths.
 *
 * Spec of record: docs/PHASE_2B_DESIGN_NOTES.md §9.
 */

import type { Interface as ReadlineInterface } from 'readline';
import {
  PROVIAN_CONFIG_PATH,
  readProvianConfig,
  writeProvianConfig,
} from '../observer/config/provian-config';

/**
 * ~/.provian/config.json. Re-exported from the shared config module (identical
 * value) so existing importers keep this name. The read/write IO this file used
 * to hand-roll now routes through the shared module — one implementation of the
 * file semantics, not four (findRedeclaredLiterals discipline).
 */
export const DEFAULT_CONFIG_PATH = PROVIAN_CONFIG_PATH;

export const CONSENT_SCREEN: string = [
  '  LLM session capture',
  '',
  '  Provian observes which AI apps you bring to the foreground, for how long,',
  '  and roughly how actively you engage. This generates Provenance Envelopes',
  '  for your AI-assisted work.',
  '',
  '  The observer NEVER reads:',
  '    - the content of your AI conversations',
  '    - the pages you browse',
  '    - what you type',
  '',
  '  The observer DOES read:',
  '    - which app is frontmost (e.g. Claude, ChatGPT)',
  '    - when you switched to and away from it',
  '    - whether keyboard or mouse activity is happening (event timestamps only,',
  '      not keystrokes)',
  '',
  '  You can disable this at any time: in ~/.provian/config.json set',
  '    "capture": { "llm_session_enabled": false }',
  '',
].join('\n');

export type ConsentAction =
  | 'already-enabled'
  | 'already-disabled'
  | 'accepted'
  | 'declined'
  | 'auto-accepted'
  | 'no-tty-declined';

export interface ConsentResult {
  /** Final value of capture.llm_session_enabled after this run. */
  enabled: boolean;
  /** What happened during this invocation. */
  action: ConsentAction;
  /** True if the config had no prior setting before this invocation. */
  firstRun: boolean;
}

export interface ConsentOptions {
  /** Config file path. Defaults to ~/.provian/config.json. */
  configPath?: string;
  /** Readline interface for interactive prompting. Required when isTTY is true. */
  rl?: ReadlineInterface;
  /**
   * Whether stdin is a TTY. Defaults to process.stdin.isTTY at call time.
   * In tests, set explicitly.
   */
  isTTY?: boolean;
  /** --skip-llm-session-consent flag. Bypasses prompt in non-interactive mode. */
  skipFlag?: boolean;
  /** Platform override for deep-link printing. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Line printer. Defaults to console.log. */
  println?: (s: string) => void;
  /** Warning/info printer. Defaults to console.log. */
  warn?: (s: string) => void;
}

/**
 * OSC-8 hyperlink escape. Terminals that understand OSC-8 render `text` as
 * a hyperlink to `url`; terminals that don't understand it show `text`
 * plus a stray escape sequence (mostly invisible in modern terminals).
 * Keeping the URL on its own line below the hyperlink gives users a
 * copy-paste path that works everywhere.
 */
export function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export const PERMISSION_DEEP_LINKS: {
  accessibility: string;
  inputMonitoring: string;
} = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

export function printPermissionDeepLinks(platform: NodeJS.Platform, println: (s: string) => void): void {
  if (platform !== 'darwin') return;
  println('');
  println('  Grant these permissions in System Settings to capture AI foreground sessions:');
  println('');
  println(`    Accessibility:      ${osc8(PERMISSION_DEEP_LINKS.accessibility, 'open System Settings')}`);
  println(`    ${PERMISSION_DEEP_LINKS.accessibility}`);
  println('');
  println(`    Input Monitoring:   ${osc8(PERMISSION_DEEP_LINKS.inputMonitoring, 'open System Settings')}`);
  println(`    ${PERMISSION_DEEP_LINKS.inputMonitoring}`);
  println('');
  println('  (Copy-paste either URL into Safari if the hyperlink does not open for you.)');
  println('');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readExistingDecision(cfg: Record<string, unknown>): boolean | null {
  const capture = cfg.capture;
  if (!isRecord(capture)) return null;
  const v = capture.llm_session_enabled;
  if (typeof v === 'boolean') return v;
  return null;
}

function writeDecision(configPath: string, cfg: Record<string, unknown>, value: boolean): void {
  const capture = isRecord(cfg.capture) ? { ...cfg.capture } : {};
  capture.llm_session_enabled = value;
  cfg.capture = capture;
  writeProvianConfig(configPath, cfg);
}

async function askYesNo(rl: ReadlineInterface, question: string): Promise<boolean> {
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      const trimmed = (answer || '').trim().toLowerCase();
      // Accept Y/n convention (default yes on empty).
      if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') resolve(true);
      else resolve(false);
    });
  });
}

/**
 * Run the consent flow. Idempotent: if the config already has a decision
 * recorded, returns immediately without prompting.
 */
export async function runLLMSessionConsent(opts: ConsentOptions = {}): Promise<ConsentResult> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const println = opts.println ?? ((s: string) => console.log(s));
  const warn = opts.warn ?? ((s: string) => console.log(s));
  const platform = opts.platform ?? process.platform;
  const skip = opts.skipFlag ?? false;
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);

  const cfg = readProvianConfig(configPath);
  const existing = readExistingDecision(cfg);

  if (existing === true) {
    return { enabled: true, action: 'already-enabled', firstRun: false };
  }
  if (existing === false) {
    return { enabled: false, action: 'already-disabled', firstRun: false };
  }

  // First-run path. Decide based on flags and TTY.
  if (skip) {
    writeDecision(configPath, cfg, true);
    println('');
    println('  LLM session capture: auto-accepted via --skip-llm-session-consent.');
    printPermissionDeepLinks(platform, println);
    return { enabled: true, action: 'auto-accepted', firstRun: true };
  }

  if (!isTTY) {
    writeDecision(configPath, cfg, false);
    warn('');
    warn('  LLM session capture: non-interactive invocation without --skip-llm-session-consent.');
    warn('  Defaulting to disabled. To enable later, in ~/.provian/config.json set:');
    warn('    "capture": { "llm_session_enabled": true }');
    warn('');
    return { enabled: false, action: 'no-tty-declined', firstRun: true };
  }

  if (!opts.rl) {
    throw new Error('runLLMSessionConsent: rl is required for interactive invocations');
  }

  println(CONSENT_SCREEN);
  const accepted = await askYesNo(opts.rl, '  Accept and continue? [Y/n]: ');

  writeDecision(configPath, cfg, accepted);
  if (accepted) {
    println('');
    println('  LLM session capture enabled.');
    printPermissionDeepLinks(platform, println);
  } else {
    println('');
    println('  LLM session capture declined. The plugin will not run.');
    println('  To re-enable later, set "capture": { "llm_session_enabled": true } in ~/.provian/config.json');
    println('');
  }
  return { enabled: accepted, action: accepted ? 'accepted' : 'declined', firstRun: true };
}
