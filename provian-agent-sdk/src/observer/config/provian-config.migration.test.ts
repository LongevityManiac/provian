/**
 * Part C — the two originally-private `~/.provian/config.json` copies are
 * migrated onto this shared module. This test PROVES the routing: the shared
 * reader/writer are spy-wrapped (behavior unchanged), and both call sites are
 * driven and asserted to go through the spies.
 *
 *   - scripts/llm-session-consent.ts  → reads AND writes through the module.
 *   - LLMSessionPlugin.resolveConfig  → reads through the module.
 *
 * RED control: revert either call site to a hand-rolled fs read/write and its
 * assertion below goes red (the spy never fires).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Wrap the shared module in spies WITHOUT altering behavior. vitest mocks by
// RESOLVED module, so every importer of this file (consent via
// `../observer/config/provian-config`, the plugin via `../../config/provian-config`)
// gets the same spied instance.
vi.mock('./provian-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provian-config')>();
  return {
    ...actual,
    readProvianConfig: vi.fn(actual.readProvianConfig),
    writeProvianConfig: vi.fn(actual.writeProvianConfig),
  };
});

// eslint-disable-next-line import/first
import * as sharedConfig from './provian-config';
// eslint-disable-next-line import/first
import { runLLMSessionConsent } from '../../scripts/llm-session-consent';
// eslint-disable-next-line import/first
import { LLMSessionPlugin } from '../plugins/llm-session/LLMSessionPlugin';
// eslint-disable-next-line import/first
import type { ProvianObserver } from '../ProvianObserver';

const readSpy = sharedConfig.readProvianConfig as unknown as ReturnType<typeof vi.fn>;
const writeSpy = sharedConfig.writeProvianConfig as unknown as ReturnType<typeof vi.fn>;
const observer = { log: () => {} } as unknown as ProvianObserver;

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-cfg-mig-'));
  return path.join(dir, 'config.json');
}

describe('Part C — both private config copies route through the shared module', () => {
  beforeEach(() => { readSpy.mockClear(); writeSpy.mockClear(); });

  it('llm-session-consent WRITES and READS through the shared module', async () => {
    const p = tmpConfigPath();
    const res = await runLLMSessionConsent({
      configPath: p, isTTY: false, skipFlag: true, println: () => {}, warn: () => {},
    });
    expect(res.enabled).toBe(true);
    expect(readSpy).toHaveBeenCalledWith(p);
    expect(writeSpy).toHaveBeenCalledWith(p, expect.objectContaining({
      capture: expect.objectContaining({ llm_session_enabled: true }),
    }));
    // The shared writer really produced the file the shared reader reads back
    // (semantics preserved by the migration, not just the call routed).
    expect(sharedConfig.readProvianConfig(p)).toMatchObject({
      capture: { llm_session_enabled: true },
    });
  });

  it('LLMSessionPlugin.resolveConfig READS through the shared module', async () => {
    const p = tmpConfigPath();
    fs.writeFileSync(p, JSON.stringify({ capture: { llm_session_enabled: false } }));
    const plugin = new LLMSessionPlugin({ configPath: p });
    await plugin.init(observer); // resolveConfig() runs, sees false, disables cleanly
    expect(readSpy).toHaveBeenCalledWith(p);
  });
});
