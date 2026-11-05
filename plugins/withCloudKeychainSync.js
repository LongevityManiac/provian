/**
 * Expo config plugin that restores the ProvianCloudKeychainSync native modules
 * (PIN-encrypted wallet backup: iCloud Keychain on iOS, Google Drive appDataFolder
 * on Android) after `expo prebuild --clean` wipes the native directories.
 *
 * Before 's follow-through no plugin restored these files, so a clean
 * prebuild silently removed cloud backup from the build. The sources are the
 * committed files under `plugins/native/`; `scripts/native-plugin-sources.test.mjs` pins
 * them byte-identical to the committed `ios/` and `android/` trees.
 *
 * iOS: ProvianCloudKeychainSync.swift +.m in the Xcode project, and the
 * `$(AppIdentifierPrefix)ai.provian.cloudkeychain` keychain access group.
 * Android: Module.kt + Package.kt, the package registered in MainApplication.kt,
 * and the Google Sign-In + Drive client dependencies in app/build.gradle.
 */
const {
  withDangerousMod,
  withXcodeProject,
  withAppBuildGradle,
  withEntitlementsPlist,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NATIVE_DIR = path.join(__dirname, 'native');
const readNative = (platform, file) => fs.readFileSync(path.join(NATIVE_DIR, platform, file), 'utf8');

/** Files this plugin writes: platform → [source file in plugins/native/<platform>/]. */
const NATIVE_FILES = {
  ios: ['ProvianCloudKeychainSync.swift', 'ProvianCloudKeychainSync.m'],
  android: ['ProvianCloudKeychainSyncModule.kt', 'ProvianCloudKeychainSyncPackage.kt'],
};

const KEYCHAIN_ACCESS_GROUP = '$(AppIdentifierPrefix)ai.provian.cloudkeychain';

// The committed app/build.gradle block (F-04: Drive appDataFolder replaced Block Store).
const ANDROID_DEPENDENCIES = `    // F-04: Replaces play-services-auth-blockstore. Block Store only restores
    // during the Android OS setup wizard (no help for sideloaded APK installs
    // or recovery on an existing phone). Drive appDataFolder is retrievable
    // any time the user signs into the right Google account.
    implementation("com.google.android.gms:play-services-auth:21.0.0")
    implementation("com.google.api-client:google-api-client-android:2.2.0") {
        exclude group: "org.apache.httpcomponents"
    }
    implementation("com.google.apis:google-api-services-drive:v3-rev20231128-2.0.0") {
        exclude group: "org.apache.httpcomponents"
    }`;

function withCloudKeychainSyncIOS(config) {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName || 'Provian';
      const iosDir = path.join(config.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(iosDir, { recursive: true });
      for (const file of NATIVE_FILES.ios) {
        fs.writeFileSync(path.join(iosDir, file), readNative('ios', file));
      }
      return config;
    },
  ]);

  config = withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectName = config.modRequest.projectName || 'Provian';
    const fileRefs = project.pbxFileReferenceSection();
    const groupKey = project.pbxGroupByName(projectName)
      ? project.findPBXGroupKey({ name: projectName })
      : project.findPBXGroupKey({ path: projectName });
    for (const file of NATIVE_FILES.ios) {
      const present = Object.values(fileRefs).some((f) => typeof f === 'object' && f && f.name === file);
      if (!present) project.addSourceFile(`${projectName}/${file}`, null, groupKey);
    }
    return config;
  });

  config = withEntitlementsPlist(config, (config) => {
    const groups = Array.isArray(config.modResults['keychain-access-groups'])
      ? config.modResults['keychain-access-groups']
      : [];
    if (!groups.includes(KEYCHAIN_ACCESS_GROUP)) groups.push(KEYCHAIN_ACCESS_GROUP);
    config.modResults['keychain-access-groups'] = groups;
    return config;
  });

  return config;
}

function withCloudKeychainSyncAndroid(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const kotlinDir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/java/com/provian/wallet');
      fs.mkdirSync(kotlinDir, { recursive: true });
      for (const file of NATIVE_FILES.android) {
        fs.writeFileSync(path.join(kotlinDir, file), readNative('android', file));
      }

      const mainAppPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppPath)) {
        const content = fs.readFileSync(mainAppPath, 'utf8');
        if (!content.includes('ProvianCloudKeychainSyncPackage')) {
          fs.writeFileSync(
            mainAppPath,
            content.replace(/PackageList\(this\)\.packages\.apply\s*\{[^}]*\}/, (match) =>
              match.replace(/\}$/, '              add(ProvianCloudKeychainSyncPackage())\n            }'),
            ),
          );
        }
      }
      return config;
    },
  ]);

  config = withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('google-api-services-drive')) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n${ANDROID_DEPENDENCIES}`,
      );
    }
    return config;
  });

  return config;
}

module.exports = function withCloudKeychainSync(config) {
  config = withCloudKeychainSyncIOS(config);
  config = withCloudKeychainSyncAndroid(config);
  return config;
};
module.exports.NATIVE_FILES = NATIVE_FILES;
