/**
 * bootstrap verb selection — a verb comes from the POSITION, not any value.
 *
 * The regression this pins is concrete: the git post-commit hook invokes the
 * bundle as `node <bundle> report-pe --branch "$BRANCH" --description "$SUBJECT"`.
 * When verbs were matched with `argv.includes(<verb>)`, a branch literally named
 * `repair` (or `observe`, `backfill-transcript`) would select that verb ahead of
 * `report-pe` — and `repair` rewrites the launchd/systemd service and the global
 * git hook. From inside a commit. No PE would record and the install would be
 * silently mutated.
 */
import { describe, it, expect } from 'vitest';
import { resolveBootstrapVerb } from './bootstrap';

const NODE = 'node';
const BUNDLE = '/Users/x/.provian/agent.js';

describe('resolveBootstrapVerb', () => {
  it('selects the verb at the argument position', () => {
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'repair'])).toBe('repair');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'observe', '--foo'])).toBe('observe');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--branch', 'main'])).toBe('report-pe');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'backfill-transcript', '--since', '0'])).toBe('backfill-transcript');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'restore-wallet', '--from-stdin'])).toBe('restore-wallet');
  });

  it('MONEY/INSTALL SAFETY — a verb appearing as an ARGUMENT VALUE is NOT selected', () => {
    // The exact hook shape, on a branch named `repair`. Must dispatch report-pe.
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--branch', 'repair'])).toBe('report-pe');
    // And on a branch named `observe`, or a one-word commit subject that is a verb.
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--branch', 'observe', '--description', 'repair'])).toBe('report-pe');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--description', 'backfill-transcript'])).toBe('report-pe');
  });

  it('the maintenance verbs the hosted output names are dispatcher verbs (`provian doctor` is doctor, not an invite code)', () => {
    for (const v of ['doctor', 'configure', 'join-commons', 'register-git-identity', 'uninstall']) {
      expect(resolveBootstrapVerb([NODE, BUNDLE, v])).toBe(v);
    }
    // Position rule still holds for the new verbs: a hook argument VALUE never selects them.
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--branch', 'uninstall'])).toBe('report-pe');
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'report-pe', '--description', 'doctor'])).toBe('report-pe');
  });

  it('returns null for no verb (default onboarding) and for an unknown verb', () => {
    expect(resolveBootstrapVerb([NODE, BUNDLE])).toBeNull();
    expect(resolveBootstrapVerb([NODE, BUNDLE, 'not-a-verb'])).toBeNull();
  });
});
