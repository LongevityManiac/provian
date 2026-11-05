import { describe, it, expect } from 'vitest';
import { parseStartArgs } from './start';

describe('parseStartArgs', () => {
  it('parses the two machine-mode flags', () => {
    const a = parseStartArgs(['--json', '--yes']);
    expect(a.json).toBe(true);
    expect(a.yes).toBe(true);
  });

  it('forwards register-device flags via passthrough, stripping start-only flags', () => {
    const a = parseStartArgs(['--json', '--agent', '--api-key', 'pvn_live_x', '--api-secret', 'pvns_y', '--harness', 'openclaw']);
    // start-only flags consumed:
    expect(a.harness).toBe('openclaw');
    expect(a.passthrough).not.toContain('--json');
    expect(a.passthrough).not.toContain('--harness');
    expect(a.passthrough).not.toContain('openclaw');
    // register-device flags forwarded verbatim:
    expect(a.passthrough).toEqual(expect.arrayContaining(['--agent', '--api-key', 'pvn_live_x', '--api-secret', 'pvns_y']));
  });

  it('--yes is both consumed by start AND forwarded (so register-device runs non-interactively)', () => {
    const a = parseStartArgs(['--yes']);
    expect(a.yes).toBe(true);
    expect(a.passthrough).toContain('--yes');
  });

  it('detects --help', () => {
    expect(parseStartArgs(['--help']).help).toBe(true);
    expect(parseStartArgs(['-h']).help).toBe(true);
  });

  // NEGATIVE CONTROL: with no flags, neither machine mode is on and nothing is
  // spuriously forwarded.
  it('defaults: interactive (no json/yes), empty passthrough', () => {
    const a = parseStartArgs([]);
    expect(a).toEqual({ json: false, yes: false, help: false, passthrough: [] });
  });
});
