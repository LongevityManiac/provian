/**
 * This SDK's own version, as a compile-time constant.
 *
 * Why a constant and not a runtime `require('../package.json')`: the SDK ships
 * three ways — the tsc `dist/` package, the self-contained bootstrap bundle
 * (`dist-bundle/agent.js`, where package.json is NOT on disk beside the file),
 * and vitest. A constant is the only form that resolves in all three. It is kept
 * in lockstep with package.json by `version.test.ts`, whose RED control fails
 * the moment the two drift — so bumping the package version without bumping this
 * is a build failure, not a silent skew.
 */
export const SDK_VERSION = '1.10.0';
