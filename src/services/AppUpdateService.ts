import { translate } from '../i18n/translate';
/**
 * AppUpdateService — checks whether a newer Android APK is available and nudges
 * the user to download it. The website APK only: iOS updates through the App Store and the Play
 * build through Google Play, so neither ever checks (`config/distribution.ts`).
 *
 * Wires the pure decision logic in `appUpdate.ts` to the device (installed
 * versionCode via expo-application), the network (a version manifest served
 * publicly at provian.ai/.well-known), and the UI (a best-effort Alert that
 * deep-links to the gated /download page). Never throws; a failed check is a
 * no-op so it can never block or crash a non-custodial wallet.
 *
 * See appUpdate.ts for why this is a download-the-signed-APK flow and NOT an
 * over-the-air JS update.
 */
import { Platform, Alert, Linking } from 'react-native';
import * as Application from 'expo-application';
import {
  evaluateUpdate,
  parseVersionManifest,
  type UpdateDecision,
} from './appUpdate';
import { appDistribution } from '../config/distribution';

// Public, un-authenticated (served via the site's /.well-known carve-out so the
// app can read it even while the rest of the site is behind Basic Auth).
const VERSION_MANIFEST_URL = 'https://provian.ai/.well-known/provian-app-version.json';
const FETCH_TIMEOUT_MS = 6000;

class AppUpdateService {
  /**
   * Installed Android versionCode, or null when there is nothing to check: not Android, or a store
   * build (Google Play updates it; it must never be sent to the website APK).
   */
  private getInstalledVersionCode(): number | null {
    if (Platform.OS !== 'android' || appDistribution() !== 'website') return null;
    // On Android, nativeBuildVersion is the integer versionCode as a string.
    const raw = Application.nativeBuildVersion;
    const n = raw != null ? Number.parseInt(String(raw), 10) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }

  private async fetchManifest(): Promise<ReturnType<typeof parseVersionManifest>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(VERSION_MANIFEST_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      return parseVersionManifest(json);
    } catch {
      // Offline / timeout / bad JSON → treat as "no update info" (never nag).
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the current update state. Best-effort: any failure → `up_to_date`.
   * Android-only; returns `up_to_date` on iOS/web.
   */
  async checkForUpdate(): Promise<UpdateDecision> {
    const installed = this.getInstalledVersionCode();
    if (installed == null) return { kind: 'up_to_date' };
    const manifest = await this.fetchManifest();
    return evaluateUpdate(installed, manifest);
  }

  private openDownload(url: string): void {
    Linking.openURL(url).catch(() => {
      // Best-effort; if the browser can't open we simply do nothing.
    });
  }

  /**
   * Check and, if a newer APK exists, prompt the user.
   *  - auto (default): silent when up-to-date; a one-time Alert when behind.
   *  - manual (Settings button): also confirms "you're up to date".
   * Returns the decision so callers can react/telemetry if desired.
   */
  async promptIfUpdate(opts: { manual?: boolean } = {}): Promise<UpdateDecision> {
    let decision: UpdateDecision;
    try {
      decision = await this.checkForUpdate();
    } catch {
      return { kind: 'up_to_date' };
    }

    if (decision.kind === 'up_to_date') {
      if (opts.manual) {
        Alert.alert(
          translate('appUpdate.upToDateTitle', "You're up to date"),
          translate('appUpdate.upToDateBody', `Provian ${Application.nativeApplicationVersion ?? ''} is the latest version.`.trim(), { version: Application.nativeApplicationVersion ?? '' }),
        );
      }
      return decision;
    }

    const whatsNew = decision.notes ? `\n\n${decision.notes}` : '';

    if (decision.kind === 'update_required') {
      // Strong, non-dismissible nudge for a critical (e.g. security) update.
      // NOT a hard brick: the wallet stays usable so funds/recovery are always
      // reachable — we re-offer the download but never trap the user.
      Alert.alert(
        translate('appUpdate.requiredTitle', 'Update required'),
        translate('appUpdate.requiredBody', `A newer, required version of Provian (${decision.latestVersionName}) is available. Please update to keep your wallet secure.${whatsNew}`, { version: decision.latestVersionName, notes: whatsNew }),
        [{ text: translate('appUpdate.downloadUpdate', 'Download update'), onPress: () => this.openDownload(decision.downloadUrl) }],
        { cancelable: false },
      );
      return decision;
    }

    // update_available — dismissible.
    Alert.alert(
      translate('appUpdate.availableTitle', 'Update available'),
      translate('appUpdate.availableBody', `Provian ${decision.latestVersionName} is available to download.${whatsNew}`, { version: decision.latestVersionName, notes: whatsNew }),
      [
        { text: translate('appUpdate.later', 'Later'), style: 'cancel' },
        { text: translate('appUpdate.download', 'Download'), onPress: () => this.openDownload(decision.downloadUrl) },
      ],
    );
    return decision;
  }
}

export default new AppUpdateService();
