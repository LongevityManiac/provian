package com.provian.wallet

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
                        "Play Integrity request failed: ${e.message}",
                        e
                    )
                }
        } catch (e: Exception) {
            promise.reject("INTEGRITY_ERROR", "Play Integrity setup failed: ${e.message}", e)
        }
    }
}
