// `node --import <this file> cli.mjs`: install the test-only TypeScript hooks (ts-loader-hooks.mjs).
// registerHooks where Node has it (module.register is deprecated there and warns on stderr, which
// the CLI tests compare exactly); module.register on Node 20.
import * as nodeModule from 'node:module';
import { syncHooks } from './ts-loader-hooks.mjs';

if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks(syncHooks);
else nodeModule.register(new URL('./ts-loader-hooks.mjs', import.meta.url));
