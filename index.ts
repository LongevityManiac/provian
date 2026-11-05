// Buffer global polyfill - MUST be the very first import.
// This shim uses require() internally so Buffer is set synchronously
// before any subsequent import's module evaluation references it.
import './shims/buffer-global';

import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
// Embedded by the release builders; the artifact verifier checks the actual bundled bytes.
console.info('PROVIAN_BUNDLE:' + process.env.EXPO_PUBLIC_BUILD_PROVENANCE);
registerRootComponent(App);
