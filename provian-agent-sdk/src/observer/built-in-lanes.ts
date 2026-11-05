/**
 * The observer daemon's OWN lanes, told apart from a plugin registered through the public
 * `registerPlugin` (follow-up, 2026-10-23).
 *
 * Built-in status is granted by REGISTRATION, never by what an object looks like: the daemon
 * (`run-daemon.ts`) registers each lane it constructs through `registerBuiltInLane`, which records
 * that exact instance in a module-private WeakSet. The public `registerPlugin` never grants it — an
 * object built on a lane class's prototype, a subclass, or even a genuine `TranscriptPlugin` an
 * embedder constructs and registers itself is a plugin, and the observer stamps every PE it hands
 * over with its gateway-plugin marker (`observation-types.ts` `withThirdPartyPluginWitness`).
 *
 * A lane the daemon registered stays built in: its queue is filled only by its own reader inside the
 * daemon process. This module is deliberately NOT exported from the package entry points, and there
 * is no flag for a plugin to declare itself built in. (Code running inside the same process can always
 * rewrite the daemon's own modules; the boundary here is what a registered plugin's PE DATA can claim.)
 */
import type { ObserverPlugin } from './plugins/PluginInterface';

/** The lane instances the daemon itself registered. */
const BUILT_IN_LANES = new WeakSet<ObserverPlugin>();

/** What registering a lane needs from the observer (the public method; status is recorded here). */
interface PluginRegistry {
  registerPlugin(plugin: ObserverPlugin): void;
}

/** The daemon's path: record `plugin` as one of its own lanes, then register it on `observer`. */
export function registerBuiltInLane(observer: PluginRegistry, plugin: ObserverPlugin): void {
  BUILT_IN_LANES.add(plugin);
  observer.registerPlugin(plugin);
}

/** True only for a lane instance the daemon registered through `registerBuiltInLane`. */
export function isBuiltInLane(plugin: ObserverPlugin): boolean {
  return BUILT_IN_LANES.has(plugin);
}
