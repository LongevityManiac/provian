// ProvianPinnedTLS (Android) — pinned-DNS TLS fetch.
//
// Uses an OkHttp client with a custom Dns that returns ONLY the pre-validated
// IP for the target hostname. OkHttp connects to that IP while keeping TLS SNI
// and the hostname verifier on the real hostname — so the merchant/CDN cert
// validates correctly AND DNS cannot rebind to an internal address after the
// JS-side SSRF check. This is the clean fix for review #33.
//
// !!! DEVICE-VERIFY REQUIRED !!! Compiles against the Expo Modules API but has
// not been exercised on a device. Verify against a real HTTPS endpoint before
// relying on it.

package expo.modules.provianpinnedtls

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Field
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.InetAddress
import java.util.concurrent.TimeUnit

class PinnedRequest : Record {
  @Field var url: String = ""
  @Field var pinnedIp: String = ""
  @Field var hostname: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
  @Field var followRedirects: Boolean = false
  // WS4: hard byte cap (OOM defense) + configurable timeout.
  @Field var maxBytes: Int = 1_000_000
  @Field var timeoutMs: Int = 30_000
}

private val METHODS_WITH_BODY = setOf("POST", "PUT", "PATCH", "DELETE")

class ProvianPinnedTlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProvianPinnedTLS")

    AsyncFunction("fetch") { request: PinnedRequest, promise: Promise ->
      try {
        // Pin DNS: for the target hostname, return ONLY the pre-validated IP.
        // InetAddress.getByName on a literal IP performs no DNS lookup. SNI and
        // the hostname verifier stay on the real hostname (the request URL).
        val pinnedDns = object : Dns {
          override fun lookup(hostname: String): List<InetAddress> {
            return if (hostname.equals(request.hostname, ignoreCase = true)) {
              listOf(InetAddress.getByName(request.pinnedIp))
            } else {
              Dns.SYSTEM.lookup(hostname)
            }
          }
        }

        val timeoutMs = maxOf(1000L, request.timeoutMs.toLong())
        val client = OkHttpClient.Builder()
          .dns(pinnedDns)
          .followRedirects(request.followRedirects)
          .followSslRedirects(request.followRedirects)
          .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .build()

        val builder = Request.Builder().url(request.url)
        for ((key, value) in request.headers) {
          if (!key.equals("host", ignoreCase = true)) {
            builder.header(key, value)
          }
        }

        val method = request.method.uppercase()
        if (method in METHODS_WITH_BODY) {
          val contentType = request.headers.entries
            .firstOrNull { it.key.equals("content-type", ignoreCase = true) }
            ?.value
            ?.toMediaTypeOrNull()
          builder.method(method, (request.body ?: "").toRequestBody(contentType))
        } else {
          builder.method(method, null)
        }

        client.newCall(builder.build()).execute().use { response ->
          val headersMap = HashMap<String, String>()
          for (i in 0 until response.headers.size) {
            headersMap[response.headers.name(i)] = response.headers.value(i)
          }

          // WS4: bound the body in memory. Reject early on an oversized
          // Content-Length, then buffer at most maxBytes+1 via the source so a
          // chunked/length-omitting hostile server cannot OOM the wallet (the
          // prior response.body.string() buffered the entire body unbounded).
          val maxBytes = request.maxBytes.toLong()
          val declaredLength = response.body?.contentLength() ?: -1L
          if (declaredLength in 0..Long.MAX_VALUE && declaredLength > maxBytes) {
            promise.reject("RESPONSE_TOO_LARGE", "Response Content-Length $declaredLength exceeds $maxBytes bytes", null)
            return@use
          }
          val source = response.body?.source()
          val bodyStr: String
          if (source != null) {
            source.request(maxBytes + 1)
            if (source.buffer.size > maxBytes) {
              promise.reject("RESPONSE_TOO_LARGE", "Response exceeded $maxBytes bytes", null)
              return@use
            }
            bodyStr = source.buffer.readUtf8()
          } else {
            bodyStr = ""
          }

          promise.resolve(
            mapOf(
              "status" to response.code,
              "headers" to headersMap,
              "body" to bodyStr
            )
          )
        }
      } catch (e: Exception) {
        promise.reject("PINNED_TLS_ERROR", e.message ?: "Pinned TLS fetch failed", e)
      }
    }
  }
}
