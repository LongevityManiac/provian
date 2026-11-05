// ProvianSecureSeed (Android) — the wallet seed's Keystore-protected item.
//
// Why this exists instead of expo-secure-store's `requireAuthentication`:
//   expo-secure-store 15.0.8 generates ONE shared AES key per keychain service with
//   setUserAuthenticationRequired(true) and nothing else (AESEncryptor.kt:59-64). That key is
//   invalidated by the platform the moment a fingerprint/face is added (the default for per-use
//   auth keys), after which every read returns null (SecureStoreModule.kt:156-158); a
//   BadPaddingException read DELETES the item (:159-168); and the next authenticated write finds
//   the key invalidated and wipes every authenticated entry under the service (:191-196, :271-294).
//   Its prompt allows BIOMETRIC_STRONG only (AuthenticationHelper.kt:59-67), so a passcode-only
//   device cannot even generate the key: wallet creation throws.
//
// This module keeps F14 (the seed is user-authentication-gated by the OS, 2026-09-09):
//   * a per-item RSA-2048 Keystore key pair; the private key (the only thing that can unwrap the
//     item) requires user authentication and is NOT invalidated by biometric enrollment
//     (setInvalidatedByBiometricEnrollment(false)).
//   * API 30+: per-use authentication (timeout 0) admitting BIOMETRIC_STRONG | DEVICE_CREDENTIAL,
//     bound to the exact decrypt operation through a BiometricPrompt CryptoObject.
//   * API 24-29: the platform cannot bind a device-credential authentication to a CryptoObject, so
//     the key is time-bound (AUTH_WINDOW_SECONDS). The module prompts immediately before the
//     decrypt; any biometric or device-credential authentication the Keystore recognises unlocks
//     the key for that window. Time-bound keys are never invalidated by biometric enrollment.
//   * The value is sealed with a fresh AES-256-GCM data key; the data key is wrapped with the RSA
//     public key (RSA-OAEP, SHA-256 / MGF1-SHA-1 — the combination AndroidKeyStore decrypts on every
//     API level). Wrapping needs no authentication, so a WRITE never prompts.
//
// Contract the JS side relies on (src/core/wallet/secureSeedStore.ts):
//   * set NEVER touches any other item and NEVER replaces an existing one: if the named item exists
// it throws ERR_SEED_ITEM_EXISTS (round 2 — the JS side stages a new seed in an EMPTY slot,
//     reads it back, and only then retires the old slot). It writes one file atomically (AtomicFile).
//   * probe never prompts and never decrypts: absent / present / invalidated / unrecoverable / unknown.
//     'invalidated' ONLY from KeyPermanentlyInvalidatedException; a key the Keystore reports missing
//     is 'unknown' — containsAlias()/getKey() can answer "missing" transiently (keystore1's contains()
//     swallows RemoteException and returns false; keystore2 returns null metadata on any
//     KeyStoreException), so it is never evidence that a key is gone.
//   * get returns null ONLY when no item exists. Cancel / failed auth / missing or invalidated key /
//     integrity failure all THROW with a stable code. ERR_SEED_UNRECOVERABLE messages carry a stable
//     `[cause:…]` tag (invalidated / key_missing / unwrap_failed / integrity / malformed) so the JS side
//     can tell a permanent invalidation from a key lookup that failed. Nothing is deleted on read, ever.
//   * items live in noBackupFilesDir, so Android auto-backup never restores a ciphertext onto a
//     device that lacks its Keystore key.
package expo.modules.proviansecureseed

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.AtomicFile
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import java.security.MessageDigest
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
private const val ALIAS_PREFIX = "provian_secure_seed"
private const val DIR_NAME = "provian_secure_seed"
private const val RSA_TRANSFORMATION = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"
private const val AES_TRANSFORMATION = "AES/GCM/NoPadding"
private const val GCM_TAG_BITS = 128
private const val AUTH_WINDOW_SECONDS = 10
private const val FORMAT_VERSION = 1
private const val ACTION_ROOT = "provian_action_root_v1"
private const val ROOT_MAC_ALIAS = "provian_secure_seed_root_integrity_v1"
private const val ROOT_MARKER = "provian.authenticated.action.root.v1"

private val OAEP_SPEC = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)

private class SeedStoreException(code: String, message: String, cause: Throwable? = null) :
  CodedException(code, message, cause)

private const val UNRECOVERABLE = "ERR_SEED_UNRECOVERABLE"

