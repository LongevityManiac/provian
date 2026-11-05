/**
 * Expo config plugin that adds ProvianPlayIntegrity native module for Android.
 *
 * Wraps Google Play Integrity API to:
 * - requestIntegrityToken(): Get an integrity verdict token for a nonce
 * - isSupported(): Check if Play Integrity is available
 */
const {
  withDangerousMod,
  withAppBuildGradle,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Android Kotlin source
// ---------------------------------------------------------------------------

const PLAY_INTEGRITY_MODULE_KT = `package com.provian.wallet

import com.facebook.react.bridge.*
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest

/**
 * Native Play Integrity module for Provian Wallet.
 *
 * Calls the Google Play Integrity API and returns the integrity verdict token
 * for server-side verification.
 */
class ProvianPlayIntegrityModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ProvianPlayIntegrity"

    @ReactMethod
    fun isSupported(promise: Promise) {
        try {
            // Play Integrity is available on devices with Google Play Services
            val pm = reactApplicationContext.packageManager
            val hasGPS = pm.hasSystemFeature("com.google.android.feature.GOOGLE_EXPERIENCE")
                || try { pm.getPackageInfo("com.google.android.gms", 0); true } catch (e: Exception) { false }
            promise.resolve(hasGPS)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestIntegrityToken(nonce: String, promise: Promise) {
        try {
            val integrityManager = IntegrityManagerFactory.create(reactApplicationContext)

            val integrityTokenRequest = IntegrityTokenRequest.builder()
                .setNonce(nonce)
                .build()

            integrityManager.requestIntegrityToken(integrityTokenRequest)
                .addOnSuccessListener { response ->
                    promise.resolve(response.token())
                }
                .addOnFailureListener { e ->
                    promise.reject(
                        "INTEGRITY_ERROR",
                        "Play Integrity request failed: \${e.message}",
                        e
                    )
                }
        } catch (e: Exception) {
            promise.reject("INTEGRITY_ERROR", "Play Integrity setup failed: \${e.message}", e)
        }
    }
}
`;

const PLAY_INTEGRITY_PACKAGE_KT = `package com.provian.wallet

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ProvianPlayIntegrityPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(ProvianPlayIntegrityModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

function withPlayIntegrityAndroid(config) {
  // Write Kotlin files
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const kotlinDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java/com/provian/wallet'
      );

      fs.mkdirSync(kotlinDir, { recursive: true });
      fs.writeFileSync(path.join(kotlinDir, 'ProvianPlayIntegrityModule.kt'), PLAY_INTEGRITY_MODULE_KT);
      fs.writeFileSync(path.join(kotlinDir, 'ProvianPlayIntegrityPackage.kt'), PLAY_INTEGRITY_PACKAGE_KT);

      // Register package in MainApplication.kt
      const mainAppPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppPath)) {
        let content = fs.readFileSync(mainAppPath, 'utf8');
        if (!content.includes('ProvianPlayIntegrityPackage')) {
          content = content.replace(
            /PackageList\(this\)\.packages\.apply\s*\{[^}]*\}/,
            (match) =>
              match.replace(
                /\}$/,
                '              add(ProvianPlayIntegrityPackage())\n            }'
              )
          );
          fs.writeFileSync(mainAppPath, content);
        }
      }

      return config;
    },
  ]);

  // Add Play Integrity dependency
  config = withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('play-integrity')) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*\{/,
        'dependencies {\n    implementation("com.google.android.play:integrity:1.4.0")'
      );
    }
    return config;
  });

  return config;
}

module.exports = function withPlayIntegrity(config) {
  config = withPlayIntegrityAndroid(config);
  return config;
};
