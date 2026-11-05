/**
 * Expo config plugin that restores ProvianSecureEnclaveP256 native modules
 * after `expo prebuild --clean` wipes the native directories.
 *
 * iOS: Adds ProvianSecureEnclaveP256.swift +.m bridge to the Xcode project.
 * Android: Adds ProvianSecureEnclaveP256Module.kt + Package.kt and registers
 * the package in MainApplication.kt (withBiometric adds the biometric
 * dependency).
 *
 * The sources are the committed files under `plugins/native/` one copy, read
 * at prebuild time. The plugin used to embed its own copy of each source as a
 * string, which drifted: it lacked `getKeyBacking` (the StrongBox-vs-TEE split),
 * the frictionLevel allowlist and biometric-enrollment invalidation, so a
 * `prebuild --clean` would have silently downgraded the shipped module.
 * `scripts/native-plugin-sources.test.mjs` pins `plugins/native/` byte-identical to the
 * committed `ios/` and `android/` trees.
 */
const {
  withDangerousMod,
  withXcodeProject,
  withAppBuildGradle,
  withMainApplication,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NATIVE_DIR = path.join(__dirname, 'native');
const readNative = (platform, file) => fs.readFileSync(path.join(NATIVE_DIR, platform, file), 'utf8');

/** Files this plugin writes: platform → [source file in plugins/native/<platform>/]. */
const NATIVE_FILES = {
  ios: ['ProvianSecureEnclaveP256.swift', 'ProvianSecureEnclaveP256.m'],
  android: ['ProvianSecureEnclaveP256Module.kt', 'ProvianSecureEnclaveP256Package.kt'],
};

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

function withSecureEnclaveIOS(config) {
  // Write Swift + ObjC files to ios/<projectName>/
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName || 'Provian';
      const iosDir = path.join(config.modRequest.platformProjectRoot, projectName);

      fs.mkdirSync(iosDir, { recursive: true });
      for (const file of NATIVE_FILES.ios) {
        fs.writeFileSync(path.join(iosDir, file), readNative('ios', file));
      }

      // Ensure bridging header imports React
      const bridgingHeader = path.join(iosDir, `${projectName}-Bridging-Header.h`);
      const headerContent = fs.existsSync(bridgingHeader)
        ? fs.readFileSync(bridgingHeader, 'utf8')
        : '';
      if (!headerContent.includes('RCTBridgeModule.h')) {
        fs.writeFileSync(
          bridgingHeader,
          `//\n// Use this file to import your target\'s public headers that you would like to expose to Swift.\n//\n#import <React/RCTBridgeModule.h>\n`
        );
      }

      return config;
    },
  ]);

  // Add files to Xcode project
  config = withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectName = config.modRequest.projectName || 'Provian';

    const swiftFile = `ProvianSecureEnclaveP256.swift`;
    const objcFile = `ProvianSecureEnclaveP256.m`;

    // Check if files are already referenced
    const fileRefs = project.pbxFileReferenceSection();
    const hasSwift = Object.values(fileRefs).some(
      (f) => typeof f === 'object' && f && f.name === swiftFile
    );
    const hasObjc = Object.values(fileRefs).some(
      (f) => typeof f === 'object' && f && f.name === objcFile
    );

    const groupKey = project.pbxGroupByName(projectName)
      ? project.findPBXGroupKey({ name: projectName })
      : project.findPBXGroupKey({ path: projectName });

    if (!hasSwift) {
      project.addSourceFile(`${projectName}/${swiftFile}`, null, groupKey);
    }
    if (!hasObjc) {
      project.addSourceFile(`${projectName}/${objcFile}`, null, groupKey);
    }

    return config;
  });

  return config;
}

function withSecureEnclaveAndroid(config) {
  // Write Kotlin files
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const kotlinDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java/com/provian/wallet'
      );

      fs.mkdirSync(kotlinDir, { recursive: true });
      for (const file of NATIVE_FILES.android) {
        fs.writeFileSync(path.join(kotlinDir, file), readNative('android', file));
      }

      // Register package in MainApplication.kt
      const mainAppPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppPath)) {
        let content = fs.readFileSync(mainAppPath, 'utf8');
        if (!content.includes('ProvianSecureEnclaveP256Package')) {
          content = content.replace(
            /PackageList\(this\)\.packages\.apply\s*\{[^}]*\}/,
            (match) =>
              match.replace(
                /\}$/,
                '              add(ProvianSecureEnclaveP256Package())\n            }'
              )
          );
          fs.writeFileSync(mainAppPath, content);
        }
      }

      return config;
    },
  ]);

  return config;
}

module.exports = function withSecureEnclave(config) {
  config = withSecureEnclaveIOS(config);
  config = withSecureEnclaveAndroid(config);
  return config;
};
module.exports.NATIVE_FILES = NATIVE_FILES;
