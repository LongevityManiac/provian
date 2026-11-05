/**
 * Operational-only policy telemetry thresholds.
 *
 * These values are deliberately outside every monetary template, activation
 * digest, PE snapshot, settlement digest, and contract policy. They decide
 * only what the operator digest counts and when the operator receives a bug
 * detection push.
 */

export const DEFAULT_PE_COUNT_THRESHOLD_PVT = '25';
export const DEFAULT_SINGLE_PE_PUSH_THRESHOLD_PVT = '250';
export const PE_COUNT_THRESHOLD_ENV = 'PROVIAN_OPS_PE_COUNT_THRESHOLD_PVT';
export const SINGLE_PE_PUSH_THRESHOLD_ENV = 'PROVIAN_OPS_SINGLE_PE_PUSH_THRESHOLD_PVT';

const DECIMAL_PVT = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;
const SCALE = 10n ** 18n;

export function pvtDecimalToAtomic(value: string): bigint {
  const match = DECIMAL_PVT.exec(value.trim());
  if (!match) throw new Error(`invalid_pvt_decimal:${value}`);
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? '').padEnd(18, '0');
  return whole * SCALE + BigInt(fraction || '0');
}

function configuredAtomic(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  fallback: string,
): { pvt: string; atomic: bigint; used_default: boolean } {
  const candidate = env[key]?.trim() || fallback;
  try {
    return { pvt: candidate, atomic: pvtDecimalToAtomic(candidate), used_default: candidate === fallback };
  } catch {
    return { pvt: fallback, atomic: pvtDecimalToAtomic(fallback), used_default: true };
  }
}

export interface OpsPolicyThresholds {
  readonly pe_count: { readonly pvt: string; readonly atomic: bigint; readonly used_default: boolean };
  readonly single_pe_push: { readonly pvt: string; readonly atomic: bigint; readonly used_default: boolean };
}

export function readOpsPolicyThresholds(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): OpsPolicyThresholds {
  return {
    pe_count: configuredAtomic(env, PE_COUNT_THRESHOLD_ENV, DEFAULT_PE_COUNT_THRESHOLD_PVT),
    single_pe_push: configuredAtomic(env, SINGLE_PE_PUSH_THRESHOLD_ENV, DEFAULT_SINGLE_PE_PUSH_THRESHOLD_PVT),
  };
}
