# Push Notifications Setup Guide

> **Location note:** This setup guide lives in `docs/setup/`. It documents the one-time configuration completed during initial infrastructure setup.

This guide walks you through setting up production push notifications for Provian Wallet.

> **Delivery is dual-transport.** The mobile app registers an **Expo** push token (`ExponentPushToken[...]`). The backend routes every push through a single dispatcher (`provian-backend/src/core/notifications/pushDispatcher.ts`) that inspects each stored token: Expo tokens go to the **Expo push service** (via `expo-server-sdk`), and native FCM tokens go through **Firebase Admin FCM**. See ["Backend push delivery (dispatcher)"](#backend-push-delivery-dispatcher) below. Firebase/FCM is still required (Expo delivers Android via FCM under the hood, and native tokens go straight to FCM), so complete the Firebase steps regardless.

The backend uses Firebase Admin SDK with **Application Default Credentials (ADC)**, which on Cloud Run authenticates via the runtime service account through the metadata server. **No `firebase-admin-key.json` is shipped, mounted, or referenced in production.** Service-account JSON keys are a Google-flagged anti-pattern (see `cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys`); the production stack uses Workload Identity instead.

The relevant code is in `provian-backend/src/server.ts` (the `admin.initializeApp` call near the top of the file):

```ts
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId,
});
```

`applicationDefault` reads:

  1. The Cloud Run runtime service account (production) via the GCE metadata server.
  2. The `GOOGLE_APPLICATION_CREDENTIALS` env var (local dev only, optional).
  3. `gcloud auth application-default` user credentials (local dev fallback).

In all three cases the calling code is identical. Production never sees a key file.

## Prerequisites

- Apple Developer Account ($99/year), for iOS
- Google Cloud / Firebase project (free tier is fine), for Android + backend FCM
- EAS CLI installed: `npm install -g eas-cli`
- `gcloud` CLI authenticated against the Firebase / GCP project

## Step 1: Create Expo Account & Project

```bash
# Login to Expo
eas login

# Link project (run from project root)
eas init
```

This creates a project ID. Update `app.json`:

```json
"extra": {
  "eas": {
    "projectId": "your-project-id-here"
  }
}
```

## Step 2: Configure iOS Push Notifications (APNs)

### Option A: Let EAS handle it (Recommended)

```bash
eas credentials
# Select iOS > Production > Push Notifications
# Choose "Let EAS create a new key"
```

### Option B: Manual setup

1. Go to [Apple Developer Portal](https://developer.apple.com).
2. Create an APNs Key:
   - Certificates, Identifiers & Profiles > Keys
   - Create new key with "Apple Push Notifications service (APNs)"
   - Download the `.p8` file
3. Upload to EAS:
   ```bash
   eas credentials
   # Select iOS > Production > Push Notifications > Upload
   ```

## Step 3: Configure Firebase (Android + Backend FCM)

### 3.1 Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com).
2. Create a new project, or attach Firebase to an existing GCP project. The production project is `provian-ai`; the same project hosts Cloud Run, Firestore, and FCM.
3. Add an Android app with package name `com.provian.wallet`.
4. Download `google-services.json` and place it at `config/firebase/google-services.json` (the path `app.json` → `android.googleServicesFile` names). This file ships with the client app build (it identifies the Firebase project to the device SDK) and is committed to the repo. **It is not a credential and contains no secrets.**

### 3.2 Grant the Cloud Run runtime service account FCM access

Firebase Admin SDK on the backend needs the runtime service account to have FCM send permissions. Identify the service account that `provian-api` runs under:

```bash
gcloud run services describe provian-api \
  --region us-central1 \
  --project provian-ai \
  --format='value(spec.template.spec.serviceAccountName)'
```

**Current state (re-checked 2026-09-23):** `provian-api` runs as the default Compute Engine SA on `provian-ai` (`185909722463-compute@developer.gserviceaccount.com`). FCM access is granted to that default SA. The dedicated-runtime-SA pattern below is the recommended migration when the API needs scoped IAM beyond what the default SA provides - but it has not yet been executed.

If you're following the recommended pattern (creating a dedicated SA):

```bash
# Create a dedicated runtime SA (the dedicated-SA-per-workload pattern;
# formerly exemplified by the anchor-recovery Cloud Run Job, retired 2026-08-16 —
# its frozen yaml under provian-backend/cloudrun/ is historical evidence only).
# Pick a descriptive name; example below.
gcloud iam service-accounts create <runtime-sa-name> \
  --display-name "Provian API Cloud Run runtime" \
  --project provian-ai

RUNTIME_SA="<runtime-sa-name>@provian-ai.iam.gserviceaccount.com"
```

If you're staying on the default compute SA:

```bash
RUNTIME_SA="185909722463-compute@developer.gserviceaccount.com"
```

Grant the runtime SA the roles needed by the backend. The Firebase Admin SDK consumes Firestore + FCM; both roles are scoped to the project.

```bash
PROJECT=provian-ai

# Send FCM messages.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/firebasecloudmessaging.serviceAgent"

# Read/write Firestore.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/datastore.user"

# Read secrets (the settlement signers and the other managed keys are Secret Manager backed).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor"
```

Pin the SA to the Cloud Run service:

```bash
gcloud run services update provian-api \
  --region us-central1 \
  --project provian-ai \
  --service-account "$RUNTIME_SA"
```

This is a one-time operation. Subsequent deploys keep the same runtime SA and never need to re-set it.

### 3.3 Add iOS to Firebase

1. Firebase Console > Add app > iOS.
2. Bundle ID: `com.provian.wallet`.
3. Download `GoogleService-Info.plist` to `config/firebase/GoogleService-Info.plist` (the path `app.json` → `ios.googleServicesFile` names; it is committed). APNs handles iOS push directly; the file identifies the Firebase project to the iOS SDK.

## Step 4: Build Development Client

### iOS Simulator

```bash
eas build --profile development --platform ios
```

### Physical iOS Device

```bash
eas build --profile development-device --platform ios
```

### Android

```bash
eas build --profile development --platform android
```

## Step 5: Install & Run Development Build

### iOS

```bash
# After build completes, install on simulator
eas build:run --platform ios

# Or scan QR code on physical device
```

### Android

```bash
# Download APK and install
eas build:run --platform android
```

## Step 6: Deploy Backend

The production deploy is the gated wrapper `provian-backend/scripts/deploy-api-gated.ts --execute`
(dry-run → publish → stamp → deploy → reset; it keeps the settlement gate's report and the image
stamp in order), which runs `provian-backend/deploy-env.sh` for the actual `gcloud run deploy`. Neither
passes any Firebase credentials, because the runtime SA already has the IAM grants from Step 3.2.

```bash
cd provian-backend
npx ts-node scripts/deploy-api-gated.ts --execute
```

The `gcloud run deploy` that `deploy-env.sh` issues (no `GOOGLE_APPLICATION_CREDENTIALS`, no JSON key
mount) is `--source . --allow-unauthenticated --min-instances=0 --max-instances=50 --cpu=1
--memory=1Gi --concurrency=40 --timeout=3600`; read the script for the current flags.

The only Firebase-related env var the backend reads is `GCP_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` (next to the `initializeApp` call in `server.ts`), and Cloud Run sets `GOOGLE_CLOUD_PROJECT` automatically.

### Local development

For running the backend locally against Firebase, use `gcloud` user credentials, not a JSON key:

```bash
gcloud auth application-default login
gcloud config set project provian-ai

# Then start the backend normally; firebase-admin's
# applicationDefault picks up the user creds.
cd provian-backend && npm run dev
```

If you absolutely need a service-account JSON for a one-off (e.g., a local script that has to act as a specific SA), download a key for that purpose only, set `GOOGLE_APPLICATION_CREDENTIALS` to its path in your shell, and delete the file when done. Do **not** check it in. The repo `.gitignore` already excludes `*-admin-key.json` and `firebase-admin-key.json` patterns; if you add a new SA-JSON pattern, extend `.gitignore` first.

## Step 7: Push token registration

There is no manual relay-connection step. The app's relay URL is build config
(`EXPO_PUBLIC_RELAY_URL`, `https://api.provian.ai` in production), and
`NotificationService` registers the Expo push token with the relay automatically once notification
permission is granted (`POST /v1/users/:userId/fcm-token`). Settings → "Reset relay connection" re-registers
the device with the relay (`POST /v1/users/recover` under a fresh device id).

## Backend push delivery (dispatcher)

All relay → phone pushes go through a single module,
`provian-backend/src/core/notifications/pushDispatcher.ts`. No other file may
call `messaging.sendEachForMulticast` directly — a CI job
(`push-dispatcher-guard`, `scripts/check-no-direct-multicast.sh`) fails the
build if it reappears elsewhere.

**Routing.** For each stored token the dispatcher checks the format:

| Token format | Transport |
|--------------|-----------|
| `ExponentPushToken[...]` / `ExpoPushToken[...]` | Expo push service (`expo-server-sdk`, chunked to 100/request, receipts fetched + `DeviceNotRegistered` tokens pruned) |
| anything else (native FCM / APNs registration token) | Firebase Admin FCM multicast |

A user's `fcm_tokens` array may hold Expo AND native tokens across devices; each
is routed independently at send time. Invalid tokens (Expo `DeviceNotRegistered`,
FCM `registration-token-not-registered` / `invalid-registration-token`) are
pruned from the user doc via an atomic `arrayRemove`.

**Token registration.** Both registration endpoints accept either field name:

- `POST /v1/users` — body may include `push_token` (canonical) or `fcm_token`
  (legacy, what the app currently sends). `push_token` wins if both are present.
- `POST /v1/users/:userId/fcm-token` (wallet auth; the caller must be `:userId`) — same; returns `400`
  if neither is a non-empty string.

Each write stores the derived `token_type` (`'expo' | 'fcm'`) on the user doc
for diagnostics. The guard runs in the `push-dispatcher-guard` job of `.github/workflows/typecheck.yml`
(nightly / PR / manual — there is no per-push CI) and locally as
`bash provian-backend/scripts/check-no-direct-multicast.sh`. Native FCM-token migration on the app is optional: because the
dispatcher routes by format, an already-stored Expo token and a future native
token both deliver with no dispatcher change.

**Optional env.** `EXPO_ACCESS_TOKEN` raises Expo's per-project rate limits; sends work without it.
It is not set on `provian-api` (and there is no Secret Manager secret for it) as of 2026-09-23.

## Testing Push Notifications

### Smoke test to a real device (admin)

Before device gates, verify end-to-end delivery to a physical phone with the
admin-only endpoint `POST /v1/internal/admin/test-push` (scheduler-auth gated —
OIDC service account OR the `x-scheduler-secret` shared secret). It dispatches a
real push to a wallet's registered tokens and returns routing + delivery counts
plus per-token **prefixes only** (never full tokens). Body:
`{ target_user_id?, wallet_address? }` — one is required. (The field is
`target_user_id`, not `user_id`: the anti-spoofing middleware strips `user_id`
from every request body.)

```bash
# Convenience wrapper (resolves the scheduler secret from Secret Manager):
cd provian-backend
./scripts/send-test-push.sh <user_id | 0xWalletAddress> "Test title" "Test body"
```

The response shows `{ routed: { expo, fcm }, success, failure, pruned, tokens: [{ prefix, type }] }`.

## Notification Behavior

| App State | iOS | Android | Apple Watch |
|-----------|-----|---------|-------------|
| Foreground | Banner + In-app | Banner + In-app | - |
| Background | Lock screen + Banner | Notification shade | Mirror |
| Killed | Lock screen + Banner | Notification shade | Mirror |

## Troubleshooting

### Notifications not appearing on iOS

1. Check device settings: Settings > Notifications > Provian Wallet.
2. Verify APNs key is valid: `eas credentials`.
3. Check entitlements: `aps-environment` should be `production`.

### Notifications not appearing on Android

1. Check device settings: Settings > Apps > Provian Wallet > Notifications.
2. Verify `android/app/google-services.json` is present.
3. Check Firebase Console for delivery reports.

### Backend cannot send FCM messages

If the relay logs show `PERMISSION_DENIED` or `UNAUTHENTICATED` from the FCM API:

1. Confirm the runtime SA assigned to `provian-api` (Step 3.2):
   ```bash
   gcloud run services describe provian-api \
     --region us-central1 --project provian-ai \
     --format='value(spec.template.spec.serviceAccountName)'
   ```
2. Confirm that SA has `roles/firebasecloudmessaging.serviceAgent`:
   ```bash
   gcloud projects get-iam-policy provian-ai \
     --flatten="bindings[].members" \
     --filter="bindings.members:$RUNTIME_SA" \
     --format="table(bindings.role)"
   ```
3. If both look right, check that `GOOGLE_CLOUD_PROJECT` is set to `provian-ai` on the service (Cloud Run sets this automatically; only check if you've manually overridden it).

### Token not registering

1. Check network connectivity.
2. Verify backend URL is correct.
3. Check backend logs: `gcloud run services logs read provian-api --region us-central1`.

## Production Checklist

- [ ] Apple Developer account active.
- [ ] APNs key uploaded to EAS.
- [ ] Firebase project created (or attached to existing GCP project).
- [ ] `android/app/google-services.json` and `ios/Provian/GoogleService-Info.plist` present.
- [ ] Cloud Run runtime SA pinned to `provian-api` (Step 3.2).
- [ ] Runtime SA has `roles/firebasecloudmessaging.serviceAgent`, `roles/datastore.user`, `roles/secretmanager.secretAccessor`.
- [ ] Backend deployed via `scripts/deploy-api-gated.ts --execute` → `deploy-env.sh` (no `GOOGLE_APPLICATION_CREDENTIALS` env var, no JSON key mount).
- [ ] Production build created: `eas build --profile production`.
- [ ] App submitted to stores.
- [ ] Push notification entitlements approved by Apple.

## Files Reference

| File | Purpose | In repo? |
|------|---------|----------|
| `app.json` | Expo configuration with notification settings | yes |
| `eas.json` | EAS Build profiles | yes |
| `android/app/google-services.json` | Firebase Android client config (no secrets) | yes |
| `ios/Provian/GoogleService-Info.plist` | Firebase iOS client config (no secrets) | yes |
| `firebase-admin-key.json` | **Not used in production.** ADC via the Cloud Run runtime SA replaces it. Only ever generated for one-off local debugging, never committed, deleted after use. | no, gitignored |
