import { describe, it, expect } from 'vitest';
import { buildSystemdUnit, buildWindowsObserverTaskXml, resolveObserverEntrypoint, installedObserverScriptPath, systemdEnvironmentAssignment } from './service';

describe('buildWindowsObserverTaskXml', () => {
  const XML = buildWindowsObserverTaskXml(
    'C:\\Program Files\\nodejs\\node.exe',
    ['C:\\Users\\me\\.provian\\node\\start-observer.js'],
    'C:\\Users\\me',
  );

  it('auto-starts at every logon, hidden, and survives failure (reboot-persistent)', () => {
    expect(XML).toContain('<LogonTrigger><Enabled>true</Enabled></LogonTrigger>');
    expect(XML).toContain('<Hidden>true</Hidden>');
    expect(XML).toContain('<RestartOnFailure>');
    expect(XML).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });

  it('an every-minute trigger relaunches the observer after a crash or a self-update exit(0), one instance at a time', () => {
    expect(XML).toContain('<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>');
    expect(XML).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    // The trigger sits inside <Triggers>, beside the logon trigger.
    const triggers = XML.slice(XML.indexOf('<Triggers>'), XML.indexOf('</Triggers>'));
    expect(triggers).toContain('<TimeTrigger>');
    expect(triggers).toContain('<LogonTrigger>');
  });

  it('runs the given command with the args XML-escaped (quotes -> &quot;)', () => {
    expect(XML).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(XML).toContain(
      '<Arguments>&quot;C:\\Users\\me\\.provian\\node\\start-observer.js&quot;</Arguments>',
    );
    expect(XML).toContain('<WorkingDirectory>C:\\Users\\me</WorkingDirectory>');
  });

  it('runs unelevated (per-user), so no admin rights are needed', () => {
    expect(XML).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(XML).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  // Negative control: a command/arg carrying XML metacharacters must be escaped,
  // never emitted raw (which would corrupt the task definition).
  it('escapes XML metacharacters in the command and args', () => {
    const xml = buildWindowsObserverTaskXml('a&b<c>', ['x"y', 'p&q'], 'w>z');
    expect(xml).toContain('<Command>a&amp;b&lt;c&gt;</Command>');
    expect(xml).toContain('&quot;x&quot;y&quot; &quot;p&amp;q&quot;');
    expect(xml).toContain('<WorkingDirectory>w&gt;z</WorkingDirectory>');
    expect(xml).not.toContain('a&b<c>');
  });
});

// ---------------------------------------------------------------------------
// resolveObserverEntrypoint — the ONE explicit choice of what the auto-start
// service execs. Three branches, each constructible through the injected
// context, each with the branch it must NOT take asserted.
// ---------------------------------------------------------------------------
describe('resolveObserverEntrypoint', () => {
  const NODE = '/opt/node20/bin/node';
  const DIST = '/pkg/dist/scripts/start-observer.js';

  // Force the PRIMARY runtime resolution (resolveRuntimeTarget) to REFUSE — the
  // source-tree shape, with no hosted bundle — so each branch below reduces to
  // its INJECTED fallback and is independent of this machine's real
  // `~/.provian/agent.js` and whether `dist/` was built. Without this the tests
  // only stub the fallback and let the primary read the real filesystem, so a
  // developer machine that has the hosted bundle installed (any box running the
  // daemon) leaked it into the result. Mirrors the passing sibling tests below.
  const REFUSE_PRIMARY = {
    moduleDir: '/checkout/provian-agent-sdk/dist/observer',
    hostedBundle: '/nowhere/agent.js',
    probe: {
      exists: (p: string) => p.endsWith('tsconfig.json'), // a checkout has one; hosted bundle does not
      isDir: (p: string) => p.endsWith('/src'),            // and a src/ dir → source tree → refuse
      realpath: (p: string) => p,
    },
  };

  it('hosted bundle context (bundlePath set) → `node <bundle> observe`, regardless of dist presence', () => {
    const r = resolveObserverEntrypoint({ ...REFUSE_PRIMARY, bundlePath: '/home/a/.provian/agent.js', execPath: NODE, distObserverScript: DIST, exists: () => true });
    expect(r).toEqual({ command: NODE, args: ['/home/a/.provian/agent.js', 'observe'] });
    expect(r.args).not.toContain(DIST);
  });

  it('npm install (compiled observer on disk) → `node dist/scripts/start-observer.js`, never npx', () => {
    const probed: string[] = [];
    const r = resolveObserverEntrypoint({ ...REFUSE_PRIMARY, execPath: NODE, distObserverScript: DIST, exists: (p) => { probed.push(p); return p === DIST; } });
    expect(r).toEqual({ command: NODE, args: [DIST] });
    expect(r.command).not.toBe('npx');
    expect(probed).toEqual([DIST]); // the fallback looked at the installed script, not something else
  });

  it('RED — neither a bundle nor the compiled script → the npx fallback (the branch that is fatal pre-publish)', () => {
    const r = resolveObserverEntrypoint({ ...REFUSE_PRIMARY, execPath: NODE, distObserverScript: DIST, exists: () => false });
    expect(r).toEqual({ command: 'npx', args: ['@provian/agent-sdk', 'observe'] });
  });

  it('an EMPTY bundlePath is "not set" — it must not produce `node "" observe`', () => {
    const r = resolveObserverEntrypoint({ ...REFUSE_PRIMARY, bundlePath: '', execPath: NODE, distObserverScript: DIST, exists: () => true });
    expect(r).toEqual({ command: NODE, args: [DIST] });
  });

  it('defaults still name the installed script path', () => {
    expect(installedObserverScriptPath()).toMatch(/[\\/]scripts[\\/]start-observer\.js$/);
  });

  it('a genuine npm install (dist, no src) bakes its own compiled script', () => {
    const pkg = '/opt/homebrew/lib/node_modules/@provian/agent-sdk';
    const r = resolveObserverEntrypoint({
      execPath: NODE,
      moduleDir: `${pkg}/dist/observer`,
      hostedBundle: '/nowhere/agent.js',
      probe: {
        exists: () => false,           // no hosted bundle, no tsconfig
        isDir: () => false,            // no src/ → not a source tree
        realpath: (p) => p,
      },
    });
    expect(r).toEqual({ command: NODE, args: [`${pkg}/dist/scripts/start-observer.js`] });
    expect(r.command).not.toBe('npx');
  });

  it('THE ATLAS DEFECT — a source checkout is REFUSED, never baked into the service', () => {
    const checkout = '/Users/someone/Projects/provian/provian-agent-sdk';
    const r = resolveObserverEntrypoint({
      execPath: NODE,
      moduleDir: `${checkout}/dist/observer`,
      hostedBundle: '/nowhere/agent.js',
      probe: {
        exists: (p) => p.endsWith('tsconfig.json'), // a checkout has one
        isDir: (p) => p.endsWith(`${checkout}/src`), // and a src/ directory
        realpath: (p) => p,
      },
    });
    // The plist must NOT contain the checkout path. Baking it is precisely what
    // left the Mac mini one process-exit from permanent silence.
    expect(JSON.stringify(r)).not.toContain(checkout);
    expect(r).toEqual({ command: 'npx', args: ['@provian/agent-sdk', 'observe'] });
  });

  it('NEGATIVE CONTROL — a symlinked global install resolves to the checkout and is refused too', () => {
    const link = '/opt/homebrew/lib/node_modules/@provian/agent-sdk';
    const real = '/Users/someone/Projects/provian/provian-agent-sdk';
    const r = resolveObserverEntrypoint({
      execPath: NODE,
      moduleDir: `${link}/dist/observer`,
      hostedBundle: '/nowhere/agent.js',
      probe: {
        // realpath is the whole point: the LINK looks innocent, the target does not.
        realpath: (p) => p.startsWith(link) ? p.replace(link, real) : p,
        exists: (p) => p === `${real}/tsconfig.json`,
        isDir: (p) => p === `${real}/src`,
      },
    });
    expect(JSON.stringify(r)).not.toContain(real);
    expect(r.command).toBe('npx');
  });
});

describe('buildSystemdUnit environment assignments (2026-10-17)', () => {
  const EP = { command: '/n/node', args: ['/home/a b/.provian/node/start-observer.js'] };

  it('carries a value with spaces, quotes and backslashes intact (RED: the bare form split the line)', () => {
    const unit = buildSystemdUnit(EP, { PROVIAN_BUNDLE_PATH: '/home/a b/agent.js', NOTE: 'say "hi" \\ there' }, '/home/a b', '/home/a b/.provian/observer.log');
    expect(unit).toContain('Environment="PROVIAN_BUNDLE_PATH=/home/a b/agent.js"');
    expect(unit).toContain('Environment="NOTE=say \\"hi\\" \\\\ there"');
    expect(unit).not.toContain('Environment=PROVIAN_BUNDLE_PATH=/home/a b/agent.js');
    expect(unit).toContain('ExecStart=/n/node "/home/a b/.provian/node/start-observer.js"');
  });

  it('refuses a newline or a non-name rather than writing a broken unit', () => {
    expect(() => systemdEnvironmentAssignment('A', 'x\ny')).toThrow(/newline/);
    expect(() => systemdEnvironmentAssignment('bad name', 'x')).toThrow(/name refused/);
    expect(systemdEnvironmentAssignment('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318')).toBe('"OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318"');
  });
});
