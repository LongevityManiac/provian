# ProvianForegroundHelper (Windows)

Native helper that observes AI-app foreground activity on Windows and streams line-delimited JSON events to stdout. Spawned as a child process by the TS `HelperBridge` in the LLM session plugin, exactly like the macOS helper. Same IPC contract, same plugin, same `ai_conversation` PE with `surface=desktop_foreground`.

This is the Windows counterpart of `native/darwin/foreground-helper` (Swift). The two helpers are interchangeable from the observer's perspective: `LLMSessionPlugin.resolveHelperBinaryPath` picks the right one per platform and `HelperBridge` spawns it.

## Capability map

| Capability | Mechanism | Status |
|------------|-----------|--------|
| Foreground app change → `foreground_changed` | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` | ✅ |
| Process-name resolution (native AI apps) | `GetWindowThreadProcessId` → `Process.ProcessName` | ✅ |
| Browser tab URL extraction | UI Automation address-bar `ValuePattern` | ✅ |
| Keystroke / click / wheel input → `input_event` | `WH_KEYBOARD_LL` + `WH_MOUSE_LL` (250 ms coalescing) | ✅ |
| Sleep / wake → `system_state` | `SystemEvents.PowerModeChanged` | ✅ |
| Lock / unlock → `system_state` | `SystemEvents.SessionSwitch` | ✅ |
| Baseline `permission_status` | emitted at startup | ✅ |

`bundle_id` is always `null` on Windows (no bundle-identifier concept). Native AI desktop apps are matched by `process_name` against the catalog's `surface_match.process_names`; browser usage is matched by `browser_url` against `browser_url_patterns`. Both fields are already in the shared `ai-providers.json`.

## Prerequisites

- Windows 10 / 11 (x64)
- .NET 8 SDK (`dotnet --version` ≥ 8.0)

## Build

```powershell
pwsh ./build.ps1
```

Output: `./publish/ProvianForegroundHelper.exe` (self-contained single file; no .NET runtime needed on the target). The script also stages a copy into `<sdk>/bin/helpers/win32/` so the SDK tarball ships it and `scripts/postinstall-helper.js` copies it to `~/.provian/helpers/win32/` on install.

For a raw publish without staging:

```powershell
dotnet publish -c Release -r win-x64 -o publish
```

## Permissions

Unlike macOS, Windows requires **no** TCC-style grant for any of these APIs in an interactive desktop session:

- `SetWinEventHook` for foreground changes - no grant.
- `WH_KEYBOARD_LL` / `WH_MOUSE_LL` low-level hooks - no grant for same-session, same-or-lower integrity processes.
- UI Automation reads of the focused window's address bar - no grant.
- `SystemEvents` power/session notifications - no grant.

So the helper emits `permission_status` with `accessibility: true, input_monitoring: true` at startup. If a low-level hook fails to install (e.g. a more restrictive session or UIPI against an elevated foreground app), `InputWatcher` emits an `error` event; foreground + system-state capture continues regardless.

## Event schema

Byte-identical to the macOS helper (validated at the TS IPC boundary in `ipc.ts`):

```
{"t":"permission_status","ts":<ms>,"accessibility":<bool>,"input_monitoring":<bool>}
{"t":"foreground_changed","ts":<ms>,"app":{"bundle_id":null,"process_name":<string|null>},"browser_url":<string|null>}
{"t":"input_event","ts":<ms>}
{"t":"system_state","ts":<ms>,"state":"sleep"|"wake"|"lock"|"unlock"}
{"t":"error","ts":<ms>,"message":<string>}
{"t":"fatal","ts":<ms>,"message":<string>}
```

### `input_event`

Carries only a timestamp. No keycode, no modifiers, no coordinates, no content. Key-down, mouse button-down, and wheel only - key-up, mouse-up, and raw mouse-move are ignored. Coalesced at 250 ms: one emit per 250 ms window. The state machine's 10-second turn-gap clustering makes per-event vs 250 ms-coalesced output produce identical turn counts and active durations for realistic typing.

### `foreground_changed`

Emitted on `EVENT_SYSTEM_FOREGROUND` (app/window switch) and once at startup for the current foreground window. Consecutive duplicate `HWND`s are coalesced. For browsers, the focused window's address-bar URL is read via UI Automation; bare hosts (no scheme) are normalized to `https://` so the TS `new URL` matcher accepts them; non-http schemes (`chrome://`, `about:`, `edge://`) and search terms return `null`.

### `system_state`

| Source | Emits as |
|--------|----------|
| `PowerModes.Suspend` | `sleep` |
| `PowerModes.Resume` | `wake` |
| `SessionLock` / `SessionLogoff` / `RemoteDisconnect` | `lock` |
| `SessionUnlock` / `SessionLogon` / `RemoteConnect` | `unlock` |

When the OS does not emit a lock event, the TS plugin's closing-window fallback still ends the session: locking switches the foreground to `LockApp`/login UI, which maps to "no provider" → `foreground_changed`(no match) → closing grace → session end. The explicit `lock` event just shortens that to an immediate end.

## Supported browsers (URL extraction)

`chrome`, `msedge`, `firefox`, `brave`, `opera`, `vivaldi`, `arc` (matched by process basename). Chromium browsers and Firefox both expose the address bar as an `Edit` control with a `ValuePattern`; Firefox occasionally exposes it via the element `Name` instead, which is also handled.

## Run from the TS bridge (manual smoke test)

```ts
import { HelperBridge } from '../../../src/observer/plugins/llm-session/ipc';

const bridge = new HelperBridge({
  binaryPath: 'C:\\path\\to\\publish\\ProvianForegroundHelper.exe',
  logger: (level, msg, meta) => console.log(`[${level}] ${msg}`, meta ?? ''),
});
bridge.start();
setInterval(() => { for (const ev of bridge.drain()) console.log('event:', ev); }, 1000);
```

## Build / verification status

The TypeScript wiring (platform gating, helper-path resolution, process-name provider matching, observer registration, postinstall copy) is unit-tested in `src/observer/plugins/llm-session/LLMSessionPlugin.test.ts` and runs cross-platform under Vitest.

The native binary must be compiled and exercised on a Windows host or Windows CI runner - it cannot be built on the macOS/Linux dev machines used for the rest of the SDK. CI step: `dotnet publish -c Release -r win-x64` then run the helper and assert the four event shapes against a live Chrome + native Claude app. This live OS-bridge matrix is the same gap the macOS README notes for sleep/wake and uninstalled browsers.

## Signing

Authenticode signing (certificate + RFC-3161 timestamp) and SmartScreen reputation are not done by `build.ps1` or by any workflow in this repository: `build-foreground-helpers.yml` packages the unsigned `build.ps1` output. Unsigned builds run fine when spawned with piped stdio by the observer; SmartScreen only gates interactive double-launch, which is not how the helper is started.
