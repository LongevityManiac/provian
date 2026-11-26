/**
 * expo-modules-core as the app's own code sees it on the web (Metro aliases the package here for
 * files under src/ and modules/ when bundling for web). Everything is the real package except the
 * two native-module lookups, which first consult the web implementations of Provian's own
 * native modules.
 */
import * as core from 'expo-modules-core';
import { secureSeedWeb } from './secureSeedWeb';

export * from 'expo-modules-core';

const WEB_MODULES: Record<string, unknown> = {
    ProvianSecureSeed: secureSeedWeb,
};

export function requireOptionalNativeModule<ModuleType = unknown>(moduleName: string): ModuleType | null {
    const web = WEB_MODULES[moduleName];
    if (web) return web as ModuleType;
    return core.requireOptionalNativeModule<ModuleType>(moduleName);
}

export function requireNativeModule<ModuleType = unknown>(moduleName: string): ModuleType {
    const web = WEB_MODULES[moduleName];
    if (web) return web as ModuleType;
    return core.requireNativeModule<ModuleType>(moduleName);
}
