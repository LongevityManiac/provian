/**
 * environment-class — the ONE-FIELD-AWAY environment signal on device PEs (Trust Layer build,
 * §2.11). The daemon always filled `execution_env.container` with null; the
 * facts were a stat() away. Detection is best-effort, structure-only, and never throws:
 *
 * container — 'docker' | 'kubernetes' | 'podman' | 'containerd' | null
 * environment_class — 'container' | 'ci' | 'vm' | 'bare_metal' | 'unknown'
 *
 * A CI runner is reported as 'ci' even inside a container (the CI fact dominates: the actor
 * is a pipeline). Nothing here is a source catalog — the markers are the platform's own
 * conventions (`/.dockerenv`, cgroup names, DMI product names, CI env conventions).
 */

import * as fs from 'fs';
import * as os from 'os';

export type EnvironmentClass = 'container' | 'ci' | 'vm' | 'bare_metal' | 'unknown';

export interface EnvironmentFacts {
  readonly container: string | null;
  readonly environment_class: EnvironmentClass;
}

interface Probe {
  readonly platform: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readText: (p: string) => string | null;
  readonly exists: (p: string) => boolean;
}

function readTextSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function existsSafe(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

const CI_MARKERS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'TRAVIS', 'JENKINS_URL', 'TF_BUILD', 'CLOUD_BUILD'];
const VM_PRODUCT_RE = /(kvm|qemu|vmware|virtualbox|xen|hyper-v|google compute engine|amazon ec2|\bec2\b|droplet|openstack|parallels)/i;

export function detectContainer(probe: Probe): string | null {
  if (probe.env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  if (probe.exists('/run/.containerenv')) return 'podman';
  if (probe.exists('/.dockerenv')) return 'docker';
  const cgroup = probe.platform === 'linux' ? probe.readText('/proc/1/cgroup') : null;
  if (cgroup) {
    if (/kubepods/.test(cgroup)) return 'kubernetes';
    if (/docker/.test(cgroup)) return 'docker';
    if (/containerd/.test(cgroup)) return 'containerd';
    if (/libpod|podman/.test(cgroup)) return 'podman';
  }
  return null;
}

export function detectEnvironmentFacts(probe: Probe = {
  platform: os.platform(), env: process.env, readText: readTextSafe, exists: existsSafe,
}): EnvironmentFacts {
  const container = detectContainer(probe);
  const isCi = probe.env.CI === 'true' || probe.env.CI === '1' || CI_MARKERS.some((k) => Boolean(probe.env[k]));
  if (isCi) return { container, environment_class: 'ci' };
  if (container !== null) return { container, environment_class: 'container' };
  if (probe.platform === 'linux') {
    const product = probe.readText('/sys/class/dmi/id/product_name')
      ?? probe.readText('/sys/class/dmi/id/sys_vendor');
    if (product !== null) {
      return { container: null, environment_class: VM_PRODUCT_RE.test(product) ? 'vm' : 'bare_metal' };
    }
    // No DMI (typical of a VM without a DMI table or a restricted sysfs): unknown, never guessed.
    return { container: null, environment_class: 'unknown' };
  }
  if (probe.platform === 'darwin' || probe.platform === 'win32') {
    // A desktop OS outside CI/container: the machine the human sits at.
    return { container: null, environment_class: 'bare_metal' };
  }
  return { container: null, environment_class: 'unknown' };
}
