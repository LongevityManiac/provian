import { describe, it, expect } from 'vitest';
import { detectEnvironmentFacts } from './environment-class';

function probe(over: Partial<{ platform: string; env: Record<string, string>; files: Record<string, string> }>) {
  const files = over.files ?? {};
  return {
    platform: over.platform ?? 'linux',
    env: over.env ?? {},
    readText: (p: string) => (p in files ? files[p] : null),
    exists: (p: string) => p in files,
  };
}

describe('§2.11 environment class', () => {
  it('docker / kubernetes / podman markers → container (kubernetes wins over the docker marker)', () => {
    expect(detectEnvironmentFacts(probe({ files: { '/.dockerenv': '' } }))).toEqual({ container: 'docker', environment_class: 'container' });
    expect(detectEnvironmentFacts(probe({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, files: { '/.dockerenv': '' } }))).toEqual({ container: 'kubernetes', environment_class: 'container' });
    expect(detectEnvironmentFacts(probe({ files: { '/proc/1/cgroup': '0::/kubepods/burstable/pod1' } })).container).toBe('kubernetes');
    expect(detectEnvironmentFacts(probe({ files: { '/run/.containerenv': '' } })).container).toBe('podman');
  });
  it('CI dominates; a VM is read from DMI; a bare-metal linux box; darwin outside CI is bare_metal', () => {
    expect(detectEnvironmentFacts(probe({ env: { GITHUB_ACTIONS: 'true' }, files: { '/.dockerenv': '' } }))).toEqual({ container: 'docker', environment_class: 'ci' });
    expect(detectEnvironmentFacts(probe({ files: { '/sys/class/dmi/id/product_name': 'Google Compute Engine' } })).environment_class).toBe('vm');
    expect(detectEnvironmentFacts(probe({ files: { '/sys/class/dmi/id/product_name': 'ThinkPad X1' } })).environment_class).toBe('bare_metal');
    expect(detectEnvironmentFacts(probe({ platform: 'darwin' })).environment_class).toBe('bare_metal');
  });
  it('RED — no marker and no DMI on linux is unknown, never guessed', () => {
    expect(detectEnvironmentFacts(probe({}))).toEqual({ container: null, environment_class: 'unknown' });
  });
});
