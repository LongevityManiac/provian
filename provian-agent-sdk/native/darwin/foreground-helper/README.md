# ProvianForegroundHelper (macOS)

Native helper that observes AI-app foreground activity and streams line-delimited JSON events to stdout. Spawned as a child process by the TS `HelperBridge` in the LLM session plugin.

## Current scope (4.5)

| Capability | Status |
|------------|--------|
| `NSWorkspace` activation → `foreground_changed` | ✅ (4.2) |
| Initial `permission_status` baseline | ✅ (4.2) |
| AX trust probe (real `accessibility` value) | ✅ (4.3) |
| AX-based browser URL extraction for Safari / Chrome / Edge / Firefox / Arc | ✅ (4.3) |
| `permission_status` re-emit on trust transition | ✅ (4.3, on activation + 30s poll) |
| `CGEventTap` for keystrokes and mouse clicks (100 ms coalescing) | ✅ (4.4) |
| Input Monitoring probe (real `input_monitoring` value) | ✅ (4.4) |
| `AXObserver` tab-switch / navigation detection | ✅ (4.4) |
| URL-dedup so page-load multi-fires don't flood the bridge | ✅ (4.4) |
| `NSWorkspace` sleep/wake + Darwin screen lock/unlock | ✅ (4.5) |

## Identity

- `CFBundleIdentifier`: `ai.provian.foreground-helper` (pinned)
- Team ID (release signing, not used in dev): `L83XFY5S26` (pinned)

## Prerequisites

- macOS 11+ (Big Sur)
- Xcode Command Line Tools (`xcode-select --install`) or full Xcode

## Build

```
./build.sh
```

Output: `./ProvianForegroundHelper.app`, a **universal (arm64 + x86_64)** binary by default, so the one bundle runs on both Apple-silicon and Intel Macs. Ad-hoc signed (stable identity on one machine). Neither `build.sh` nor `build-foreground-helpers.yml` applies hardened runtime or notarization; the packaged helper is this ad-hoc-signed build.

Cross-compiling the x86_64 slice on an Apple-silicon host needs the full macOS SDK (Xcode / Command Line Tools). Override the arch set for a faster single-arch dev build:

```
HELPER_ARCHS=arm64 ./build.sh
```

## Granting permissions (dev)

The helper needs two macOS permissions for full capture:

| Permission | Enables | Behavior when denied |
|------------|---------|----------------------|
| Accessibility | Browser URL extraction + tab-switch detection via AXObserver | `permission_status.accessibility: false`, `browser_url: null` on all events |
| Input Monitoring | CGEventTap for keystroke + click events | `permission_status.input_monitoring: false`, no `input_event` emissions (plugin falls into `presence_only` mode downstream) |

Sleep/wake and lock/unlock detection require **no** permissions.

To grant for a local dev build:

1. Build (`./build.sh`).
2. Launch the helper once: `./ProvianForegroundHelper.app/Contents/MacOS/ProvianForegroundHelper` (Ctrl-C to stop).
3. Open **System Settings → Privacy & Security**.
4. Under **Accessibility**, click **+**, navigate to `ProvianForegroundHelper.app`, add and toggle on.
5. Under **Input Monitoring**, repeat the same.
6. Relaunch the helper.

The helper probes both permissions on every foreground activation and on a 30-second background poll. Transitions (granted → denied, denied → granted) emit a new `permission_status` line. When Input Monitoring flips on after launch, the event tap starts automatically; when it flips off, the tap stops.

## Event schema (4.5 subset)

```
{"t":"permission_status","ts":<ms>,"accessibility":<bool>,"input_monitoring":<bool>}
{"t":"foreground_changed","ts":<ms>,"app":{"bundle_id":<string|null>,"process_name":<string|null>},"browser_url":<string|null>}
{"t":"input_event","ts":<ms>}
{"t":"system_state","ts":<ms>,"state":"sleep"|"wake"|"lock"|"unlock"}
```

### input_event

Carries only a timestamp. No keycode, no modifiers, no content. Coalesced at 100 ms in the helper: one emit per 100 ms gap between callbacks, so a held key or a fast click burst produces one event instead of dozens. The state machine's 10-second turn-gap clustering means per-event vs 100 ms-coalesced output produces identical turn counts and active durations in realistic typing patterns.

### foreground_changed

Emitted:
- On `NSWorkspace.didActivateApplicationNotification` (user switches apps).
- On `AXTitleChangedNotification` within the currently-foreground browser window (tab switch or page navigation). Suppressed when URL extraction returns null (transient AX states during window re-render).
- On `AXFocusedWindowChangedNotification` within the browser's application element (user switches between browser windows).

Consecutive duplicate URLs are debounced. A single page load that triggers multiple AX notifications (`"" → "Loading..." → actual title`) emits one `foreground_changed` with the final URL.

### system_state

Sleep and wake come from `NSWorkspace.willSleepNotification` and `NSWorkspace.didWakeNotification`. Reliable on all supported macOS versions.

Lock and unlock come from Darwin distributed notifications. The helper subscribes to two name pairs so both the traditional lock path and the screensaver path are covered:

| Source | Emits as |
|--------|----------|
| `com.apple.screenIsLocked` | `system_state: lock` |
| `com.apple.screensaver.didstart` | `system_state: lock` |
| `com.apple.screenIsUnlocked` | `system_state: unlock` |
| `com.apple.screensaver.didstop` | `system_state: unlock` |

