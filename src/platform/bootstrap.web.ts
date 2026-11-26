/**
 * Web-only startup, imported by index.ts before the app: registers the browser's device key
 * where KeyManager looks for the native Secure Enclave bridge, and Google Drive where the cloud
 * backup looks for its native bridge (both read once at module load).
 */
import { NativeModules } from 'react-native';
import { secureEnclaveWeb } from './web/secureEnclaveWeb';
import { googleDriveWeb } from './web/googleDriveWeb';
import { installWebAlert } from './web/webAlert';
import { stashProtectedNav } from '../navigation/pendingProtectedNav';

(NativeModules as Record<string, unknown>).ProvianSecureEnclaveP256 = secureEnclaveWeb;
// Google Drive backup in the Android app's folder and format (CloudBackupV2 runs unchanged).
(NativeModules as Record<string, unknown>).ProvianCloudKeychainSync = googleDriveWeb;
// react-native-web's Alert.alert is a no-op; draw the app's alerts in-app instead.
installWebAlert();

// app.provian.ai/add-phone (linked from provian.ai): open "Add your phone" once the wallet is
// unlocked. The path is cleared so a reload starts at the wallet as usual.
if (typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/add-phone') {
    stashProtectedNav({ screen: 'AddYourPhone' });
    window.history.replaceState(null, '', '/');
}
