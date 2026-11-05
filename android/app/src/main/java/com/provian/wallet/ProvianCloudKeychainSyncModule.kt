package com.provian.wallet

/*
 * TODO: Migrate from GoogleSignIn API to Credential Manager.
 *
 * GoogleSignInClient is in the deprecation path. The recommended replacement
 * is androidx.credentials.CredentialManager with GetGoogleIdOption. This
 * migration should happen in the next Android dependency update cycle.
 *
 * Migration guide: https://developer.android.com/training/sign-in/credential-manager
 *
 * Not blocking for launch; current code is functional and supported.
 */

import android.app.Activity
import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.*
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import com.google.api.client.googleapis.extensions.android.gms.auth.GoogleAccountCredential
import com.google.api.client.http.ByteArrayContent
import com.google.api.client.http.javanet.NetHttpTransport
import com.google.api.client.json.gson.GsonFactory
import com.google.api.services.drive.Drive
import com.google.api.services.drive.DriveScopes
import com.google.api.services.drive.model.File
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Native Google Drive appDataFolder module for Provian Wallet.
 *
 * Stores encrypted backup blobs (already AES-256-GCM encrypted by the JS
 * layer, never plaintext) as hidden files in the user's Google Drive
 * appDataFolder. The appDataFolder is invisible in the Drive UI; only
 * the Provian app can list/read/delete these files.
 *
 * Why this instead of Block Store: Block Store only restores during the
 * Android OS setup wizard. Drive appDataFolder is accessible anytime the
 * user is signed into the right Google account, which matches how every
 * competing wallet (Coinbase, etc.) handles Android cloud backup.
 *
 * Methods mirror the iOS ProvianCloudKeychainSync Swift surface so the JS
 * wrapper is platform-agnostic.
 */
class ProvianCloudKeychainSyncModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val TAG = "ProvianKeychain"
        private const val FILE_PREFIX = "provian_backup_"
        private const val FILE_SUFFIX = ".enc"
        private const val MIME_TYPE = "application/octet-stream"
        private const val REQ_SIGN_IN = 9001
        private const val APP_DATA_SPACE = "appDataFolder"
        private const val APP_NAME = "Provian"
    }

    private val executor = Executors.newSingleThreadExecutor()

    /**
     * State for a pending sign-in initiated by a JS call. When the user
     * completes (or cancels) the Google sign-in intent, onActivityResult
     * consults these slots to retry the original operation with the newly
     * signed-in account, or to reject the original promise.
     */
    private data class PendingSignIn(
        val promise: Promise,
        val retry: () -> Unit,
    )
    @Volatile private var pendingSignIn: PendingSignIn? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = "ProvianCloudKeychainSync"

    // ─── Drive client ──────────────────────────────────────────────────────

    /**
     * Build a Drive client for the currently signed-in account. Returns null
     * if no account is signed in; callers should fall through to requestSignIn().
     */
    private fun getDriveService(): Drive? {
        val account = GoogleSignIn.getLastSignedInAccount(reactContext) ?: return null
        val credential = GoogleAccountCredential.usingOAuth2(
            reactContext,
            listOf(DriveScopes.DRIVE_APPDATA),
        )
        credential.selectedAccount = account.account
        // NetHttpTransport replaces the deprecated AndroidHttp.newCompatibleTransport().
        // On modern Android (minSdk 21+) NetHttpTransport is the supported choice.
        return Drive.Builder(
            NetHttpTransport(),
            GsonFactory.getDefaultInstance(),
            credential,
        )
            .setApplicationName(APP_NAME)
            .build()
    }

    /**
     * Launch the Google sign-in intent for the drive.appdata scope. When the
     * user completes sign-in, onActivityResult invokes retry() with the new
     * account in place. If no activity is available, rejects the promise.
     */
    private fun requestSignIn(promise: Promise, retry: () -> Unit) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "Cannot show Google sign-in: no current activity")
            return
        }
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(Scope(DriveScopes.DRIVE_APPDATA))
            .build()
        val client = GoogleSignIn.getClient(activity, options)
        pendingSignIn = PendingSignIn(promise, retry)
        activity.startActivityForResult(client.signInIntent, REQ_SIGN_IN)
    }

    override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ) {
        if (requestCode != REQ_SIGN_IN) return
        val pending = pendingSignIn ?: return
        pendingSignIn = null
        try {
            GoogleSignIn.getSignedInAccountFromIntent(data).getResult(ApiException::class.java)
            // Sign-in succeeded; retry the original operation on the background thread.
            executor.execute(pending.retry)
        } catch (e: ApiException) {
            Log.w(TAG, "Google sign-in failed: statusCode=" + e.statusCode, e)
            pending.promise.reject(
                "SIGN_IN_FAILED",
                "Google sign-in failed (status " + e.statusCode + ")",
                e,
            )
        }
    }

    override fun onNewIntent(intent: Intent) { /* unused */ }

    // ─── Drive operations ──────────────────────────────────────────────────

    /** Enumerate every backup key; paginated so concurrent phones' manifests remain discoverable. */
    @ReactMethod
    fun listKeys(promise: Promise) {
        executor.execute {
            try {
                val drive = getDriveService() ?: throw IllegalStateException("Google Drive not signed in")
                val keys = linkedSetOf<String>()
                var token: String? = null
                do {
                    val page = drive.files().list()
                        .setSpaces(APP_DATA_SPACE)
                        .setQ("trashed = false")
                        .setFields("nextPageToken, files(name)")
                        .setPageSize(1000)
                        .setPageToken(token)
                        .execute()
                    for (file in page.files.orEmpty()) {
                        val name = file.name ?: continue
                        if (name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX)) {
                            keys.add(name.removePrefix(FILE_PREFIX).removeSuffix(FILE_SUFFIX))
                        }
                    }
                    token = page.nextPageToken
                } while (token != null)
                val result = Arguments.createArray()
                keys.forEach { result.pushString(it) }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("LIST_ERROR", "Drive list failed: " + e.message, e)
            }
        }
    }

    private fun fileName(key: String): String = FILE_PREFIX + key + FILE_SUFFIX

    private fun findFileId(drive: Drive, name: String): String? {
        // Escape single quotes in the file name for the Drive query DSL.
        val escaped = name.replace("'", "\\'")
        val result = drive.files().list()
            .setSpaces(APP_DATA_SPACE)
            .setQ("name = '" + escaped + "' and trashed = false")
            .setFields("files(id, name)")
            .setPageSize(10)
            .execute()
        return result.files?.firstOrNull()?.id
    }

    private fun storeInternal(key: String, value: String, promise: Promise) {
        try {
            val drive = getDriveService()
            if (drive == null) {
                requestSignIn(promise) { storeInternal(key, value, promise) }
                return
            }
            val name = fileName(key)
            val existing = findFileId(drive, name)
            val content = ByteArrayContent(MIME_TYPE, value.toByteArray(Charsets.UTF_8))

            if (existing != null) {
                drive.files().update(existing, null, content).execute()
            } else {
                val metadata = File().setName(name).setParents(listOf(APP_DATA_SPACE))
                drive.files().create(metadata, content).setFields("id").execute()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "Drive store failed", e)
            promise.reject("STORE_ERROR", "Drive store failed: " + e.message, e)
        }
    }

    private fun retrieveInternal(key: String, promise: Promise) {
        try {
            val drive = getDriveService()
            if (drive == null) {
                // No account; this is semantically "no backup" for the caller.
                // Recovery callers should invoke signIn() first to give the user
                // a chance to authenticate. See F-04.
                promise.resolve(null)
                return
            }
            val name = fileName(key)
            val id = findFileId(drive, name)
            if (id == null) {
                promise.resolve(null)
                return
            }
            val out = ByteArrayOutputStream()
            drive.files().get(id).executeMediaAndDownloadTo(out)
            promise.resolve(String(out.toByteArray(), Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "Drive retrieve failed", e)
            promise.reject("READ_ERROR", "Drive retrieve failed: " + e.message, e)
        }
    }

    private fun deleteInternal(key: String, promise: Promise) {
        try {
            val drive = getDriveService()
            if (drive == null) {
                // Nothing to delete; treat as success so callers can always
                // issue delete without branching on sign-in state.
                promise.resolve(true)
                return
            }
            val name = fileName(key)
            val id = findFileId(drive, name)
            if (id != null) {
                drive.files().delete(id).execute()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "Drive delete failed", e)
            promise.reject("DELETE_ERROR", "Drive delete failed: " + e.message, e)
        }
    }

    // ─── Public API (mirrors iOS Swift surface) ────────────────────────────

    @ReactMethod
    fun store(key: String, value: String, promise: Promise) {
        executor.execute { storeInternal(key, value, promise) }
    }

    @ReactMethod
    fun retrieve(key: String, promise: Promise) {
        executor.execute { retrieveInternal(key, promise) }
    }

    @ReactMethod
    fun storeWithSync(key: String, value: String, promise: Promise) {
        store(key, value, promise)
    }

    @ReactMethod
    fun readSyncedItem(key: String, promise: Promise) {
        retrieve(key, promise)
    }

    @ReactMethod
    fun deleteSyncedItem(key: String, promise: Promise) {
        executor.execute { deleteInternal(key, promise) }
    }

    /**
     * Post-write sanity check: confirm the file is retrievable. We deliberately
     * treat "retrieve returned non-null" as verified; true cross-device sync
     * verification requires a second device and is outside the scope of a
     * local-process check.
     */
    @ReactMethod
    fun verifySync(key: String, promise: Promise) {
        executor.execute {
            try {
                val drive = getDriveService()
                if (drive == null) {
                    promise.resolve(false)
                    return@execute
                }
                val id = findFileId(drive, fileName(key))
                promise.resolve(id != null)
            } catch (e: Exception) {
                Log.w(TAG, "Drive verifySync failed", e)
                promise.resolve(false)
            }
        }
    }

    /**
     * Whether the OS-level cloud path is reachable: Google Play Services is
     * available AND a Google account is signed in. The native Block Store
     * implementation used to check E2EE availability here; on Drive, a
     * signed-in account is the equivalent prerequisite.
     */
    @ReactMethod
    fun isSyncVerified(promise: Promise) {
        try {
            val gpsStatus = GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(reactContext)
            if (gpsStatus != ConnectionResult.SUCCESS) {
                promise.resolve(false)
                return
            }
            val account = GoogleSignIn.getLastSignedInAccount(reactContext)
            promise.resolve(account != null)
        } catch (e: Exception) {
            Log.w(TAG, "isSyncVerified failed", e)
            promise.resolve(false)
        }
    }

    /**
     * F-04 fix: Allow JS to explicitly trigger the Google sign-in flow before
     * attempting recovery. Without this, a user installing on a fresh device
     * sees retrieve() return null and assumes there's no backup, when really
     * they just haven't authenticated.
     *
     * Resolves true when an account is now available (either was already
     * signed in, or completed the sign-in flow). Rejects on user cancellation
     * or activity unavailability so the JS layer can surface the error.
     */
    @ReactMethod
    fun signIn(promise: Promise) {
        val existing = GoogleSignIn.getLastSignedInAccount(reactContext)
        if (existing != null) {
            promise.resolve(true)
            return
        }
        // requestSignIn must run on the main thread (it touches Activity).
        // ReactMethod calls land on the bridge thread, which is not main.
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "Cannot show Google sign-in: no current activity")
            return
        }
        activity.runOnUiThread {
            requestSignIn(promise) { promise.resolve(true) }
        }
    }
}
