/**
 * MCP admission is decoupled from PUBLIC_LAUNCH, OPEN once onboarding is on
 * (removed the key allowlist), and fail-closed on UNKNOWN.
 *
 * The named control is `THE CONTROL` below: with the onboarding flag OFF and
 * PUBLIC_LAUNCH still false, `/mcp` refuses EVERYONE. Its paired positive flips
 * exactly one variable and shows admission, so the refusal is attributable to the
 * flag and not to a dead function. The `ALLOWLIST IS RETIRED` block is the second
 * control: it proves the removed gate is actually GONE — a caller admitted with
 * NO allowlist present, and admitted even against a stale allowlist that does not
 * contain them — so "open" is not being faked by a permissive allowlist match.
 */
import {
  explainMcpAccess,
  isMcpAccessPermitted,
  mcpAccessAdmits,
  type McpAccessVerdict,
} from './mcp-access';

const AGENT = 'pvn_live_abc123';
const OTHER = 'pvn_live_zzz999';

describe('THE CONTROL — onboarding flag off, PUBLIC_LAUNCH false', () => {
  it('refuses while the onboarding flag is absent', () => {
    expect(explainMcpAccess(AGENT, { PUBLIC_LAUNCH: 'false' })).toBe('onboarding_flag_absent');
    expect(isMcpAccessPermitted(AGENT, { PUBLIC_LAUNCH: 'false' })).toBe(false);
  });

  it('refuses while the onboarding flag is explicitly false', () => {
    expect(explainMcpAccess(AGENT, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'false',
    })).toBe('onboarding_flag_false');
  });

  it('POSITIVE PAIR — flipping ONLY the onboarding flag admits', () => {
    expect(explainMcpAccess(AGENT, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
    })).toBe('open_agent_onboarding');
    expect(isMcpAccessPermitted(AGENT, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
    })).toBe(true);
  });

  it('the shipped default posture — no MCP vars at all — refuses', () => {
    expect(isMcpAccessPermitted(AGENT, {})).toBe(false);
    expect(isMcpAccessPermitted(null, {})).toBe(false);
  });
});

describe('ALLOWLIST IS RETIRED — the removed gate is actually gone', () => {
  it('admits with onboarding ON and NO allowlist variable present', () => {
    // Under the old rule this exact env returned `allowlist_variable_absent` and
    // REFUSED. That it now admits is the proof the allowlist requirement is gone.
    expect(explainMcpAccess(AGENT, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
    })).toBe('open_agent_onboarding');
  });

  it('admits a caller NOT on a stale allowlist (the value is ignored, not honored)', () => {
    // Old rule: `caller_not_allowlisted` (REFUSE). New rule: open — a leftover
    // MCP_AGENT_ALLOWLIST in the environment must not gate anyone.
    expect(explainMcpAccess(OTHER, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
      MCP_AGENT_ALLOWLIST: AGENT,
    })).toBe('open_agent_onboarding');
    expect(isMcpAccessPermitted(OTHER, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
      MCP_AGENT_ALLOWLIST: AGENT,
    })).toBe(true);
  });

  it('admits an UNIDENTIFIED (keyless) caller when onboarding is on', () => {
    // Old rule: `caller_unidentified` (REFUSE). Admission is identity-independent
    // now; the individual tool auth, not this gate, validates a key.
    expect(explainMcpAccess(null, {
      PUBLIC_LAUNCH: 'false',
      MCP_AGENT_ONBOARDING: 'true',
    })).toBe('open_agent_onboarding');
  });
});

describe('fail closed on UNKNOWN, not merely on a false conjunct', () => {
  it('an UNKNOWN PUBLIC_LAUNCH value refuses and is reported by name', () => {
    for (const raw of ['TRUE', 'True', '1', 'yes', 'maybe']) {
      expect(explainMcpAccess(AGENT, {
        PUBLIC_LAUNCH: raw,
        MCP_AGENT_ONBOARDING: 'true',
      })).toBe('public_launch_unknown_value');
    }
  });

  it('an UNKNOWN onboarding value refuses rather than degrading to false OR to open', () => {
    for (const raw of ['TRUE', '1', 'on', 'enabled']) {
      expect(explainMcpAccess(AGENT, {
        PUBLIC_LAUNCH: 'false',
        MCP_AGENT_ONBOARDING: raw,
      })).toBe('onboarding_flag_unknown_value');
      expect(isMcpAccessPermitted(AGENT, {
        PUBLIC_LAUNCH: 'false',
        MCP_AGENT_ONBOARDING: raw,
      })).toBe(false);
    }
  });
});

describe('the admit set is closed', () => {
  it('exactly two verdicts admit; every other named verdict refuses', () => {
    const all: McpAccessVerdict[] = [
      'open_public_launch', 'open_agent_onboarding', 'public_launch_unknown_value',
      'onboarding_flag_absent', 'onboarding_flag_unknown_value', 'onboarding_flag_false',
    ];
    // Non-vacuous: assert the population actually covers the union.
    expect(all).toHaveLength(6);
    expect(all.filter(mcpAccessAdmits)).toEqual(['open_public_launch', 'open_agent_onboarding']);
  });

  it('PUBLIC_LAUNCH=true still opens the endpoint exactly as before', () => {
    expect(explainMcpAccess(null, { PUBLIC_LAUNCH: 'true' })).toBe('open_public_launch');
    expect(isMcpAccessPermitted(null, { PUBLIC_LAUNCH: 'true' })).toBe(true);
  });
});

/**
 * the hosted MCP surface is CLOSED until launch. The deploy
 * template is the tracked record of that posture (the live `.env.deploy` is copied from it
 * and is gitignored), so it must declare the onboarding flag explicitly false: deploy-env.sh
 * merges env vars additively, and an ABSENT line would leave a previous Cloud Run `true` live.
 */
describe('the deploy template keeps /mcp closed pre-flip', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const parse = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  };
  // PUBLIC_LAUNCH is set on Cloud Run at the flip, never from the file: pre-flip it is 'false'.
  const judge = (text: string): McpAccessVerdict => {
    const env = parse(text);
    return explainMcpAccess(null, { PUBLIC_LAUNCH: 'false', MCP_AGENT_ONBOARDING: env.MCP_AGENT_ONBOARDING });
  };
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '.env.deploy.example'), 'utf8');

  it('declares MCP_AGENT_ONBOARDING explicitly false, so an anonymous caller is refused', () => {
    expect(parse(template).MCP_AGENT_ONBOARDING).toBe('false');
    expect(judge(template)).toBe('onboarding_flag_false');
    expect(mcpAccessAdmits(judge(template))).toBe(false);
  });

  it('RED control — the same judge admits a template that turns onboarding on, and flags one that omits it', () => {
    const opened = template.replace(/^MCP_AGENT_ONBOARDING=.*$/m, 'MCP_AGENT_ONBOARDING=true');
    expect(mcpAccessAdmits(judge(opened))).toBe(true);
    const omitted = template.replace(/^MCP_AGENT_ONBOARDING=.*$/m, '');
    expect(parse(omitted).MCP_AGENT_ONBOARDING).toBeUndefined();
  });
});
