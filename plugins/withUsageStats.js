/**
 * Expo config plugin that adds the ProvianUsageStats native module for
 * Android. Phase 2c M7. Enables the mobile wallet to observe
 * foreground time spent in AI chat apps (Claude, ChatGPT, Gemini,
 * Perplexity, Grok) via Android's UsageStatsManager. The permission
 * (android.permission.PACKAGE_USAGE_STATS) is protected; users must
 * grant it in system Settings, and the JS side opens that Settings
 * screen via Intent.ACTION_USAGE_ACCESS_SETTINGS.
 *
 * Three @ReactMethod functions:
 *   - hasUsageStatsPermission(promise): boolean, via AppOpsManager
 *   - openUsageStatsSettings(promise): true, via ACTION_USAGE_ACCESS_SETTINGS
 *   - queryAiAppUsage(rangeStartMs, rangeEndMs, packageNames, promise):
 *       array of { package_name, total_time_in_foreground_ms,
 *                  first_time_stamp_ms, last_time_stamp_ms }
 *
 * Timestamps cross the JS bridge as Double; internals use Long.
 *
 * Structural template: plugins/withPlayIntegrity.js. No gradle dep
 * needed; UsageStatsManager and AppOpsManager are in the Android SDK.
 */
const {
  withDangerousMod,
  withAndroidManifest,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Android Kotlin source
// ---------------------------------------------------------------------------

const USAGE_STATS_MODULE_KT = `package com.provian.wallet

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import com.facebook.react.bridge.*

/**
 * Native Android UsageStats module for Provian Wallet (Phase 2c M7).
 *
 * Metadata only. This module reports how long the user spent in
 * foreground AI chat apps. It never reads the content of any
 * conversation, screen contents, keystrokes, or anything inside the
 * apps themselves.
 */
class ProvianUsageStatsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ProvianUsageStats"

    @ReactMethod
    fun hasUsageStatsPermission(promise: Promise) {
        try {
            val appOps = reactApplicationContext
                .getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = appOps.checkOpNoThrow(
                "android:get_usage_stats",
                Process.myUid(),
                reactApplicationContext.packageName,
            )
            promise.resolve(mode == AppOpsManager.MODE_ALLOWED)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openUsageStatsSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val resolved = intent.resolveActivity(reactApplicationContext.packageManager)
            if (resolved == null) {
                promise.reject("NO_ACTIVITY", "Usage access settings not available on this device")
                return
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPEN_FAILED", "Could not open usage access settings: " + e.message, e)
        }
    }

    @ReactMethod
    fun queryAiAppUsage(
        rangeStartMs: Double,
        rangeEndMs: Double,
        packageNames: ReadableArray,
        promise: Promise,
    ) {
        try {
            val appOps = reactApplicationContext
                .getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = appOps.checkOpNoThrow(
                "android:get_usage_stats",
                Process.myUid(),
                reactApplicationContext.packageName,
            )
            if (mode != AppOpsManager.MODE_ALLOWED) {
                promise.reject("PERMISSION_DENIED", "PACKAGE_USAGE_STATS not granted")
                return
            }

            val allowed = HashSet<String>()
            for (i in 0 until packageNames.size()) {
                val item = packageNames.getString(i)
                if (item != null && item.isNotEmpty()) allowed.add(item)
            }

            val manager = reactApplicationContext
                .getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val stats = manager.queryUsageStats(
                UsageStatsManager.INTERVAL_DAILY,
                rangeStartMs.toLong(),
                rangeEndMs.toLong(),
            )
            val out = Arguments.createArray()
            if (stats != null) {
                for (s in stats) {
                    val pkg = s.packageName ?: continue
                    if (!allowed.contains(pkg)) continue
                    val entry = Arguments.createMap()
                    entry.putString("package_name", pkg)
                    entry.putDouble("total_time_in_foreground_ms", s.totalTimeInForeground.toDouble())
                    entry.putDouble("first_time_stamp_ms", s.firstTimeStamp.toDouble())
                    entry.putDouble("last_time_stamp_ms", s.lastTimeStamp.toDouble())
                    out.pushMap(entry)
                }
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("QUERY_FAILED", "UsageStats query failed: " + e.message, e)
        }
    }
}
`;

const USAGE_STATS_PACKAGE_KT = `package com.provian.wallet

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ProvianUsageStatsPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(ProvianUsageStatsModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

function withUsageStatsAndroid(config) {
  // Write Kotlin files
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const kotlinDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java/com/provian/wallet'
      );

      fs.mkdirSync(kotlinDir, { recursive: true });
      fs.writeFileSync(path.join(kotlinDir, 'ProvianUsageStatsModule.kt'), USAGE_STATS_MODULE_KT);
      fs.writeFileSync(path.join(kotlinDir, 'ProvianUsageStatsPackage.kt'), USAGE_STATS_PACKAGE_KT);

      // Register package in MainApplication.kt
      const mainAppPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppPath)) {
        let content = fs.readFileSync(mainAppPath, 'utf8');
        if (!content.includes('ProvianUsageStatsPackage')) {
          content = content.replace(
            /PackageList\(this\)\.packages\.apply\s*\{[^}]*\}/,
            (match) =>
              match.replace(
                /\}$/,
                '              add(ProvianUsageStatsPackage())\n            }'
              )
          );
          fs.writeFileSync(mainAppPath, content);
        }
      }

      return config;
    },
  ]);

  // Ensure PACKAGE_USAGE_STATS permission is declared with tools:ignore.
  // The permission is protected; it cannot be added via the standard
  // app.json permissions array.
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // Ensure xmlns:tools is declared on the manifest root.
    if (!manifest.$) manifest.$ = {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }

    const already = manifest['uses-permission'].some(
      (p) => p.$ && p.$['android:name'] === 'android.permission.PACKAGE_USAGE_STATS'
    );
    if (!already) {
      manifest['uses-permission'].push({
        $: {
          'android:name': 'android.permission.PACKAGE_USAGE_STATS',
          'tools:ignore': 'ProtectedPermissions',
        },
      });
    }

    return mod;
  });

  return config;
}

module.exports = function withUsageStats(config) {
  config = withUsageStatsAndroid(config);
  return config;
};