/** An ERR_SEED_UNRECOVERABLE with its stable `[cause:…]` tag (the JS side's contract). */
private fun unrecoverable(cause: String, message: String, e: Throwable? = null) =
  SeedStoreException(UNRECOVERABLE, "[cause:$cause] $message", e)

class ProvianSecureSeedModule : Module() {
  @Volatile private var authenticating = false
  @Volatile private var initialCredentialTransition = false
  @Volatile private var activePrompt: BiometricPrompt? = null

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private class Action(val allowPasscode: Boolean) {
    var live = true
    var root: JSONObject? = null
    val keys = mutableMapOf<String, ByteArray>()
    val legacy = mutableMapOf<String, ByteArray>()
  }
  private val actions = mutableMapOf<String, Action>()
  private fun action(id: String?): Action = synchronized(actions) {
    actions[id]?.takeIf { it.live }
      ?: throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "A live authenticated action is required")
  }
  private fun endAction(id: String) = synchronized(actions) {
    actions.remove(id)?.let { a ->
      a.live = false
      a.keys.values.forEach { it.fill(0) }
      a.legacy.values.forEach { it.fill(0) }
      a.keys.clear(); a.legacy.clear(); a.root = null
    }
  }
  private fun endAllActions(preservePendingCredential: Boolean = false) {
    val keepPending = preservePendingCredential && authenticating && initialCredentialTransition
    synchronized(actions) {
      actions.filterValues { a -> !keepPending || a.keys.isNotEmpty() || a.legacy.isNotEmpty() || a.root != null }
        .keys.toList().forEach { endAction(it) }
    }
    // AndroidX API 24–29 opens the system credential Activity. An EMPTY first auth
    // has no unlocked material to retain. Granted actions always end on activity pause.
    if (!keepPending) activePrompt?.cancelAuthentication()
  }
  private fun cacheKey(record: JSONObject): String {
    try {
      val alias = record.getString("alias")
      val wrapped = record.getString("wk")
      if (!alias.startsWith("$ALIAS_PREFIX:") || wrapped.isEmpty() || Base64.decode(wrapped, Base64.NO_WRAP).isEmpty()) {
        throw IllegalArgumentException("Invalid protected key record")
      }
      return "$alias:$wrapped"
    } catch (e: Exception) { throw unrecoverable("malformed", "protected key record is malformed", e) }
  }
  private fun keepKey(id: String, record: JSONObject, key: ByteArray) {
    synchronized(actions) {
      val a = action(id)
      a.keys.put(cacheKey(record), key)?.fill(0)
    }
  }
  private fun writeRecord(key: String, record: JSONObject) {
    val file = atomicFile(key)
    val stream = file.startWrite()
    try {
      stream.write(record.toString().toByteArray(StandardCharsets.UTF_8))
      file.finishWrite(stream)
    } catch (e: Exception) { file.failWrite(stream); throw e }
  }
  private fun sealedRecord(source: JSONObject, dataKey: ByteArray, value: String): JSONObject {
    val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val aes = Cipher.getInstance(AES_TRANSFORMATION)
    aes.init(Cipher.ENCRYPT_MODE, SecretKeySpec(dataKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
    return JSONObject().put("v", 2).put("alias", source.getString("alias"))
      .put("wk", source.getString("wk"))
      .put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
      .put("ct", Base64.encodeToString(aes.doFinal(value.toByteArray(StandardCharsets.UTF_8)), Base64.NO_WRAP))
  }
  /** The shared DEK must be device-generated, not an attacker-chosen RSA public-key wrapping. */
  private fun rootMac(record: JSONObject, create: Boolean): ByteArray {
    val ks = keyStore()
    if (!ks.containsAlias(ROOT_MAC_ALIAS)) {
      if (!create) throw unrecoverable("integrity", "root integrity key is missing")
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, KEYSTORE_PROVIDER)
      generator.init(KeyGenParameterSpec.Builder(ROOT_MAC_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
        .setDigests(KeyProperties.DIGEST_SHA256).build())
      generator.generateKey()
    }
    val key = ks.getKey(ROOT_MAC_ALIAS, null) as? javax.crypto.SecretKey
      ?: throw unrecoverable("integrity", "root integrity key is unavailable")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(key)
    return mac.doFinal(("provian.action.root.v1:" + record.getInt("v") + ":" + cacheKey(record)).toByteArray(StandardCharsets.UTF_8))
  }

  private fun authenticateRootRecord(record: JSONObject) {
    try {
      val stored = Base64.decode(record.getString("root_mac"), Base64.NO_WRAP)
      if (!MessageDigest.isEqual(stored, rootMac(record, false))) throw unrecoverable("integrity", "root binding was modified")
    } catch (e: SeedStoreException) { throw e }
    catch (e: Exception) { throw unrecoverable("integrity", "root binding cannot be authenticated", e) }
  }

  private suspend fun beginAction(reason: String, allowPasscode: Boolean, primary: String): String {
    val id = UUID.randomUUID().toString()
    synchronized(actions) { actions[id] = Action(allowPasscode) }
    var temporaryRoot: String? = null
    try {
      var root = try { readRecord(ACTION_ROOT) } catch (e: SeedStoreException) {
        if (e.code != UNRECOVERABLE) throw e
        null
      }
      if (root != null) {
        try {
          authenticateRootRecord(root) // verify BEFORE trusting/decrypting any externally stored wrapping
          val dataKey = unwrapRecord(root, reason, id, true)
          try { root = sealedRecord(root, dataKey, ROOT_MARKER) }
          finally { dataKey.fill(0) }
        } catch (e: SeedStoreException) {
          if (e.code != UNRECOVERABLE) throw e
          root = null
        }
      }
      if (root == null) {
        // NEVER adopt a DEK from an unsigned old seed/root. RSA public encryption alone
        // cannot prove who chose that DEK. Generate fresh device randomness, authenticate
        // its actual protected unwrap, then MAC-bind it with a nonexportable device key.
        // Legacy seed keys remain untouched; each is unlocked once when migration needs it.
        temporaryRoot = "provian_action_root_staging:${UUID.randomUUID()}"
        setItem(temporaryRoot, ROOT_MARKER, null)
        val staged = readRecord(temporaryRoot)!!
        authenticateRootRecord(staged)
        if (getItem(temporaryRoot, reason, id, true) != ROOT_MARKER) throw unrecoverable("integrity", "new root failed its read-back")
        val dataKey = unwrapRecord(staged, reason, id)
        try { root = sealedRecord(staged, dataKey, ROOT_MARKER) }
        finally { dataKey.fill(0) }
      }
      synchronized(actions) {
        val a = action(id)
        root!!.put("root_mac", Base64.encodeToString(rootMac(root!!, true), Base64.NO_WRAP))
        writeRecord(ACTION_ROOT, root!!)
        a.root = root
      }
      primeTimeBoundLegacyKeys(id)
      return id
    } catch (e: Exception) { endAction(id); throw e }
    finally { temporaryRoot?.let { deleteItem(it) } }
  }

  /** API 24–29's first authentication already authorizes existing time-bound RSA keys.
   * Unwrap their DEKs now, before JS/network work can outlive that OS window. No prompt,
   * no seed plaintext, no write/deletion; only this action retains the resulting buffers.
   * Per-use legacy SecureStore keys still authenticate separately when actually needed.
   */
  private fun primeTimeBoundLegacyKeys(id: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return
    val ks = keyStore()
    File(context.noBackupFilesDir, DIR_NAME).listFiles()?.forEach { file ->
      if (!file.name.endsWith(".json")) return@forEach
      var dataKey: ByteArray? = null
      try {
        val record = JSONObject(file.readText())
        if (record.optInt("v") != FORMAT_VERSION) return@forEach
        val alias = record.getString("alias")
        cacheKey(record) // validate alias and wrapping before using the Keystore
        val privateKey = ks.getKey(alias, null) as? PrivateKey ?: return@forEach
        dataKey = newDecryptCipher(privateKey).doFinal(Base64.decode(record.getString("wk"), Base64.NO_WRAP))
        keepKey(id, record, dataKey.copyOf())
      } catch (_: GeneralSecurityException) {
        // An invalid/missing key keeps its original read-time classification and custody.
      } catch (_: JSONException) {
        // Malformed copies are retained; a later real read classifies them.
      } catch (_: IllegalArgumentException) {
      } catch (e: SeedStoreException) {
        action(id) // never ignore revocation; unreadable records remain untouched
      } finally { dataKey?.fill(0) }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ProvianSecureSeed")

    Function("isAvailable") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
    }

    OnActivityEntersBackground { endAllActions(preservePendingCredential = true) }
    OnDestroy { endAllActions() }
    AsyncFunction("beginActionAsync") Coroutine { reason: String, allowPasscode: Boolean, primary: String ->
      beginAction(reason, allowPasscode, primary)
    }
    AsyncFunction("endActionAsync") { id: String -> endAction(id); Unit }
    AsyncFunction("hasLegacyItemAsync") { key: String -> legacyRecord(key) != null }
    AsyncFunction("getLegacyItemAsync") Coroutine { key: String, prompt: String, id: String ->
      getLegacyItem(key, prompt, id)
    }

    AsyncFunction("signDeviceDigestAsync") { keyId: String, hex: String, id: String ->
      action(id)
      val raw = hex.removePrefix("0x")
      if (raw.length != 64) throw SeedStoreException("ERR_SEED_KEYCHAIN", "Digest must be 32 bytes")
      val digest = raw.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
      val key = keyStore().getKey("com.provian.wallet.p256.$keyId", null) as? PrivateKey
        ?: throw SeedStoreException("ERR_SEED_KEYCHAIN", "Device signing key was not found")
      val signer = java.security.Signature.getInstance("NONEwithECDSA")
      signer.initSign(key)
      signer.update(digest)
      val result = signer.sign()
      action(id)
      result.joinToString("") { "%02x".format(it) }
    }

    AsyncFunction("hasItemAsync") { key: String ->
      readRecord(key) != null
    }

    AsyncFunction("isActionKeyAsync") { key: String, id: String ->
      val a = action(id)
      val record = readRecord(key)
      record != null && a.root != null && cacheKey(record) == cacheKey(a.root!!)
    }

    AsyncFunction("probeItemAsync") { key: String ->
      probeItem(key)
    }

    AsyncFunction("setItemAsync") { key: String, value: String, _: String, id: String? ->
      action(id)
      setItem(key, value, id)
      true
    }

    AsyncFunction("getItemAsync") Coroutine { key: String, prompt: String, id: String? ->
      action(id)
      return@Coroutine getItem(key, prompt, id!!)
    }

    AsyncFunction("deleteItemAsync") { key: String ->
      deleteItem(key)
      true
    }
  }

  // ---------------------------------------------------------------------------------------------
  // storage
  // ---------------------------------------------------------------------------------------------

  private fun atomicFile(key: String): AtomicFile {
    val dir = File(context.noBackupFilesDir, DIR_NAME)
    if (!dir.exists() && !dir.mkdirs() && !dir.exists()) {
      throw SeedStoreException("ERR_SEED_WRITE_FAILED", "could not create the seed store directory")
    }
    // Item names are JS constants; hex-encode so no name can escape the directory.
    val safe = key.toByteArray(StandardCharsets.UTF_8).joinToString("") { "%02x".format(it) }
    return AtomicFile(File(dir, "$safe.json"))
  }

  private fun readRecord(key: String): JSONObject? {
    val raw = try {
      atomicFile(key).readFully()
    } catch (e: FileNotFoundException) {
      return null
    }
    return try {
      JSONObject(String(raw, StandardCharsets.UTF_8))
    } catch (e: JSONException) {
      throw unrecoverable("malformed", "seed record is not valid JSON", e)
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

  // ---------------------------------------------------------------------------------------------
  // write (never prompts)
  // ---------------------------------------------------------------------------------------------

  private fun generateKeyPair(alias: String) {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(2048)
      .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
      .setUserAuthenticationRequired(true)
      // The whole point: adding or removing a fingerprint/face never destroys the seed.
      .setInvalidatedByBiometricEnrollment(false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
      )
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(AUTH_WINDOW_SECONDS)
    }
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE_PROVIDER)
    generator.initialize(builder.build())
    generator.generateKeyPair()
  }

  private fun softwarePublicKey(ks: KeyStore, alias: String): PublicKey {
    val certificate = ks.getCertificate(alias)
      ?: throw SeedStoreException("ERR_SEED_WRITE_FAILED", "generated key pair has no certificate")
    // Re-materialise as a plain software key so the wrap is a pure public-key operation that no
    // Keystore authorisation (user authentication included) applies to.
    return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(certificate.publicKey.encoded))
  }

  private fun setItem(key: String, value: String, id: String?) {
    val ks = keyStore()
    val exists = try {
      readRecord(key) != null
    } catch (e: SeedStoreException) {
      true // a record is there, even if it cannot be parsed
    }
    if (exists) {
      throw SeedStoreException("ERR_SEED_ITEM_EXISTS", "an item named $key already exists; delete it explicitly first")
    }
    if (id != null) {
      synchronized(actions) {
        val a = action(id)
        val root = a.root ?: throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "Missing authenticated root")
        val dataKey = a.keys[cacheKey(root)] ?: throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "Missing authenticated key")
        writeRecord(key, sealedRecord(root, dataKey, value))
      }
      return
    }
    val alias = "$ALIAS_PREFIX:$key:${UUID.randomUUID()}"
    val dataKey = ByteArray(32)
    try {
      generateKeyPair(alias)
      val publicKey = softwarePublicKey(ks, alias)

      SecureRandom().nextBytes(dataKey)
      val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
      val aes = Cipher.getInstance(AES_TRANSFORMATION)
      aes.init(Cipher.ENCRYPT_MODE, SecretKeySpec(dataKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
      val ciphertext = aes.doFinal(value.toByteArray(StandardCharsets.UTF_8))

      val rsa = Cipher.getInstance(RSA_TRANSFORMATION)
      rsa.init(Cipher.ENCRYPT_MODE, publicKey, OAEP_SPEC)
      val wrappedKey = rsa.doFinal(dataKey)

      val record = JSONObject()
        .put("v", FORMAT_VERSION)
        .put("alias", alias)
        .put("wk", Base64.encodeToString(wrappedKey, Base64.NO_WRAP))
        .put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
        .put("ct", Base64.encodeToString(ciphertext, Base64.NO_WRAP))

      if (key.startsWith("provian_action_root_staging:")) {
        // Bind the DEK we just generated BEFORE it ever leaves this process.
        record.put("root_mac", Base64.encodeToString(rootMac(record, true), Base64.NO_WRAP))
      }
      val file = atomicFile(key)
      val stream = file.startWrite()
      try {
        stream.write(record.toString().toByteArray(StandardCharsets.UTF_8))
        file.finishWrite(stream) // fsync + rename: the old record stays intact until this returns
      } catch (e: Exception) {
        file.failWrite(stream)
        throw e
      }
    } catch (e: Exception) {
      // The new record never landed; drop only the key pair we just created. The previous record
      // (if any) and its key are untouched.
      try { ks.deleteEntry(alias) } catch (_: Exception) {}
      if (e is CodedException) throw e
      throw SeedStoreException("ERR_SEED_WRITE_FAILED", "setItem failed: ${e.message}", e)
    } finally {
      dataKey.fill(0)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // probe (never prompts, never decrypts, never deletes)
  // ---------------------------------------------------------------------------------------------

  // Classify an item for the unlock-time check. Starting a decrypt operation needs no user
  // authentication on any API level (per-use keys authenticate at doFinal; time-bound keys answer
  // UserNotAuthenticatedException), but a key the platform has permanently invalidated — the secure
  // lock screen was removed — refuses at init with KeyPermanentlyInvalidatedException ('invalidated').
  // The operation is abandoned, never completed. A key the Keystore reports missing is 'unknown', never
  // a verdict: the lookup can fail transiently (see the header), and the JS side deletes a slot only on
  // 'invalidated' plus a read that failed for the same cause.
  private fun probeItem(key: String): String {
    val record = try {
      readRecord(key) ?: return "absent"
    } catch (e: SeedStoreException) {
      return "unrecoverable" // present but not parseable
    }
    val alias = record.optString("alias")
    if (alias.isEmpty() || !record.has("wk") || !record.has("iv") || !record.has("ct")) return "unrecoverable"
    return try {
      val ks = keyStore()
      if (!ks.containsAlias(alias)) return "unknown"
      val privateKey = ks.getKey(alias, null) as? PrivateKey ?: return "unknown"
      Cipher.getInstance(RSA_TRANSFORMATION).init(Cipher.DECRYPT_MODE, privateKey, OAEP_SPEC)
      "present"
    } catch (e: KeyPermanentlyInvalidatedException) {
      "invalidated"
    } catch (e: UserNotAuthenticatedException) {
      "present" // time-bound key, valid, simply outside its authentication window
    } catch (e: Exception) {
      "unknown" // not evidence either way; the caller falls back to a real (prompting) read
    }
  }

  // ---------------------------------------------------------------------------------------------
  // read (prompts; never deletes)
  // ---------------------------------------------------------------------------------------------

  private suspend fun unwrapRecord(record: JSONObject, prompt: String, id: String, first: Boolean = false): ByteArray {
    synchronized(actions) {
      action(id).keys[cacheKey(record)]?.let { return it.copyOf() }
    }
    // A cache miss is an independently protected OLD key (migration/recovery only).
    val alias = record.optString("alias")
    val ks = keyStore()
    val privateKey = (if (alias.isNotEmpty() && ks.containsAlias(alias)) ks.getKey(alias, null) else null) as? PrivateKey
      ?: throw unrecoverable("key_missing", "the Keystore key for this seed record was not found")
    val wrapped = try { Base64.decode(record.getString("wk"), Base64.NO_WRAP) }
      catch (e: Exception) { throw unrecoverable("malformed", "seed record is malformed", e) }
    val key = unwrapDataKey(privateKey, wrapped, prompt, action(id).allowPasscode, first)
    try { keepKey(id, record, key.copyOf()); return key } catch (e: Exception) { key.fill(0); throw e }
  }

  private suspend fun getItem(key: String, prompt: String, id: String, first: Boolean = false): String? {
    action(id)
    val record = readRecord(key) ?: return null
    // Parse ALL ciphertext fields before cache lookup/authentication. Corruption must retain the
    // stable unreadable classification, so JS tries an intact alternate without deleting this one.
    val iv: ByteArray
    val ciphertext: ByteArray
    try {
      cacheKey(record)
      iv = Base64.decode(record.getString("iv"), Base64.NO_WRAP)
      ciphertext = Base64.decode(record.getString("ct"), Base64.NO_WRAP)
      if (iv.size != 12 || ciphertext.size < GCM_TAG_BITS / 8) throw IllegalArgumentException("Invalid ciphertext fields")
    } catch (e: CodedException) { throw e }
    catch (e: Exception) { throw unrecoverable("malformed", "seed record is malformed", e) }
    val dataKey = unwrapRecord(record, prompt, id, first)
    var plaintext: ByteArray? = null
    try {
      val aes = Cipher.getInstance(AES_TRANSFORMATION)
      aes.init(Cipher.DECRYPT_MODE, SecretKeySpec(dataKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
      plaintext = aes.doFinal(ciphertext)
      action(id)
      return String(plaintext, StandardCharsets.UTF_8)
    } catch (e: AEADBadTagException) { throw unrecoverable("integrity", "seed record failed its integrity check", e) }
    finally { dataKey.fill(0); plaintext?.fill(0) }
  }

  private fun legacyRecord(key: String): JSONObject? {
    val prefs = context.getSharedPreferences("SecureStore", android.content.Context.MODE_PRIVATE)
    val raw = prefs.getString("key_v1-$key", null) ?: prefs.getString(key, null) ?: return null
    return try { JSONObject(raw) } catch (e: Exception) { throw unrecoverable("malformed", "legacy record is malformed", e) }
  }
  private suspend fun getLegacyItem(key: String, prompt: String, id: String): String? {
    synchronized(actions) { action(id).legacy[key]?.let { return String(it, StandardCharsets.UTF_8) } }
    var hybridBytes: ByteArray? = null
    try {
      val record = legacyRecord(key) ?: return null
      val scheme = record.optString("scheme")
      if (scheme != "aes" && scheme != "hybrid") throw unrecoverable("malformed", "unsupported legacy encryption scheme")
      val base = record.optString("keystoreAlias", "key_v1")
      val needsAuth = record.optBoolean("requireAuthentication", false)
      val suffix = if (record.optBoolean("usesKeystoreSuffix", false)) {
        if (needsAuth) ":keystoreAuthenticated" else ":keystoreUnauthenticated"
      } else ""
      val secretKey = if (scheme == "aes") {
        keyStore().getKey("$AES_TRANSFORMATION:$base$suffix", null) as? javax.crypto.SecretKey
          ?: throw unrecoverable("key_missing", "legacy Keystore key was not found")
      } else {
        val rsa = Cipher.getInstance("RSA/None/PKCS1Padding")
        val privateKey = keyStore().getKey("RSA/None/PKCS1Padding:$base$suffix", null) as? PrivateKey
          ?: throw unrecoverable("key_missing", "legacy RSA key was not found")
        rsa.init(Cipher.DECRYPT_MODE, privateKey)
        val authedRsa = if (needsAuth) authenticate(prompt, BIOMETRIC_STRONG, BiometricPrompt.CryptoObject(rsa)).cryptoObject?.cipher
        ?: throw SeedStoreException("ERR_SEED_AUTH_FAILED", "legacy RSA authentication returned no cipher") else rsa
      hybridBytes = authedRsa.doFinal(Base64.decode(record.getString("esk"), Base64.DEFAULT))
        SecretKeySpec(hybridBytes, "AES")
      }
      val cipher = Cipher.getInstance(AES_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, secretKey,
        GCMParameterSpec(record.getInt("tlen"), Base64.decode(record.getString("iv"), Base64.DEFAULT)))
      val authed = if (needsAuth && scheme == "aes") authenticate(prompt, BIOMETRIC_STRONG, BiometricPrompt.CryptoObject(cipher)).cryptoObject?.cipher
        ?: throw SeedStoreException("ERR_SEED_AUTH_FAILED", "legacy authentication returned no cipher") else cipher
      val bytes = authed.doFinal(Base64.decode(record.getString("ct"), Base64.DEFAULT))
      try {
        synchronized(actions) { action(id).legacy[key] = bytes.copyOf() }
        return String(bytes, StandardCharsets.UTF_8)
      } finally { bytes.fill(0) }
    } catch (e: KeyPermanentlyInvalidatedException) { throw unrecoverable("invalidated", "legacy key was invalidated", e) }
    catch (e: AEADBadTagException) { throw unrecoverable("integrity", "legacy integrity check failed", e) }
    catch (e: JSONException) { throw unrecoverable("malformed", "legacy record is malformed", e) }
    catch (e: IllegalArgumentException) { throw unrecoverable("malformed", "legacy record is malformed", e) }
    catch (e: java.security.GeneralSecurityException) { throw unrecoverable("unwrap_failed", "legacy key cannot decrypt the record", e) }
    finally { hybridBytes?.fill(0) }
  }

  private fun newDecryptCipher(privateKey: PrivateKey): Cipher {
    val cipher = Cipher.getInstance(RSA_TRANSFORMATION)
    try {
      cipher.init(Cipher.DECRYPT_MODE, privateKey, OAEP_SPEC)
    } catch (e: KeyPermanentlyInvalidatedException) {
      // Only reachable if the secure lock screen was removed; enrollment changes cannot cause it.
      throw unrecoverable("invalidated", "the Keystore key was permanently invalidated", e)
    }
    return cipher
  }

  private suspend fun unwrapDataKey(privateKey: PrivateKey, wrapped: ByteArray, prompt: String, allowPasscode: Boolean, first: Boolean): ByteArray {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Per-use auth: the authentication is bound to this exact decrypt operation.
        val cipher = newDecryptCipher(privateKey)
        initialCredentialTransition = first && allowPasscode
        val result = try { authenticate(prompt, if (allowPasscode) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG, BiometricPrompt.CryptoObject(cipher)) }
          finally { initialCredentialTransition = false }
        val authed = result.cryptoObject?.cipher
          ?: throw SeedStoreException("ERR_SEED_AUTH_FAILED", "authentication returned no cipher")
        return authed.doFinal(wrapped)
      }
      // API 24-29: time-bound key. Use a still-fresh authentication if there is one, else prompt.
      // Every NEW action prompts, even while an old API's OS window remains open.
      if (!first) {
        try { return newDecryptCipher(privateKey).doFinal(wrapped) }
        catch (_: UserNotAuthenticatedException) { /* unlock this independent old key */ }
      }
      initialCredentialTransition = first && allowPasscode
      try { authenticate(prompt, if (allowPasscode) legacyAuthenticators() else BIOMETRIC_STRONG, null) }
      finally { initialCredentialTransition = false }
      try {
        return newDecryptCipher(privateKey).doFinal(wrapped)
      } catch (e: UserNotAuthenticatedException) {
        // A class-2 ("weak") biometric does not unlock Keystore keys on these API levels.
        throw SeedStoreException(
          "ERR_SEED_AUTH_FAILED",
          "authenticate with your fingerprint or device PIN / pattern / password to unlock the wallet key",
          e
        )
      }
    } catch (e: CodedException) {
      throw e
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw unrecoverable("invalidated", "the Keystore key was permanently invalidated", e)
    } catch (e: GeneralSecurityException) {
      throw unrecoverable("unwrap_failed", "could not unwrap the seed data key: ${e.message}", e)
    }
  }

  private fun legacyAuthenticators(): Int {
    // BIOMETRIC_STRONG | DEVICE_CREDENTIAL is unsupported by BiometricPrompt on API 28-29, and
    // DEVICE_CREDENTIAL alone is unsupported below API 30. With a strong biometric enrolled use it
    // (re-enrollment cannot invalidate a time-bound key); otherwise admit the device credential.
    val manager = BiometricManager.from(context)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      return BIOMETRIC_STRONG or DEVICE_CREDENTIAL
    }
    return if (manager.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS) {
      BIOMETRIC_STRONG
    } else {
      BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }
  }

  private suspend fun authenticate(
    prompt: String,
    authenticators: Int,
    cryptoObject: BiometricPrompt.CryptoObject?
  ): BiometricPrompt.AuthenticationResult {
    if (authenticating) {
      throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "another authentication is already in progress")
    }
    val status = BiometricManager.from(context).canAuthenticate(authenticators)
    if (status != BiometricManager.BIOMETRIC_SUCCESS) {
      throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "no usable authenticator on this device (status $status)")
    }
    val activity = appContext.currentActivity as? FragmentActivity
      ?: throw SeedStoreException("ERR_SEED_AUTH_UNAVAILABLE", "cannot show the authentication prompt while the app is not in the foreground")

    val infoBuilder = BiometricPrompt.PromptInfo.Builder()
      .setTitle(prompt.ifEmpty { "Unlock wallet" })
      .setAllowedAuthenticators(authenticators)
    if (authenticators and DEVICE_CREDENTIAL == 0) {
      infoBuilder.setNegativeButtonText(context.getString(android.R.string.cancel))
    }
    val info = infoBuilder.build()

    authenticating = true
    try {
      val result = withContext(Dispatchers.Main.immediate) {
        suspendCoroutine<BiometricPrompt.AuthenticationResult> { continuation ->
          var settled = false
          val prompter = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(context),
            object : BiometricPrompt.AuthenticationCallback() {
              override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (settled) return
                settled = true
                continuation.resume(result)
              }

              override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (settled) return
                settled = true
                val code = when (errorCode) {
                  BiometricPrompt.ERROR_USER_CANCELED,
                  BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                  BiometricPrompt.ERROR_CANCELED -> "ERR_SEED_AUTH_CANCELLED"
                  BiometricPrompt.ERROR_NO_BIOMETRICS,
                  BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
                  BiometricPrompt.ERROR_HW_NOT_PRESENT,
                  BiometricPrompt.ERROR_HW_UNAVAILABLE -> "ERR_SEED_AUTH_UNAVAILABLE"
                  else -> "ERR_SEED_AUTH_FAILED"
                }
                continuation.resumeWithException(SeedStoreException(code, "authentication error $errorCode: $errString"))
              }
              // onAuthenticationFailed (a non-matching finger) is not terminal: the prompt stays up.
            }
          )
          activePrompt = prompter
          if (cryptoObject != null) prompter.authenticate(info, cryptoObject) else prompter.authenticate(info)
        }
      }
      // Credential callbacks can run before onResume. Do not unwrap a DEK, or deliver
      // a JS capability, until the wallet Activity is resumed again.
      if (initialCredentialTransition) withContext(Dispatchers.Main.immediate) {
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
          suspendCoroutine<Unit> { continuation ->
            val observer = object : LifecycleEventObserver {
              override fun onStateChanged(source: androidx.lifecycle.LifecycleOwner, event: Lifecycle.Event) {
                if (event == Lifecycle.Event.ON_RESUME || event == Lifecycle.Event.ON_DESTROY) {
                  source.lifecycle.removeObserver(this)
                  if (event == Lifecycle.Event.ON_RESUME) continuation.resume(Unit)
                  else continuation.resumeWithException(SeedStoreException("ERR_SEED_AUTH_CANCELLED", "Activity destroyed"))
                }
              }
            }
            activity.lifecycle.addObserver(observer)
          }
        }
      }
      return result
    } finally {
      activePrompt = null
      authenticating = false
    }
  }

  // ---------------------------------------------------------------------------------------------
  // delete (explicit only)
  // ---------------------------------------------------------------------------------------------

  private fun deleteItem(key: String) {
    val alias = try {
      readRecord(key)?.optString("alias")?.takeIf { it.isNotEmpty() }
    } catch (e: SeedStoreException) {
      null
    }
    atomicFile(key).delete()
    // Version-2 items and the root share a protected key. Never retire a still-referenced alias.
    val referenced = File(context.noBackupFilesDir, DIR_NAME).listFiles()?.any { file ->
      try { JSONObject(file.readText()).optString("alias") == alias } catch (_: Exception) { true }
    } ?: false
    if (alias != null && !referenced) {
      try { keyStore().deleteEntry(alias) } catch (_: Exception) {}
    }
  }
}
