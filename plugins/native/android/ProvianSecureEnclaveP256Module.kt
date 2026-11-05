package com.provian.wallet

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.*
import java.math.BigInteger
import java.security.*
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class ProvianSecureEnclaveP256Module(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "ProvianSecureEnclaveP256"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS_PREFIX = "com.provian.wallet.p256."

        // Validity window (seconds) after a successful strong biometric during
        // which auto_approve / soft_confirm signing is permitted without a
        // fresh BiometricPrompt. Matches the iOS LAContext-unlock-window model.
        // hard_confirm signing always triggers a fresh CryptoObject-bound prompt.
        private const val AUTH_VALIDITY_SECONDS = 60

        // [Chunk I native pass] Allowlist for frictionLevel parameter to
        // signDigest. Unknown values are rejected (fail-closed) - a typo or
        // contract drift in JS must not silently downgrade hard_confirm to
        // silent signing.
        private val RECOGNIZED_FRICTION_LEVELS = setOf(
            "auto_approve",
            "soft_confirm",
            "hard_confirm"
        )

        private val P256_ORDER = BigInteger(
            "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16
        )
        private val P256_HALF_ORDER = P256_ORDER.shiftRight(1)
    }

    override fun getName(): String = NAME

    private fun keyAlias(keyId: String): String = "$KEY_ALIAS_PREFIX$keyId"

    @ReactMethod
    fun generateKey(keyId: String, promise: Promise) {
        try {
            val alias = keyAlias(keyId)

            val paramBuilder = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
                .setUserAuthenticationRequired(true)

            // [MED-3] Invalidate the SE / StrongBox / TEE-bound key when a new
            // biometric (fingerprint or face) is enrolled. Defends against the
            // PIN-known-attacker-enrolls-new-biometric scenario. User-visible
            // consequence on re-enrollment: the device-identity key is wiped,
            // the next PE / DAI / Decision Receipt / agent-session signing
            // attempt re-pairs the device, and saved Credential Vault payment
            // cards become unreadable (vault master key is derived from a
            // signature with this key - see CredentialCrypto.ts:91-122).
            // Wallet recovery (BIP-39 + PIN + cloud backup) is independent of
            // this key and is not affected.
            //
            // Mirrors the iOS .biometryCurrentSet flag - both platforms now
            // share the same re-enrollment invalidation policy. API 24+;
            // Expo 54 minSdk is 24 so the guard is defensive, not required.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                paramBuilder.setInvalidatedByBiometricEnrollment(true)
            }

            // Use a duration-based authentication window, not strict per-use.
            // Strict per-use (timeout = 0) requires every signDigest call to
            // bind a CryptoObject, which breaks silent PE signing. With a
            // 60-second window, a single successful biometric at the start of
            // a signing session unlocks the key for that window. hard_confirm
            // signing still triggers an explicit CryptoObject-bound prompt.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                paramBuilder.setUserAuthenticationParameters(
                    AUTH_VALIDITY_SECONDS,
                    KeyProperties.AUTH_BIOMETRIC_STRONG
                )
            } else {
                @Suppress("DEPRECATION")
                paramBuilder.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    paramBuilder.setIsStrongBoxBacked(true)
                    val kpg = KeyPairGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER
                    )
                    kpg.initialize(paramBuilder.build())
                    val keyPair = kpg.generateKeyPair()
                    resolvePublicKey(keyPair.public as ECPublicKey, promise)
                    return
                } catch (e: Exception) {
                    paramBuilder.setIsStrongBoxBacked(false)
                }
            }

            val kpg = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER
            )
            kpg.initialize(paramBuilder.build())
            val keyPair = kpg.generateKeyPair()
            resolvePublicKey(keyPair.public as ECPublicKey, promise)

        } catch (e: Exception) {
            promise.reject("KEYGEN_ERROR", "Key generation failed: ${e.message}", e)
        }
    }

    private fun resolvePublicKey(publicKey: ECPublicKey, promise: Promise) {
        val w = publicKey.w
        val xBytes = bigIntTo32Bytes(w.affineX)
        val yBytes = bigIntTo32Bytes(w.affineY)

        val result = Arguments.createMap().apply {
            putString("publicKeyX", bytesToHex(xBytes))
            putString("publicKeyY", bytesToHex(yBytes))
        }
        promise.resolve(result)
    }

    /**
     * Trigger a strong-biometric BiometricPrompt to open the authentication
     * window for duration-bound KeyStore keys. Resolves to true on success,
     * rejects on failure or cancellation.
     *
     * This does NOT bind a CryptoObject - its sole purpose is to satisfy the
     * setUserAuthenticationParameters validity window so that subsequent
     * auto_approve / soft_confirm signDigest calls succeed. hard_confirm
     * signing always goes through its own CryptoObject-bound prompt and does
     * not require this warm-up.
     *
     * On the JS side, call this at the start of any batch of signing
     * operations (onboarding activation, wallet creation, etc.).
     */
    @ReactMethod
    fun authenticateForSigning(reason: String, promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity as? FragmentActivity
            if (activity == null) {
                promise.reject("AUTH_ERROR", "No activity available for biometric prompt")
                return
            }

            val executor = ContextCompat.getMainExecutor(reactApplicationContext)

            // Guard against the promise being resolved/rejected twice (e.g.
            // auth succeeds, then the activity briefly loses focus and fires
            // another callback). Once settled, subsequent callbacks are no-ops.
            var settled = false

            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (settled) return
                    settled = true
                    promise.resolve(true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (settled) return
                    settled = true
                    promise.reject("AUTH_ERROR", "Biometric auth failed: $errString")
                }

                override fun onAuthenticationFailed() {
                    // Non-terminal - user can retry. Do nothing.
                }
            }

            activity.runOnUiThread {
                val biometricPrompt = BiometricPrompt(activity, executor, callback)
                val promptInfo = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Authenticate")
                    .setSubtitle(reason)
                    .setNegativeButtonText("Cancel")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .build()
                biometricPrompt.authenticate(promptInfo)
            }
        } catch (e: Exception) {
            promise.reject("AUTH_ERROR", "Authentication setup failed: ${e.message}", e)
        }
    }

    // [C-11] signDigest now accepts frictionLevel parameter.
    // Only 'hard_confirm' triggers BiometricPrompt before signing.
    // 'auto_approve' and 'soft_confirm' sign directly without biometric prompt.
    //
    // [Chunk I native pass] frictionLevel must be one of the recognized values.
    // Unknown values are rejected (fail-closed) per "Unknown = Block, Not Warn" -
    // a typo or contract drift in JS must not silently downgrade hard_confirm
    // to silent signing.
    @ReactMethod
    fun signDigest(keyId: String, digestHex: String, frictionLevel: String, promise: Promise) {
        try {
            val alias = keyAlias(keyId)
            val digestBytes = hexToBytes(digestHex)

            if (digestBytes.size != 32) {
                promise.reject("SIGN_ERROR", "Digest must be 32 bytes, got ${digestBytes.size}")
                return
            }

            if (frictionLevel !in RECOGNIZED_FRICTION_LEVELS) {
                promise.reject("INVALID_FRICTION_LEVEL", "Unknown frictionLevel: $frictionLevel")
                return
            }

            val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
            keyStore.load(null)
            val entry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry

            if (entry == null) {
                promise.reject("SIGN_ERROR", "Key not found (keyId: $keyId)")
                return
            }

            val privateKey = entry.privateKey

            if (frictionLevel == "hard_confirm") {
                // [C-11] hard_confirm: require biometric authentication before signing
                // RN 0.80+ removed Kotlin property access on the base class's
                // getCurrentActivity(); go through reactApplicationContext instead.
                val activity = reactApplicationContext.currentActivity as? FragmentActivity
                if (activity == null) {
                    promise.reject("SIGN_ERROR", "No activity available for biometric prompt")
                    return
                }

                val executor = ContextCompat.getMainExecutor(reactApplicationContext)

                val signature = Signature.getInstance("NONEwithECDSA")
                signature.initSign(privateKey)

                val cryptoObject = BiometricPrompt.CryptoObject(signature)

                val callback = object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val authedSignature = result.cryptoObject?.signature
                                ?: throw Exception("No crypto object after auth")

                            authedSignature.update(digestBytes)
                            val derSignature = authedSignature.sign()

                            resolveSignature(derSignature, promise)
                        } catch (e: Exception) {
                            promise.reject("SIGN_ERROR", "Signing failed: ${e.message}", e)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        promise.reject("SIGN_ERROR", "Biometric auth failed: $errString")
                    }

                    override fun onAuthenticationFailed() {
                    }
                }

                activity.runOnUiThread {
                    val biometricPrompt = BiometricPrompt(activity, executor, callback)
                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Authorize Transaction")
                        .setSubtitle("Confirm your identity to sign")
                        .setNegativeButtonText("Cancel")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                        .build()

                    biometricPrompt.authenticate(promptInfo, cryptoObject)
                }
            } else {
                // [C-11] auto_approve or soft_confirm: sign directly without biometric prompt
                val signature = Signature.getInstance("NONEwithECDSA")
                signature.initSign(privateKey)
                signature.update(digestBytes)
                val derSignature = signature.sign()

                resolveSignature(derSignature, promise)
            }

        } catch (e: Exception) {
            promise.reject("SIGN_ERROR", "Sign setup failed: ${e.message}", e)
        }
    }

    private fun resolveSignature(derSignature: ByteArray, promise: Promise) {
        val (rBytes, sBytes) = parseDERSignature(derSignature)
            ?: throw Exception("Failed to parse DER signature")

        val rBig = BigInteger(1, rBytes)
        var sBig = BigInteger(1, sBytes)
        if (sBig > P256_HALF_ORDER) {
            sBig = P256_ORDER.subtract(sBig)
        }

        val map = Arguments.createMap().apply {
            putString("r", bytesToHex(bigIntTo32Bytes(rBig)))
            putString("s", bytesToHex(bigIntTo32Bytes(sBig)))
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun hasKey(keyId: String, promise: Promise) {
        try {
            val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
            keyStore.load(null)
            promise.resolve(keyStore.containsAlias(keyAlias(keyId)))
        } catch (e: Exception) {
            promise.reject("KEYSTORE_ERROR", "Failed to check key: ${e.message}", e)
        }
    }

    @ReactMethod
    fun deleteKey(keyId: String, promise: Promise) {
        try {
            val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
            keyStore.load(null)
            val alias = keyAlias(keyId)
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DELETE_ERROR", "Failed to delete key: ${e.message}", e)
        }
    }

    @ReactMethod
    fun isHardwareBacked(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val hasStrongBox = reactApplicationContext.packageManager
                    .hasSystemFeature("android.hardware.strongbox_keystore")
                if (hasStrongBox) {
                    promise.resolve(true)
                    return
                }
            }

            promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /**
     * Audit Pass 2, Fix 3: report the actual backing of an existing key,
     * not just whether the device CAN do hardware-backed keys.
     *
     * Returns one of:
     *   "strongbox" - key is backed by StrongBox (API 31+ with hardware support)
     *   "tee"       - key is backed by Trusted Execution Environment
     *   "software"  - key lives outside hardware (no backing or unknown)
     *
     * The previous reporting path returned a single boolean (`isHardwareBacked`)
     * that conflated StrongBox and TEE, letting both earn `hardware_full` PE
     * attestation tier. With this method, the JS layer can distinguish them
     * and route TEE-only keys to `hardware_tpm` per the documented design.
     */
    @ReactMethod
    fun getKeyBacking(keyId: String, promise: Promise) {
        try {
            val alias = keyAlias(keyId)
            val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
            keyStore.load(null)
            val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            if (privateKey == null) {
                promise.resolve("software")
                return
            }
            val factory = KeyFactory.getInstance(privateKey.algorithm, KEYSTORE_PROVIDER)
            val keyInfo = factory.getKeySpec(privateKey, KeyInfo::class.java)

            // API 31+ exposes getSecurityLevel which distinguishes StrongBox
            // from the regular TEE. On older APIs we fall back to the
            // boolean isInsideSecureHardware (deprecated but still accurate
            // for hardware-vs-software).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (keyInfo.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> promise.resolve("strongbox")
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> promise.resolve("tee")
                    KeyProperties.SECURITY_LEVEL_SOFTWARE,
                    KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE,
                    KeyProperties.SECURITY_LEVEL_UNKNOWN -> promise.resolve("software")
                    else -> promise.resolve("software")
                }
            } else {
                @Suppress("DEPRECATION")
                if (keyInfo.isInsideSecureHardware) {
                    promise.resolve("tee")
                } else {
                    promise.resolve("software")
                }
            }
        } catch (e: Exception) {
            // On any failure, return the conservative answer. The JS layer
            // collapses unknown to hardware_tpm (not hardware_full), so a
            // failure here costs at most a tier-bump, never an over-claim.
            promise.resolve("software")
        }
    }

    @ReactMethod
    fun isCloudBackupAvailable(promise: Promise) {
        try {
            val context = reactApplicationContext

            val resolver = context.contentResolver
            val backupEnabled = try {
                android.provider.Settings.Secure.getInt(
                    resolver,
                    "backup_enabled",
                    0
                ) == 1
            } catch (e: Exception) {
                false
            }

            promise.resolve(backupEnabled)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    private fun parseDERSignature(der: ByteArray): Pair<ByteArray, ByteArray>? {
        if (der.size < 8 || der[0] != 0x30.toByte()) return null

        var offset = 2

        if (offset >= der.size || der[offset] != 0x02.toByte()) return null
        offset++
        val rLen = der[offset].toInt() and 0xFF
        offset++
        if (offset + rLen > der.size) return null
        var r = der.copyOfRange(offset, offset + rLen)
        offset += rLen

        while (r.size > 1 && r[0] == 0x00.toByte()) {
            r = r.copyOfRange(1, r.size)
        }

        if (offset >= der.size || der[offset] != 0x02.toByte()) return null
        offset++
        val sLen = der[offset].toInt() and 0xFF
        offset++
        if (offset + sLen > der.size) return null
        var s = der.copyOfRange(offset, offset + sLen)

        while (s.size > 1 && s[0] == 0x00.toByte()) {
            s = s.copyOfRange(1, s.size)
        }

        return Pair(r, s)
    }

    private fun bigIntTo32Bytes(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        return when {
            bytes.size == 32 -> bytes
            bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
            else -> ByteArray(32 - bytes.size) + bytes
        }
    }

    private fun bytesToHex(bytes: ByteArray): String {
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun hexToBytes(hex: String): ByteArray {
        val cleanHex = if (hex.startsWith("0x")) hex.substring(2) else hex
        return ByteArray(cleanHex.length / 2) { i ->
            cleanHex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }
}
