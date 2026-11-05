/**
 * Expo config plugin: the Android RELEASE build settings the committed android/ tree carries,
 * so `expo prebuild --clean` regenerates them instead of silently dropping them (L326).
 *
 * Without it a clean prebuild hands back Expo's template, which
 * - signs the release build with the DEBUG keystore and has no guard against doing so
 * (Provian never debug-signs a release artifact — the launch keystore is read from
 * the gitignored android/keystore.properties, never from argv or a build log), and
 * - turns AAPT2 PNG crunching back on, which aborts mergeReleaseResources on the JPEG-in-.png
 * assets.
 *
 * The inserted text is the committed android/app/build.gradle and android/gradle.properties text,
 * byte for byte. Every insertion is anchored on the template; an anchor that is missing THROWS —
 * a template change must fail the prebuild, never yield a release build without the launch key.
 * Re-running on an already-patched file is a no-op.
 */
const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

const MARKER = 'def releaseKeystorePropsFile = rootProject.file("keystore.properties")';

const KEYSTORE_PROPS_BLOCK = `// Read the launch signing key from a gitignored keystore.properties (never
// committed, never passed on a command line, never dumped to a build log).
// This is the leak-free release-signing path: \`gradlew :app:assembleRelease\`
// reads the keystore from a FILE, so it never appears in \`ps\`/process args or
// in any tool's failed-build log. Contrast \`eas build --local\`, which hands the
// keystore + passwords to eas-cli-local-build-plugin as a single base64 CLI
// argument — visible in \`pgrep -fl\` and dumped verbatim into the plugin's log
// on a FAILED build. Build releases via
// scripts/build-android-release.sh; do not reintroduce eas for release.
${MARKER}
def hasReleaseKeystore = releaseKeystorePropsFile.exists()
def releaseKeystoreProps = new Properties()
if (hasReleaseKeystore) {
    releaseKeystorePropsFile.withInputStream { releaseKeystoreProps.load(it) }
}
`;

const RELEASE_SIGNING_CONFIG = `        release {
            // Populated only when keystore.properties is present. When absent,
            // this stays empty AND the release build is refused before it runs
            // (see the taskGraph guard below) — Provian never debug-signs a
            // release artifact.
            if (hasReleaseKeystore) {
                storeFile rootProject.file(releaseKeystoreProps.getProperty('storeFile'))
                storePassword releaseKeystoreProps.getProperty('storePassword')
                keyAlias releaseKeystoreProps.getProperty('keyAlias')
                keyPassword releaseKeystoreProps.getProperty('keyPassword')
            }
        }
`;

const TEMPLATE_RELEASE_SIGNING = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
`;

const LAUNCH_RELEASE_SIGNING = `            // ALWAYS the launch keystore — never a debug fallback. A release
            // build without android/keystore.properties is refused by the
            // taskGraph guard below (clear message, no artifact produced).
            signingConfig signingConfigs.release
`;

const RELEASE_GUARD = `// Refuse to build a RELEASE artifact without the launch keystore. This
// runs only when a release task is actually scheduled, so debug builds and
// config-only tasks (tasks, signingReport, help) on a dev machine are
// unaffected. It never falls back to debug signing — a release build either
// signs with the launch keystore from android/keystore.properties or fails.
gradle.taskGraph.whenReady { graph ->
    if (!hasReleaseKeystore) {
        def wantsRelease = graph.allTasks.any { t ->
            def n = t.name
            (n.startsWith('assemble') || n.startsWith('bundle') || n.startsWith('package') || n.startsWith('install')) && n.contains('Release')
        }
        if (wantsRelease) {
            throw new GradleException(
                "Release build refused: android/keystore.properties is missing.\\n" +
                "The launch keystore must be supplied via that gitignored file — " +
                "see scripts/build-android-release.sh. Provian never debug-signs a release artifact.")
        }
    }
}

`;

const DEBUG_SIGNING_END = `            keyPassword 'android'
        }
    }
    buildTypes {`;

const PACKAGING_OPTIONS_COMMENT = '// Apply static values from `gradle.properties` to the `android.packagingOptions`';

function replaceOnce(src, anchor, replacement, what) {
  const at = src.indexOf(anchor);
  if (at < 0 || src.indexOf(anchor, at + anchor.length) >= 0) {
    throw new Error(`withReleaseBuildConfig: build.gradle anchor for ${what} not found exactly once; refusing to emit a release build without the launch keystore`);
  }
  return src.slice(0, at) + replacement + src.slice(at + anchor.length);
}

/** Pure transform of the template app/build.gradle (exported for the plugin test). */
function applyReleaseSigning(src) {
  if (src.includes(MARKER)) return src;
  let out = replaceOnce(src, '\nandroid {\n', `\n${KEYSTORE_PROPS_BLOCK}\nandroid {\n`, 'the android block');
  out = replaceOnce(out, DEBUG_SIGNING_END,
    `            keyPassword 'android'\n        }\n${RELEASE_SIGNING_CONFIG}    }\n    buildTypes {`, 'the debug signing config');
  out = replaceOnce(out, TEMPLATE_RELEASE_SIGNING, LAUNCH_RELEASE_SIGNING, 'the release buildType signing');
  out = replaceOnce(out, PACKAGING_OPTIONS_COMMENT, RELEASE_GUARD + PACKAGING_OPTIONS_COMMENT, 'the release guard position');
  return out;
}

const PNG_CRUNCH_KEY = 'android.enablePngCrunchInReleaseBuilds';
const PNG_CRUNCH_COMMENT = [
  'AAPT2 PNG crunching is DISABLED for release builds.',
  'Many assets/images/*.png files are actually JPEG data saved with a .png',
  'extension (Leonardo-generated art). The release PNG cruncher parses them',
  'strictly and aborts mergeReleaseResources with "failed to read PNG signature".',
  'They are already compressed, so crunching adds nothing; --no-crunch ships them',
  'as-is and Android decodes them fine at runtime (BitmapFactory sniffs the format).',
];

/** Pure transform of the gradle.properties item list (exported for the plugin test). */
function applyPngCrunchOff(items) {
  const at = items.findIndex((i) => i.type === 'property' && i.key === PNG_CRUNCH_KEY);
  const property = { type: 'property', key: PNG_CRUNCH_KEY, value: 'false' };
  const comments = PNG_CRUNCH_COMMENT.map((value) => ({ type: 'comment', value }));
  if (at < 0) return [...items, ...comments, property];
  const out = items.slice();
  const hasTemplateComment = at > 0 && out[at - 1].type === 'comment'
    && out[at - 1].value.trim() === 'Enable AAPT2 PNG crunching';
  if (hasTemplateComment) out.splice(at - 1, 2, ...comments, property);
  else out.splice(at, 1, property);
  return out;
}

const withReleaseBuildConfig = (config) => {
  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withReleaseBuildConfig: app/build.gradle is not Groovy; refusing to guess the release signing');
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = applyPngCrunchOff(cfg.modResults);
    return cfg;
  });
  return config;
};

module.exports = withReleaseBuildConfig;
module.exports.applyReleaseSigning = applyReleaseSigning;
module.exports.applyPngCrunchOff = applyPngCrunchOff;