On modern macOS (14+), some lock paths (notably Ctrl-Cmd-Q) do **not** post any of these Darwin notifications. In that case the state machine still terminates the session cleanly via the closing-window fallback: `com.apple.loginwindow` becomes the foreground process when the screen locks, which the TS plugin maps to "no provider", which triggers a `foreground_changed(null)` → 60-second closing grace → session end. The explicit `system_state: lock` event just shortens that to an immediate end when the OS does emit it.

### Supported browser bundle IDs

| Browser | Bundle ID |
|---------|-----------|
| Safari | `com.apple.Safari` |
| Google Chrome | `com.google.Chrome` |
| Microsoft Edge | `com.microsoft.Edge`, `com.microsoft.edgemac` |
| Firefox | `org.mozilla.firefox` |
| Arc | `company.thebrowser.Browser` |

## Local validation (4.5)

Performed during 4.4 and 4.5 development (Darwin 25.2.0, Swift 6.2.3, both permissions granted in the test environment):

- `./build.sh` produces an ad-hoc signed `.app` that passes `codesign --verify`.
- Helper launched, `permission_status` emitted: `{accessibility: true, input_monitoring: true}`.
- Chrome navigated between URLs → AXObserver fired, `foreground_changed` emitted with updated URLs; page-load multi-fires collapsed by dedup.
- Chrome profile-picker modal in front of the browser produced `browser_url: null` on activation (correct; focused window is the modal, not the page).
- 13 keystrokes in mixed burst + paced cadence produced 4 `input_event` lines (100 ms coalescing confirmed).
- All four `system_state` variants routed correctly via `notifyutil -p <name>` injection:
  - `com.apple.screenIsLocked` → `state: lock`
  - `com.apple.screenIsUnlocked` → `state: unlock`
  - `com.apple.screensaver.didstart` → `state: lock`
  - `com.apple.screensaver.didstop` → `state: unlock`
- Ctrl-Cmd-Q screen-lock shortcut confirmed to switch `com.apple.loginwindow` into foreground (indirect lock signal, captured by the NSWorkspace observer) but did not post any of the four Darwin notifications on this macOS version. Documented above under "system_state".

Mechanisms not fully exercised:
- **`NSWorkspace.willSleepNotification` / `didWakeNotification`**: triggering actual system sleep is too disruptive to automate inside a shell session. Subscriptions are verified to install without error; the callback path is a direct `IpcEmitter.emitSystemState(state:)` call, same shape as the Darwin path that was verified end-to-end.
- **Permission denial paths** for AX and Input Monitoring: both grants were already active on the dev machine. Code paths are single if-guards.
- **Firefox, Edge, Arc**: not installed on the dev machine. AX extractors target documented paths; runtime verification deferred to 4.6.

## Known limitations

- **Modern macOS Ctrl-Cmd-Q lock**: does not post Darwin screen-lock notifications on some macOS 14+ versions. The TS plugin's closing-window fallback ends the session after 60 seconds instead of immediately.
- **Chromium AX description localization**: the omnibox match uses English substrings ("address", "url", "omnibox"). Non-English Chromium builds fall back to URL-plausibility matching.
- **Tab switch via OS "select tab" command** where the new tab's title is identical to the old: rare, but would not fire `AXTitleChangedNotification`.

## Run from the TS bridge

```ts
import { HelperBridge } from './src/observer/plugins/llm-session/ipc';

const bridge = new HelperBridge({
  binaryPath: '/abs/path/to/ProvianForegroundHelper.app/Contents/MacOS/ProvianForegroundHelper',
  logger: (level, msg, meta) => console.log(`[${level}] ${msg}`, meta ?? ''),
});
bridge.start();

setInterval(() => {
  for (const ev of bridge.drain()) console.log('event:', ev);
}, 1000);
```

## Scope growth

| Sub-step | Adds |
|----------|------|
| 4.2 | `NSWorkspace` activation, baseline `permission_status`. |
| 4.3 | Accessibility probe, AX URL extraction, 30s permission poller. |
| 4.4 | `CGEventTap` with 100 ms coalescing, Input Monitoring probe, `AXObserver` tab/navigation detection, URL dedup. |
| 4.5 (this) | `NSWorkspace` sleep/wake + Darwin lock/unlock via four notification names. |
| 4.6 | Windows C# helper + cross-OS test matrix. |

## Testing

No Swift-side unit tests in the 4.2-4.5 range. The TS bridge tests in `provian-agent-sdk/src/observer/plugins/llm-session/ipc.test.ts` cover the IPC contract. Swift helper tests land in 4.6 when the OS-bridge test matrix is introduced.

## Signing, notarization, Gatekeeper

Out of step 4 scope. Release-time signing with Team ID `L83XFY5S26`, hardened runtime, notarization, and stapling are not done by `build.sh` or by any workflow in this repository: `build-foreground-helpers.yml` packages the ad-hoc-signed bundle `build.sh` produces.

`build.sh` runs `codesign --force --sign -` at the end for ad-hoc signing. This gives the binary a stable identity on one machine so permissions granted in System Settings survive rebuilds. Ad-hoc signed binaries still trigger Gatekeeper on the double-click path; running the inner binary from a terminal is the fastest dev workflow.
